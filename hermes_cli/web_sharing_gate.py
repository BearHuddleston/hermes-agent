"""HTTP side of shared-chat access (``hermes_cli/web_sharing.py``): what a member's requests reach.

Runs after the dashboard auth gate, so ``request.state.session`` is the verified sign-in. Owners,
an ownerless host and every request without a sign-in pass straight through. A member gets the
routes a chat window needs: their own sign-in, the session lists (filtered to chats shared with
them), those chats' transcripts, and the app pages inside those chats' working directories.
Everything else, settings, files, cron, terminals and the rest of the host, answers 403.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import parse_qs

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from hermes_cli import web_sharing

_OWNERS_ONLY = "Only this agent's owners can do that."
_NOT_SHARED = "This chat has not been shared with you."

# Routes a member's window reads that reveal nothing about other chats or the host's secrets.
_MEMBER_OPEN = frozenset({
    "/api/status", "/api/health", "/api/config/defaults", "/api/model/info", "/api/profiles", "/api/profiles/active"})
_LISTINGS = frozenset({"/api/profiles/sessions/sidebar", "/api/profiles/sessions", "/api/sessions"})
_CHAT_DETAIL = re.compile(r"^/api/sessions/(?P<sid>[A-Za-z0-9][A-Za-z0-9._-]{0,199})(?:/(?:messages|messages/around|timeline|latest-descendant))?$")
# The parts of /api/config a chat window renders (language, theme, model label).
_MEMBER_CONFIG_KEYS = ("display", "model", "model_context_length")
# Host facts every window reads at boot. A member gets an empty answer rather than a refusal (which the
# window would surface as an error) or the host's own paths, backends and versions.
_MEMBER_EMPTY_READS = {
    "/api/fs/default-cwd": {"cwd": "", "branch": ""},
    "/api/tools/terminal/backends": {"active": "", "backends": []},
    # The host's repositories are the owners': to a member's window the chat's folder is not a repo.
    "/api/git/status": None,
    "/api/git/review/rev-parse": {"sha": None},
    "/api/hermes/update/check": {"install_method": "unknown", "current_version": "", "behind": None,
                                 "update_available": False, "can_apply": False, "update_command": "", "message": None},
    # Speech runs on the host's provider credentials, so it is the owners' (audio.py refuses the socket too).
    "/api/audio/voice-live/status": {"ok": True, "mode": "chained", "available": False, "reason": _OWNERS_ONLY,
                                     "model": "", "voice": ""},
}


def _principal(request: Request) -> Optional[str]:
    return web_sharing.principal_of(getattr(request.state, "session", None))


def _deny(detail: str, status: int = 403) -> Response:
    return JSONResponse(status_code=status, content={"detail": detail})


async def _json_body(response: Response) -> Any:
    body = b"".join([chunk async for chunk in response.body_iterator])  # type: ignore[attr-defined]
    return json.loads(body or b"null")


def _rewrite(response: Response, payload: Any) -> Response:
    headers = {k: v for k, v in response.headers.items() if k.lower() not in ("content-length", "content-type")}
    return JSONResponse(status_code=response.status_code, content=payload, headers=headers)


def _filter_listing(path: str, payload: Any, principal: str, profile: Optional[str]) -> Any:
    if not isinstance(payload, dict):
        return payload
    if path == "/api/profiles/sessions/sidebar":
        recents = payload.get("recents")
        if isinstance(recents, dict) and isinstance(recents.get("sessions"), list):
            recents["sessions"] = web_sharing.visible_rows(principal, recents["sessions"])
            recents.pop("profiles_usage", None)  # usage totals cover every chat on the host
        for key in ("cron", "messaging"):
            if isinstance(payload.get(key), dict):
                payload[key]["sessions"] = []
                if "total" in payload[key]:
                    payload[key]["total"] = 0
        return payload
    if isinstance(payload.get("sessions"), list):
        payload["sessions"] = web_sharing.visible_rows(principal, payload["sessions"], profile)
        payload["total"] = len(payload["sessions"])
        payload.pop("profile_totals", None)
    return payload


_WIDE = {"/api/profiles/sessions/sidebar": ("recents_limit", 500), "/api/profiles/sessions": ("limit", 500),
         "/api/sessions": ("limit", 100)}


def _int(values: list[str] | None, default: int) -> int:
    try:
        return int((values or [""])[0])
    except ValueError:
        return default


def _widen_listing_query(request: Request, path: str, query: dict) -> tuple[int, int]:
    """Rewrite the listing request to its widest page from the top; return the ``(offset, limit)`` asked for."""
    from urllib.parse import urlencode
    key, widest = _WIDE[path]
    asked = (_int(query.get("offset"), 0), _int(query.get(key), 20))
    wide = {**{k: v[0] for k, v in query.items()}, key: str(widest)}
    if "offset" in wide:
        wide["offset"] = "0"
    request.scope["query_string"] = urlencode(wide).encode("latin-1")
    return asked


def _cut_page(path: str, payload: Any, page: tuple[int, int]) -> Any:
    offset, limit = page
    if not isinstance(payload, dict):
        return payload
    holder = payload.get("recents") if path == "/api/profiles/sessions/sidebar" else payload
    if isinstance(holder, dict) and isinstance(holder.get("sessions"), list):
        holder["sessions"] = holder["sessions"][offset:offset + max(limit, 0)]
        if path == "/api/profiles/sessions/sidebar":
            holder["profiles_truncated"] = {}
    return payload


def _chat_access(principal: str, profile: Optional[str], session_id: str) -> Optional[str]:
    ref = web_sharing.resolve_chat(profile, session_id)
    return None if ref is None else web_sharing.role_in_chat(principal, ref.key, ref.creator)


async def shared_chat_gate(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    path = request.url.path
    principal = _principal(request)
    if principal is None or not path.startswith("/api/"):
        return await call_next(request)
    if path == "/api/auth/ws-ticket":
        # Every window mints a ticket per socket: the moment to record who signed in to this agent.
        await asyncio.to_thread(web_sharing.STORE.note_person, principal)
    if not web_sharing.is_member(principal):
        return await call_next(request)
    if path.startswith(("/api/auth/", "/api/sharing/")) or path in _MEMBER_OPEN:
        return await call_next(request)
    if request.method not in ("GET", "HEAD"):
        return _deny(_OWNERS_ONLY)
    if path in _MEMBER_EMPTY_READS:
        return JSONResponse(_MEMBER_EMPTY_READS[path])
    query = parse_qs(request.url.query)
    profile = (query.get("profile") or [""])[0].strip() or None
    token = web_sharing.REQUEST_MEMBER.set(principal)
    try:
        if path in _LISTINGS:
            # Filter a full window, then cut the page the caller asked for: their chats may sit below
            # the host's most recent ones.
            page = _widen_listing_query(request, path, query)
            response = await call_next(request)
            if response.status_code != 200:
                return response
            payload = _filter_listing(path, await _json_body(response), principal, profile)
            return _rewrite(response, _cut_page(path, payload, page))
        if path == "/api/sessions/search":
            response = await call_next(request)
            if response.status_code != 200:
                return response
            payload = await _json_body(response)
            if isinstance(payload, dict) and isinstance(payload.get("results"), list):
                payload["results"] = web_sharing.visible_search_results(principal, payload["results"])
            return _rewrite(response, payload)
        if path == "/api/config":
            response = await call_next(request)
            if response.status_code != 200:
                return response
            payload = await _json_body(response)
            return _rewrite(response, {k: payload[k] for k in _MEMBER_CONFIG_KEYS if isinstance(payload, dict) and k in payload})
        if path == "/api/cron/jobs":
            return JSONResponse([])
        if (match := _CHAT_DETAIL.match(path)) is not None:
            role = await asyncio.to_thread(_chat_access, principal, profile, match.group("sid"))
            return await call_next(request) if role is not None else _deny(_NOT_SHARED, 404)
        if path == "/api/fs/read-text":
            target = (query.get("path") or [""])[0]
            if target and await asyncio.to_thread(web_sharing.member_may_read_file, principal, target):
                return await call_next(request)
            return _deny(_NOT_SHARED)
        return _deny(_OWNERS_ONLY)
    finally:
        web_sharing.REQUEST_MEMBER.reset(token)


def ws_member(ws: Any) -> Optional[str]:
    """The member behind an accepted-credential WebSocket, else None (owners, ownerless, no sign-in)."""
    principal = web_sharing.principal_of(getattr(ws, "_hermes_auth_identity", None))
    return principal if principal is not None and web_sharing.is_member(principal) else None
