"""Process-lifetime host shells, owned by Webapp identity and profile generation.

This is a separate capability namespace from Dashboard's client-selected chat IDs.
The existing PTY registry owns processes/drains; this module owns host admission.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
import json
from pathlib import Path
import re
import secrets
import time

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from hermes_cli.profile_incarnation import (
    ensure_profile_incarnation, profile_incarnation_lease, profile_incarnation_matches,
)
from hermes_cli.profile_lifecycle import profile_lifecycle_lease
from hermes_cli.pty_session import PtySession, PtySessionRegistry, RegistryFull, run_reaper
from hermes_constants import get_hermes_home, named_profile_home_is_unavailable

# No survival across backend restart. Disconnects retain a bounded ANSI tail.
RETENTION_SECONDS = 15 * 60
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")


class TerminalDenied(Exception):
    pass


class TerminalExpired(Exception):
    pass


@dataclass(frozen=True)
class HostOwner:
    identity: tuple[str, str]
    home: Path
    incarnation: str | None
    shell: str
    cwd: str

    def current(self) -> bool:
        return (
            self.home.is_dir()
            and not named_profile_home_is_unavailable(self.home)
            and (self.incarnation is None or profile_incarnation_matches(self.home, self.incarnation))
        )


def _request_identity(ws: WebSocket) -> tuple[str, str]:
    identity = getattr(ws, "_hermes_auth_identity", None)
    if identity:
        user, provider = identity.get("user_id"), identity.get("provider")
        if not isinstance(user, str) or not user or not isinstance(provider, str) or not provider:
            raise TerminalDenied()
        return provider, user
    from hermes_cli.web_server import app
    if getattr(app.state, "auth_required", False):
        raise TerminalDenied()
    # _ws_gate already validated the process's loopback credential.
    return "loopback", "session-token"


def _request_home(profile: str | None) -> Path:
    from hermes_cli.web_server_profiles import _resolve_profile_dir
    requested = (profile or "").strip()
    return (
        _resolve_profile_dir(requested)
        if requested and requested.lower() != "current" else get_hermes_home()
    ).resolve()


class HostTerminalRegistry(PtySessionRegistry):
    def __init__(self, *, ttl: float = RETENTION_SECONDS, max_sessions: int = 16,
                 buffer_cap: int = 1024 * 1024, read_timeout: float = 0.2):
        super().__init__(ttl=ttl, max_sessions=max_sessions, buffer_cap=buffer_cap, read_timeout=read_timeout)
        self.owners: dict[str, HostOwner] = {}
        self._closing: set[asyncio.Task] = set()

    def _reap_one_idle_or_raise(self) -> None:
        # Retention is a promise, not an LRU hint; never evict a live shell to
        # make room for a different pane, even if its viewer just disconnected.
        raise RegistryFull()

    async def create(self, ws: WebSocket, identity: tuple[str, str]):
        from hermes_cli.web_host_terminal import query_dimension
        from hermes_cli.web_server_chat import PtyBridge, _resolve_host_terminal_argv
        token = secrets.token_urlsafe(32)
        owner = None

        def spawn():
            nonlocal owner
            # Resolution, incarnation capture, config and spawn are one lease:
            # deletion/recreation cannot retarget an already-admitted request.
            with profile_lifecycle_lease():
                home = _request_home(ws.query_params.get("profile"))
                if not home.is_dir():
                    raise TerminalExpired()
                with profile_incarnation_lease(home):
                    incarnation = ensure_profile_incarnation(home)
                    argv, cwd, env, shell = _resolve_host_terminal_argv(
                        profile=ws.query_params.get("profile"),
                        requested_cwd=ws.query_params.get("cwd"))
                    env["HERMES_HOME"] = str(home)
                    bridge = PtyBridge.spawn(
                        argv, cwd=cwd, env=env,
                        cols=query_dimension(ws.query_params.get("cols"), 80, 2000),
                        rows=query_dimension(ws.query_params.get("rows"), 24, 1000))
                    owner = HostOwner(identity, home, incarnation, shell, cwd)
                    return bridge

        session, _ = await self.attach_or_spawn(token, spawn=spawn)
        assert owner is not None  # spawn completed under the incarnation lease
        self.owners[token] = owner
        if not owner.current():
            await self.remove(token)
            raise TerminalExpired()
        return session, owner

    async def resolve(self, token: str, ws: WebSocket, identity: tuple[str, str], *, closing=False):
        session = self._sessions.get(token)
        owner = self.owners.get(token)
        if session is None or owner is None:
            raise TerminalExpired()
        if owner.identity != identity:
            raise TerminalDenied()

        def validate():
            home = _request_home(ws.query_params.get("profile"))
            if home != owner.home:
                raise TerminalDenied()
            with profile_incarnation_lease(home, owner.incarnation):
                if not owner.current():
                    raise TerminalExpired()

        await asyncio.to_thread(validate)
        # No await between the final check and the caller's attach claim.
        if (self._sessions.get(token) is not session or not owner.current()
                or (not closing and (not session.alive or self.expired(session)))):
            raise TerminalExpired()
        return session, owner

    def expired(self, session, now=None):
        return (not session.attached and session.last_detached_at is not None
                and (time.monotonic() if now is None else now) - session.last_detached_at > self._ttl)

    async def remove(self, token: str):
        session = self._sessions.pop(token, None)
        self.owners.pop(token, None)
        if session is not None:
            await self._close_session(session)

    async def _close_session(self, session: PtySession):
        task = asyncio.create_task(session.close())
        self._closing.add(task)
        task.add_done_callback(self._closing.discard)
        await asyncio.shield(task)

    async def reap_idle(self, now=None):
        # Durable tombstones/incarnations also detect retirement by a different
        # process; attached viewers do not exempt retired profile generations.
        for token, owner in list(self.owners.items()):
            session = self._sessions.get(token)
            if session is not None and (not owner.current() or not session.alive or self.expired(session, now)):
                await self.remove(token)
        for token in list(self.owners):
            if token not in self._sessions:
                self.owners.pop(token, None)

    async def close_all(self):
        await super().close_all()
        if self._closing:
            await asyncio.gather(*self._closing)
        self.owners.clear()


def get_host_terminals(app) -> HostTerminalRegistry:
    if not hasattr(app.state, "host_terminals"):
        app.state.host_terminals = HostTerminalRegistry()
    return app.state.host_terminals


@asynccontextmanager
async def host_terminal_lifespan(app):
    registry = get_host_terminals(app)
    reaper = asyncio.create_task(run_reaper(registry, interval=1.0))
    try:
        yield
    finally:
        reaper.cancel()
        with suppress(asyncio.CancelledError):
            await reaper
        await registry.close_all()
        del app.state.host_terminals


def _metadata(token, owner, session, registry, *, reconnected):
    from hermes_cli.web_server_chat import _HOST_TERMINAL_META_PREFIX
    return _HOST_TERMINAL_META_PREFIX + json.dumps({
        "shell": owner.shell, "terminalId": token, "cwd": owner.cwd,
        "reconnected": reconnected, "retentionSeconds": registry._ttl,
        "truncated": session.buffer.truncated,
    }, separators=(",", ":"))


async def persistent_host_terminal(ws: WebSocket) -> None:
    """Called only after both the existing WS gate and host policy have passed."""
    from hermes_cli.web_server_chat import _HOST_TERMINAL_META_PREFIX, _RESIZE_RE
    from hermes_cli.web_routers.chat_ws import _pty_fail
    registry = get_host_terminals(ws.app)
    token = ws.query_params.get("attach")
    action = ws.query_params.get("action")
    session = None
    try:
        identity = _request_identity(ws)
        if action not in (None, "close") or (action == "close" and token is None):
            raise TerminalDenied()
        if token is not None and not TOKEN_RE.fullmatch(token):
            raise TerminalExpired()
        if action == "close" and token not in registry._sessions:
            # Missing is idempotent, but never bypass auth/host policy.
            await ws.send_text(_HOST_TERMINAL_META_PREFIX + json.dumps({"terminalId": token, "closed": True}))
            await ws.close(code=1000)
            return
        if token is None:
            session, owner = await registry.create(ws, identity)
            token = session.key
        else:
            session, owner = await registry.resolve(token, ws, identity, closing=action == "close")
        if action == "close":
            await registry.remove(token)
            await ws.send_text(_HOST_TERMINAL_META_PREFIX + json.dumps({"terminalId": token, "closed": True}))
            await ws.close(code=1000)
            return
        if not await session.attach(ws, initial_text=_metadata(
                token, owner, session, registry, reconnected=ws.query_params.get("attach") is not None)):
            if session._ws is None:
                with suppress(Exception):
                    await ws.close(code=1011, reason="Terminal replay interrupted; reconnect")
            return
        # No Ctrl-L/redraw input: arbitrary foreground shell programs own stdin.
        while session._ws is ws and session.alive:
            try:
                msg = await ws.receive()
            except RuntimeError:  # a superseding/drain task already closed us
                break
            if msg.get("type") == "websocket.disconnect":
                break
            if not owner.current():
                await registry.remove(token)
                break
            raw = msg.get("bytes")
            if raw is None:
                raw = (msg.get("text") or "").encode("utf-8")
            if not raw:
                continue
            match = _RESIZE_RE.fullmatch(raw)
            if match:
                session.resize(ws, cols=int(match[1]), rows=int(match[2]))
            elif not await session.write(ws, raw):
                if session._ws is ws:
                    await registry.remove(token)
                break
    except TerminalDenied:
        await ws.close(code=4403, reason="Terminal belongs to another identity or profile")
    except (TerminalExpired, FileNotFoundError, HTTPException):
        await ws.close(code=4410, reason="Terminal or profile expired; open a new terminal")
    except RegistryFull:
        await ws.close(code=1013, reason="Terminal capacity reached; close a terminal and retry")
    except WebSocketDisconnect:
        pass
    except (OSError, RuntimeError) as exc:
        await _pty_fail(ws, exc, surface="Terminal")
    finally:
        if session is not None:
            session.detach(ws)
