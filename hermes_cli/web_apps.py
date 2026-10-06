"""Live shared state for the apps the agent builds in a chat (``::preview{file=…}`` widgets), POC.

A widget page calls ``hermes.state`` (per-key JSON values) and ``hermes.text`` (collaboratively edited
text) and sees everyone else's pointer inside it. The page's sandboxed frame talks only to its parent
window, which relays over this module's socket (``/api/apps``): the frame never holds a credential.

* **Values** are last-writer-wins per key. This process is the only writer, so "last" is the order it
  receives sets in: each set takes the app's next revision and goes to every window, sender included.
* **Text** follows the ``@codemirror/collab`` protocol. This process holds the authoritative document and
  the numbered list of accepted change sets. A window pushes its unconfirmed changes against the version it
  has seen; a push against an older version is answered with the changes it missed, the window rebases its
  own on top and pushes again. Positions are UTF-16 code units, as in the browser.
* **Persistence** is ``<app>.state.json`` beside the app's HTML file, ``{"values": {...}, "texts": {...}}``,
  so the agent reads and edits it with its ordinary file tools. A change written there while windows are
  open reaches them within a second as a set or a text change by "Hermes". A key missing from the file is
  left alone; ``null`` deletes a value.
* **Access** comes from the chat the app belongs to (``hermes_cli/web_sharing.py``): viewers follow along
  and point, participants and owners also write.

The hub is confined to the server's event loop, like the presence hub; file and database I/O run in threads.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from hermes_cli import web_presence, web_sharing

logger = logging.getLogger(__name__)

MAX_FRAME_BYTES = 256 * 1024
MAX_STATE_BYTES = 2 * 1024 * 1024
MAX_KEYS = 256
MAX_VALUE_BYTES = 32 * 1024
MAX_TEXT_UNITS = 200_000
MAX_TEXT_KEYS = 32
MAX_HISTORY = 2000
MAX_UPDATES_PER_PUSH = 200
MAX_APPS = 256
MAX_MEMBERS_PER_APP = 32
MAX_APPS_PER_CONNECTION = 16
QUEUE_MAX = 2048
SAVE_DELAY_S = 0.3
WATCH_INTERVAL_S = 1.0
RATE_PER_S = 120.0

KEY_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$")
HANDLE_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
AGENT_PERSON = {"id": "agent", "user": "agent", "name": "Hermes", "color": "#0f766e", "role": web_sharing.OWNER}


def state_path(app_file: Path) -> Path:
    """``notes.html`` keeps its shared state in ``notes.state.json`` beside it."""
    return app_file.with_name(f"{app_file.stem}.state.json")


# ---- text changes (CodeMirror ChangeSet JSON, UTF-16 positions) --------------------------------

def _units(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def apply_change_set(doc: str, changes: Any) -> str:
    """``ChangeSet.fromJSON(changes).apply(doc)``: a number keeps that many units, ``[n]`` deletes n,
    ``[n, line, ...]`` replaces n units with the lines joined by newlines. Raises ValueError when the
    change set does not cover ``doc`` exactly, as the browser's ``apply`` does."""
    if not isinstance(changes, list):
        raise ValueError("changes must be a list")
    src = doc.encode("utf-16-le", "surrogatepass")
    out, pos = bytearray(), 0
    for part in changes:
        if isinstance(part, int) and not isinstance(part, bool):
            span = part * 2
            if part < 0 or pos + span > len(src):
                raise ValueError("retain past the end of the document")
            out += src[pos:pos + span]
            pos += span
            continue
        if (not isinstance(part, list) or not part or isinstance(part[0], bool) or not isinstance(part[0], int)
                or part[0] < 0 or not all(isinstance(line, str) for line in part[1:])):
            raise ValueError("malformed change")
        span = part[0] * 2
        if pos + span > len(src):
            raise ValueError("delete past the end of the document")
        pos += span
        if len(part) > 1:
            out += "\n".join(part[1:]).encode("utf-16-le", "surrogatepass")
    if pos != len(src):
        raise ValueError("change set does not cover the document")
    return out.decode("utf-16-le", "surrogatepass")


def diff_change_set(old: str, new: str) -> Optional[list]:
    """One replacement turning ``old`` into ``new`` (common prefix and suffix kept), as ChangeSet JSON."""
    if old == new:
        return None
    limit = min(len(old), len(new))
    start = 0
    while start < limit and old[start] == new[start]:
        start += 1
    end = 0
    while end < limit - start and old[len(old) - 1 - end] == new[len(new) - 1 - end]:
        end += 1
    removed, inserted = old[start:len(old) - end], new[start:len(new) - end]
    parts: list = []
    if start:
        parts.append(_units(old[:start]))
    parts.append([_units(removed), *inserted.split("\n")] if inserted else [_units(removed)])
    if end:
        parts.append(_units(old[len(old) - end:]))
    return parts


@dataclass
class TextDoc:
    doc: str = ""
    base: int = 0
    updates: list = field(default_factory=list)

    @property
    def version(self) -> int:
        return self.base + len(self.updates)

    def since(self, version: int) -> Optional[list]:
        """Accepted updates after ``version``; None when they are no longer kept (the window resets)."""
        if version < self.base or version > self.version:
            return None
        return self.updates[version - self.base:]

    def accept(self, doc: str, updates: list) -> int:
        start = self.version
        self.doc = doc
        self.updates.extend(updates)
        overflow = len(self.updates) - MAX_HISTORY
        if overflow > 0:
            del self.updates[:overflow]
            self.base += overflow
        return start


# ---- state file ---------------------------------------------------------------------------------

def _signature(path: Path) -> Optional[tuple]:
    from utils import file_signature
    try:
        return file_signature(path.stat())
    except FileNotFoundError:
        return None


def read_state(path: Path) -> tuple[dict, dict, Optional[tuple]]:
    """``(values, texts, signature)`` of a state file; empty when missing. Raises ValueError when unreadable."""
    sig = _signature(path)
    if sig is None:
        return {}, {}, None
    if path.stat().st_size > MAX_STATE_BYTES:
        raise ValueError(f"{path} is larger than {MAX_STATE_BYTES} bytes")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    values: Any = data.get("values")
    raw_texts: Any = data.get("texts")
    values = values if isinstance(values, dict) else {}
    raw_texts = raw_texts if isinstance(raw_texts, dict) else {}
    texts = {k: v.replace("\r\n", "\n") for k, v in raw_texts.items() if isinstance(v, str) and KEY_RE.match(k)}
    return {k: v for k, v in values.items() if KEY_RE.match(k)}, texts, sig


def write_state(path: Path, text: str) -> Optional[tuple]:
    from utils import atomic_write_text
    atomic_write_text(path, text)
    return _signature(path)


# ---- access -------------------------------------------------------------------------------------

def authorize_open(principal: Optional[str], profile: Optional[str], session_id: str, file: str):
    """``(chat key, creator, app file, role)`` for opening ``file`` in a chat, or an error code."""
    try:
        ref = web_sharing.resolve_chat(profile, session_id)
    except Exception:
        return "not_found"
    if ref is None:
        return "not_found"
    role = web_sharing.role_in_chat(principal, ref.key, ref.creator)
    if role is None:
        return "not_shared"
    try:
        target = Path(file).expanduser()
        if not target.is_absolute() and ref.cwd:
            target = Path(ref.cwd).expanduser() / target
        target = target.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return "not_found"
    if target.suffix.lower() not in (".html", ".htm") or not target.is_file():
        return "not_found"
    if web_sharing.is_member(principal):
        try:
            inside = bool(ref.cwd) and target.is_relative_to(Path(ref.cwd).expanduser().resolve())
        except (OSError, RuntimeError, ValueError):
            inside = False
        if not inside:
            return "not_shared"
    return ref.key, ref.creator, str(target), role


# ---- hub ----------------------------------------------------------------------------------------

@dataclass(eq=False)
class AppsConnection:
    """One browser window's socket; it may have several apps open (one per frame)."""

    id: str
    principal: Optional[str]
    user_key: str
    send: Callable[[str], Awaitable[None]]
    close: Callable[[int], Awaitable[None]]
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=QUEUE_MAX))
    members: dict = field(default_factory=dict)
    tokens: float = RATE_PER_S
    tokens_at: float = field(default_factory=time.monotonic)
    overflowed: bool = False

    def push(self, frame: dict) -> None:
        if self.overflowed:
            return
        try:
            self.queue.put_nowait(json.dumps(frame, ensure_ascii=False, separators=(",", ":")))
        except asyncio.QueueFull:
            # A window that cannot keep up resynchronises from a snapshot when it reconnects.
            self.overflowed = True
            logger.warning("apps socket %s fell behind; closing it", self.id)

    async def run_sender(self) -> None:
        while True:
            if self.overflowed:
                await self.close(1013)
                return
            try:
                text = await asyncio.wait_for(self.queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            await self.send(text)

    def take_token(self) -> bool:
        now = time.monotonic()
        self.tokens = min(RATE_PER_S, self.tokens + (now - self.tokens_at) * RATE_PER_S)
        self.tokens_at = now
        if self.tokens < 1.0:
            return False
        self.tokens -= 1.0
        return True


@dataclass(eq=False)
class Member:
    id: str
    conn: AppsConnection
    handle: str
    app: "App"
    role: str
    cursor: Optional[dict] = None


class App:
    def __init__(self, key: str, chat: str, creator: Optional[str], file: str) -> None:
        self.key, self.chat, self.creator, self.file = key, chat, creator, Path(file)
        self.state_file = state_path(self.file)
        self.values: dict[str, Any] = {}
        self.texts: dict[str, TextDoc] = {}
        self.rev = 0
        self.epoch = secrets.token_hex(4)
        self.members: dict[str, Member] = {}
        self.disk_sig: Optional[tuple] = None
        self.dirty = False
        self.save_task: Optional[asyncio.Task] = None
        self.watch_task: Optional[asyncio.Task] = None


def _person(user_key: str) -> dict:
    return {"user": user_key, "name": web_presence.HUB.display_name(user_key),
            "color": web_presence.user_color(user_key)}


def _peer(member: Member) -> dict:
    return {"id": member.id, **_person(member.conn.user_key), "role": member.role, "cursor": member.cursor}


def _clean_cursor(raw: Any) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    x, y = raw.get("x"), raw.get("y")
    if (isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float))
            or not isinstance(y, (int, float)) or x != x or y != y):
        return None
    return {"x": round(min(1.0, max(0.0, float(x))), 4), "y": round(min(1.0, max(0.0, float(y))), 4)}


class AppsHub:
    def __init__(self) -> None:
        self.apps: dict[str, App] = {}
        self._loading: dict[str, asyncio.Future] = {}

    # ---- lifecycle --------------------------------------------------------------------------

    def connect(self, *, principal: Optional[str], user_key: str, send, close) -> AppsConnection:
        return AppsConnection(id=secrets.token_urlsafe(9), principal=principal, user_key=user_key, send=send, close=close)

    async def disconnect(self, conn: AppsConnection) -> None:
        for member in list(conn.members.values()):
            await self._leave(member)

    async def handle(self, conn: AppsConnection, frame: Any) -> Optional[str]:
        kind = frame.get("type") if isinstance(frame, dict) else None
        handler = _HANDLERS.get(kind) if isinstance(kind, str) else None
        if handler is None:
            error = "bad_frame"
        elif not conn.take_token():
            error = None if kind == "cursor" else "rate_limited"
        else:
            error = await handler(self, conn, frame)
        if error:
            conn.push({"type": "error", "code": error, "handle": frame.get("handle") if isinstance(frame, dict) else None})
        return error

    # ---- frames -----------------------------------------------------------------------------

    async def _on_open(self, conn: AppsConnection, frame: dict) -> Optional[str]:
        handle = frame.get("handle")
        if not isinstance(handle, str) or not HANDLE_RE.match(handle):
            return "bad_handle"
        if handle in conn.members:
            await self._leave(conn.members[handle])
        if len(conn.members) >= MAX_APPS_PER_CONNECTION:
            return "too_many_apps"
        profile, session_id, file = frame.get("profile"), frame.get("session_id"), frame.get("file")
        if not (isinstance(session_id, str) and 0 < len(session_id) <= 200 and isinstance(file, str) and 0 < len(file) <= 4096):
            return "bad_frame"
        profile = profile.strip() or None if isinstance(profile, str) and len(profile) <= 64 else None
        opened = await asyncio.to_thread(authorize_open, conn.principal, profile, session_id, file)
        if isinstance(opened, str):
            return opened
        chat, creator, app_file, role = opened
        app = await self._app(f"{chat}|{app_file}", chat, creator, app_file)
        if app is None:
            return "unavailable"
        if len(app.members) >= MAX_MEMBERS_PER_APP:
            return "app_full"
        member = Member(id=secrets.token_urlsafe(9), conn=conn, handle=handle, app=app, role=role)
        app.members[member.id] = member
        conn.members[handle] = member
        conn.push({
            "type": "snapshot", "handle": handle, "epoch": app.epoch, "rev": app.rev, "values": app.values,
            "texts": {k: {"doc": t.doc, "version": t.version} for k, t in app.texts.items()},
            "role": role, "self": _peer(member),
            "peers": [_peer(m) for m in app.members.values() if m is not member]})
        self._broadcast(app, {"type": "peer", **_peer(member)}, exclude=member)
        if app.watch_task is None or app.watch_task.done():
            app.watch_task = asyncio.create_task(self._watch(app))
        return None

    async def _on_close(self, conn: AppsConnection, frame: dict) -> Optional[str]:
        member = conn.members.get(frame.get("handle"))
        if member is not None:
            await self._leave(member)
        return None

    async def _on_set(self, conn: AppsConnection, frame: dict) -> Optional[str]:
        member = conn.members.get(frame.get("handle"))
        if member is None:
            return "not_open"
        if not web_sharing.may_send(member.role):
            return "read_only"
        key, value = frame.get("key"), frame.get("value")
        if not isinstance(key, str) or not KEY_RE.match(key):
            return "bad_key"
        if len(json.dumps(value, ensure_ascii=False)) > MAX_VALUE_BYTES:
            return "too_large"
        app = member.app
        if value is not None and key not in app.values and len(app.values) >= MAX_KEYS:
            return "too_many_keys"
        self._set(app, key, value, {"id": member.id, **_person(conn.user_key)})
        return None

    async def _on_text_push(self, conn: AppsConnection, frame: dict) -> Optional[str]:
        member = conn.members.get(frame.get("handle"))
        if member is None:
            return "not_open"
        if not web_sharing.may_send(member.role):
            return "read_only"
        key, version, updates = frame.get("key"), frame.get("version"), frame.get("updates")
        if not isinstance(key, str) or not KEY_RE.match(key):
            return "bad_key"
        if isinstance(version, bool) or not isinstance(version, int) or version < 0:
            return "bad_frame"
        if (not isinstance(updates, list) or not 0 < len(updates) <= MAX_UPDATES_PER_PUSH
                or not all(isinstance(u, dict) and isinstance(u.get("clientID"), str) and CLIENT_ID_RE.match(u["clientID"])
                           and isinstance(u.get("changes"), list) for u in updates)):
            return "bad_frame"
        app = member.app
        doc = app.texts.get(key)
        if doc is None:
            if len(app.texts) >= MAX_TEXT_KEYS:
                return "too_many_keys"
            doc = TextDoc()
        if version != doc.version:
            self._send_missed(member, key, doc, version)
            return None
        text = doc.doc
        try:
            for update in updates:
                text = apply_change_set(text, update["changes"])
        except ValueError:
            self._send_reset(member, key, doc)
            return "bad_changes"
        if _units(text) > MAX_TEXT_UNITS:
            self._send_reset(member, key, doc)
            return "too_large"
        accepted = [{"clientID": u["clientID"], "changes": u["changes"]} for u in updates]
        app.texts.setdefault(key, doc)
        start = doc.accept(text, accepted)
        self._broadcast(app, {"type": "text.updates", "key": key, "version": start, "updates": accepted})
        self._schedule_save(app)
        return None

    async def _on_text_seed(self, conn: AppsConnection, frame: dict) -> Optional[str]:
        """The text an app's markup starts with, used only while nobody has written that key: two windows
        opening a fresh app both seed it, and the second seed is ignored instead of doubling the text."""
        member = conn.members.get(frame.get("handle"))
        if member is None:
            return "not_open"
        if not web_sharing.may_send(member.role):
            return "read_only"
        key, text = frame.get("key"), frame.get("text")
        if not isinstance(key, str) or not KEY_RE.match(key) or not isinstance(text, str):
            return "bad_frame"
        app = member.app
        if key in app.texts or not text:
            return None
        if len(app.texts) >= MAX_TEXT_KEYS:
            return "too_many_keys"
        text = text.replace("\r\n", "\n")
        if _units(text) > MAX_TEXT_UNITS:
            return "too_large"
        doc = app.texts.setdefault(key, TextDoc())
        update = {"clientID": "seed", "changes": [[0, *text.split("\n")]]}
        start = doc.accept(text, [update])
        self._broadcast(app, {"type": "text.updates", "key": key, "version": start, "updates": [update]})
        self._schedule_save(app)
        return None

    async def _on_text_pull(self, conn: AppsConnection, frame: dict) -> Optional[str]:
        member = conn.members.get(frame.get("handle"))
        key, version = frame.get("key"), frame.get("version")
        if member is None:
            return "not_open"
        if not isinstance(key, str) or not KEY_RE.match(key) or isinstance(version, bool) or not isinstance(version, int):
            return "bad_frame"
        self._send_missed(member, key, member.app.texts.get(key) or TextDoc(), version)
        return None

    async def _on_cursor(self, conn: AppsConnection, frame: dict) -> Optional[str]:
        member = conn.members.get(frame.get("handle"))
        if member is None:
            return None
        member.cursor = _clean_cursor(frame.get("cursor"))
        self._broadcast(member.app, {"type": "peer", **_peer(member)}, exclude=member)
        return None

    # ---- access changes (from /api/sharing) -------------------------------------------------

    def access_changed(self, principal: str, chat: str, *, removed: bool) -> None:
        for app in list(self.apps.values()):
            if app.chat != chat:
                continue
            for member in list(app.members.values()):
                if member.conn.principal != principal:
                    continue
                role = None if removed else web_sharing.role_in_chat(principal, chat, app.creator)
                if role is None:
                    member.conn.push({"type": "closed", "handle": member.handle, "reason": "access"})
                    asyncio.create_task(self._leave(member))
                else:
                    member.role = role
                    member.conn.push({"type": "role", "handle": member.handle, "role": role})
                    self._broadcast(app, {"type": "peer", **_peer(member)}, exclude=member)

    # ---- internals --------------------------------------------------------------------------

    def _broadcast(self, app: App, frame: dict, *, exclude: Optional[Member] = None) -> None:
        for member in list(app.members.values()):
            if member is not exclude:
                member.conn.push({**frame, "handle": member.handle})

    def _set(self, app: App, key: str, value: Any, by: dict) -> None:
        if value is None:
            app.values.pop(key, None)
        else:
            app.values[key] = value
        app.rev += 1
        self._broadcast(app, {"type": "set", "key": key, "value": value, "rev": app.rev, "by": by})
        self._schedule_save(app)

    def _send_missed(self, member: Member, key: str, doc: TextDoc, version: int) -> None:
        """Answer a stale push or a pull with what the window missed; ``reply`` lets it push again at once."""
        missed = doc.since(version)
        if missed is None:
            self._send_reset(member, key, doc)
        else:
            member.conn.push({"type": "text.updates", "handle": member.handle, "key": key, "version": version,
                              "updates": missed, "reply": True})

    def _send_reset(self, member: Member, key: str, doc: TextDoc) -> None:
        member.conn.push({"type": "text.reset", "handle": member.handle, "key": key, "doc": doc.doc,
                          "version": doc.version})

    async def _app(self, key: str, chat: str, creator: Optional[str], file: str) -> Optional[App]:
        if key in self.apps:
            return self.apps[key]
        if key in self._loading:
            return await asyncio.shield(self._loading[key])
        if len(self.apps) >= MAX_APPS:
            return None
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._loading[key] = future
        app = App(key, chat, creator, file)
        try:
            values, texts, sig = await asyncio.to_thread(read_state, app.state_file)
        except (OSError, ValueError) as exc:
            logger.warning("apps: starting %s empty: %s", app.state_file, exc)
            values, texts, sig = {}, {}, await asyncio.to_thread(_signature, app.state_file)
        app.values, app.disk_sig = values, sig
        app.texts = {k: TextDoc(doc=v) for k, v in texts.items()}
        self.apps[key] = app
        del self._loading[key]
        future.set_result(app)
        return app

    async def _leave(self, member: Member) -> None:
        app, conn = member.app, member.conn
        if conn.members.get(member.handle) is member:
            del conn.members[member.handle]
        if app.members.pop(member.id, None) is None:
            return
        self._broadcast(app, {"type": "peer", "id": member.id, "gone": True})
        if not app.members:
            await self._flush(app)
            if not app.members and self.apps.get(app.key) is app:
                del self.apps[app.key]
                if app.watch_task is not None:
                    app.watch_task.cancel()

    def _schedule_save(self, app: App) -> None:
        app.dirty = True
        if app.save_task is None or app.save_task.done():
            app.save_task = asyncio.create_task(self._save_later(app))

    async def _save_later(self, app: App) -> None:
        await asyncio.sleep(SAVE_DELAY_S)
        await self._flush(app)

    async def _flush(self, app: App) -> None:
        if not app.dirty:
            return
        app.dirty = False
        text = json.dumps({"values": app.values, "texts": {k: t.doc for k, t in app.texts.items()}},
                          ensure_ascii=False, indent=2) + "\n"
        try:
            app.disk_sig = await asyncio.to_thread(write_state, app.state_file, text)
        except OSError:
            logger.warning("apps: could not save %s", app.state_file, exc_info=True)

    async def _watch(self, app: App) -> None:
        """Pick up edits the agent (or anyone) writes to the state file while windows are open."""
        rejected: Optional[tuple] = None
        while app.members:
            await asyncio.sleep(WATCH_INTERVAL_S)
            if app.dirty or (app.save_task is not None and not app.save_task.done()):
                continue
            sig = await asyncio.to_thread(_signature, app.state_file)
            if sig is None or sig == app.disk_sig or sig == rejected:
                continue
            try:
                values, texts, sig = await asyncio.to_thread(read_state, app.state_file)
            except (OSError, ValueError) as exc:
                rejected = sig
                logger.info("apps: ignoring an unreadable %s: %s", app.state_file, exc)
                continue
            if app.dirty:
                continue  # a window wrote meanwhile; its save wins and the next tick compares again
            app.disk_sig = sig
            self._apply_external(app, values, texts)

    def _apply_external(self, app: App, values: dict, texts: dict) -> None:
        canon = lambda v: json.dumps(v, sort_keys=True, ensure_ascii=False)  # noqa: E731
        for key, value in values.items():
            if key not in app.values and value is None:
                continue
            if key not in app.values or canon(app.values[key]) != canon(value):
                if value is not None and key not in app.values and len(app.values) >= MAX_KEYS:
                    continue
                self._set(app, key, value, AGENT_PERSON)
        for key, new in texts.items():
            doc = app.texts.get(key)
            if doc is None:
                if len(app.texts) >= MAX_TEXT_KEYS:
                    continue
                doc = app.texts.setdefault(key, TextDoc())
            changes = diff_change_set(doc.doc, new)
            if changes is None:
                continue
            update = {"clientID": "agent", "changes": changes}
            start = doc.accept(new, [update])
            self._broadcast(app, {"type": "text.updates", "key": key, "version": start, "updates": [update],
                                  "by": AGENT_PERSON})
        app.dirty = False  # the file already holds this state


_HANDLERS: dict[str, Callable[[AppsHub, AppsConnection, dict], Awaitable[Optional[str]]]] = {
    "open": AppsHub._on_open,
    "close": AppsHub._on_close,
    "set": AppsHub._on_set,
    "text.push": AppsHub._on_text_push,
    "text.seed": AppsHub._on_text_seed,
    "text.pull": AppsHub._on_text_pull,
    "cursor": AppsHub._on_cursor,
}

#: The process's hub: one server process serves every window, so one hub sees every app.
HUB = AppsHub()
