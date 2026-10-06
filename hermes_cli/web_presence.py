"""Ephemeral co-presence for browser windows viewing the same session (POC).

Who is looking at a conversation, where their pointer is and whether they are typing. Nothing
here is persisted, replayed or sent to the agent: presence rides its own WebSocket
(``/api/presence``) so pointer traffic can never fill a session's event mailbox, and it
never enters the transcript history replayed to reconnecting windows.

Identity is the authenticated principal stamped on the socket at upgrade
(``web_server_chat._ws_auth_reason``), never a value the client sends. The display name is a
cosmetic label the user picks: Nous Portal tokens carry no name or email (contract C4).

The hub is confined to the server's event loop; every WebSocket handler runs on it, so it
needs no locks. Updates are coalesced per receiver and flushed at most every
``FLUSH_INTERVAL_S``: a burst of pointer moves costs a receiver one frame, holding only the
latest state of each peer.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import secrets
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

MAX_FRAME_BYTES = 2048
MAX_ROOMS = 512
MAX_CLIENTS_PER_ROOM = 32
FLUSH_INTERVAL_S = 0.05
TYPING_TTL_S = 6.0
NAME_MAX_CHARS = 40
MAX_KNOWN_NAMES = 1024
# Frames per second a client may send before extras are dropped (pointer moves are lossy).
RATE_LIMIT_PER_S = 60.0
LOCAL_USER_KEY = "local:operator"

# ``<profile>:<session id>``: an opaque key, but held to the shape of the ids it is built from.
_ROOM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}:[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
# Per-client control frames kept beside the peer deltas (NUL never appears in a client id).
_CONTROL_KEYS = ("\0self", "\0error")
_CURSOR_KINDS = frozenset({"turn", "viewport", "composer"})
_MAX_TURN_FROM_END = 999


# White initials and cursor labels sit on these, so each clears 4.5:1 against white.
_PALETTE = ("#2563eb", "#7c3aed", "#be185d", "#dc2626", "#c2410c", "#15803d", "#0f766e", "#4f46e5")


def user_color(user_key: str) -> str:
    """Stable color per principal so every window paints a person the same color."""
    return _PALETTE[int(hashlib.sha256(user_key.encode("utf-8")).hexdigest()[:8], 16) % len(_PALETTE)]


def user_label(user_key: str) -> str:
    """Short account hint shown beside the chosen name, e.g. ``nous …a1b2``."""
    provider, _, user_id = user_key.partition(":")
    return f"{provider} …{user_id[-4:]}" if user_id else provider


def default_name(user_key: str) -> str:
    return f"Guest {hashlib.sha256(user_key.encode('utf-8')).hexdigest()[:4]}"


def clean_name(raw: Any) -> str:
    """A printable single-line label, or "" when nothing usable remains."""
    if not isinstance(raw, str):
        return ""
    words = ("".join(ch for ch in word if unicodedata.category(ch)[0] != "C") for word in raw.split())
    return " ".join(word for word in words if word)[:NAME_MAX_CHARS]


def _unit(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number != number:  # NaN
        return None
    return min(1.0, max(0.0, number))


def clean_cursor(raw: Any) -> Optional[dict]:
    """Validate a pointer anchor; None hides the pointer.

    ``turn`` anchors count message groups from the newest (0) so two windows with different
    amounts of loaded history agree; ``x``/``y`` are fractions of that element. ``viewport``
    and ``composer`` are fractions of the thread viewport / composer box.
    """
    if not isinstance(raw, dict) or raw.get("kind") not in _CURSOR_KINDS:
        return None
    x, y = _unit(raw.get("x")), _unit(raw.get("y"))
    if x is None or y is None:
        return None
    cursor: dict[str, Any] = {"kind": raw["kind"], "x": round(x, 4), "y": round(y, 4)}
    if raw["kind"] == "turn":
        turn = raw.get("turn")
        if isinstance(turn, bool) or not isinstance(turn, int) or not 0 <= turn <= _MAX_TURN_FROM_END:
            return None
        cursor["turn"] = turn
    return cursor


@dataclass(eq=False)
class PresenceClient:
    """One browser window. ``user_key`` is server-derived; everything else is client state."""

    id: str
    user_key: str
    send: Callable[[str], Awaitable[None]]
    name: str
    color: str
    room: Optional[str] = None
    cursor: Optional[dict] = None
    typing_at: float = 0.0
    pending: dict[str, dict] = field(default_factory=dict)
    snapshot_due: bool = False
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    tokens: float = RATE_LIMIT_PER_S
    tokens_at: float = 0.0

    def public(self, now: float) -> dict:
        return {
            "id": self.id, "user": self.user_key, "label": user_label(self.user_key), "name": self.name,
            "color": self.color, "cursor": self.cursor, "typing": now - self.typing_at < TYPING_TTL_S,
        }


class PresenceHub:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._rooms: dict[str, dict[str, PresenceClient]] = {}
        self._names: dict[str, str] = {}

    # ---- lifecycle -------------------------------------------------------

    def connect(self, *, user_key: str, send: Callable[[str], Awaitable[None]]) -> PresenceClient:
        client = PresenceClient(
            id=secrets.token_urlsafe(9), user_key=user_key, send=send,
            name=self._names.get(user_key) or default_name(user_key), color=user_color(user_key),
            tokens_at=self._clock())
        self._queue_self(client)
        return client

    def disconnect(self, client: PresenceClient) -> None:
        self._leave(client)

    def room_members(self, room: str) -> list[PresenceClient]:
        return list(self._rooms.get(room, {}).values())

    # ---- inbound ---------------------------------------------------------

    def handle(self, client: PresenceClient, frame: Any) -> Optional[str]:
        """Apply one client frame. A refusal is queued to the client and returned."""
        if not self._take_token(client):
            return None  # over the rate: drop silently, pointer frames are lossy anyway
        handler = _HANDLERS.get(str(frame.get("type") or "")) if isinstance(frame, dict) else None
        error = handler(self, client, frame) if handler else "bad_frame"
        if error:
            client.pending["\0error"] = {"type": "error", "code": error}
            client.wake.set()
        return error

    def _on_name(self, client: PresenceClient, frame: dict) -> Optional[str]:
        name = clean_name(frame.get("name"))
        if not name:
            return "bad_name"
        client.name = name
        self._names.pop(client.user_key, None)
        self._names[client.user_key] = name
        while len(self._names) > MAX_KNOWN_NAMES:
            self._names.pop(next(iter(self._names)))
        # Every window of this principal shows the new name, in every room.
        for room in self._rooms.values():
            for member in room.values():
                if member.user_key == client.user_key and member is not client:
                    member.name = name
                    self._broadcast(member)
        self._broadcast(client)
        self._queue_self(client)
        return None

    def _on_join(self, client: PresenceClient, frame: dict) -> Optional[str]:
        room = frame.get("room")
        if room is not None and (not isinstance(room, str) or not _ROOM_RE.match(room)):
            return "bad_room"
        if room == client.room:
            return None
        if room is not None:
            members = self._rooms.get(room)
            if members is None and len(self._rooms) >= MAX_ROOMS:
                return "too_many_rooms"
            if members is not None and len(members) >= MAX_CLIENTS_PER_ROOM:
                return "room_full"
        self._leave(client)
        client.cursor, client.typing_at = None, 0.0
        if room is not None:
            self._rooms.setdefault(room, {})[client.id] = client
            client.room = room
            client.snapshot_due = True
            client.wake.set()
            self._broadcast(client)
        return None

    def _on_cursor(self, client: PresenceClient, frame: dict) -> Optional[str]:
        if client.room is None:
            return None
        client.cursor = clean_cursor(frame.get("cursor"))
        self._broadcast(client)
        return None

    def _on_typing(self, client: PresenceClient, frame: dict) -> Optional[str]:
        if client.room is None:
            return None
        client.typing_at = self._clock() if frame.get("typing") is True else 0.0
        self._broadcast(client)
        return None

    # ---- outbound --------------------------------------------------------

    def _broadcast(self, client: PresenceClient, *, gone: bool = False) -> None:
        if client.room is None:
            return
        state = {"id": client.id, "gone": True} if gone else client.public(self._clock())
        for peer in self._rooms.get(client.room, {}).values():
            if peer is not client:
                peer.pending[client.id] = state
                peer.wake.set()

    def _queue_self(self, client: PresenceClient) -> None:
        client.pending["\0self"] = {"type": "self", "self": client.public(self._clock())}
        client.wake.set()

    def _leave(self, client: PresenceClient) -> None:
        room = client.room
        if room is None:
            return
        self._broadcast(client, gone=True)
        members = self._rooms.get(room)
        if members is not None:
            members.pop(client.id, None)
            if not members:
                del self._rooms[room]
        client.room = None
        client.pending = {k: v for k, v in client.pending.items() if k in _CONTROL_KEYS}

    def drain(self, client: PresenceClient) -> list[dict]:
        """The frames owed to ``client`` now: control frames, a room snapshot, then coalesced deltas."""
        now = self._clock()
        frames: list[dict] = []
        pending, client.pending = client.pending, {}
        frames.extend(pending.pop(key) for key in _CONTROL_KEYS if key in pending)
        if client.snapshot_due and client.room is not None:
            client.snapshot_due = False
            peers = [m.public(now) for m in self._rooms.get(client.room, {}).values() if m is not client]
            frames.append({"type": "room", "room": client.room, "peers": peers})
        elif pending and client.room is not None:
            frames.append({"type": "peers", "room": client.room, "updates": list(pending.values())})
        return frames

    async def run_sender(self, client: PresenceClient) -> None:
        """Flush ``client``'s owed frames, at most once per ``FLUSH_INTERVAL_S``."""
        while True:
            await client.wake.wait()
            client.wake.clear()
            for frame in self.drain(client):
                await client.send(json.dumps(frame, separators=(",", ":")))
            await asyncio.sleep(FLUSH_INTERVAL_S)

    def _take_token(self, client: PresenceClient) -> bool:
        now = self._clock()
        client.tokens = min(RATE_LIMIT_PER_S, client.tokens + (now - client.tokens_at) * RATE_LIMIT_PER_S)
        client.tokens_at = now
        if client.tokens < 1.0:
            return False
        client.tokens -= 1.0
        return True


_HANDLERS: dict[str, Callable[[PresenceHub, PresenceClient, dict], Optional[str]]] = {
    "name": PresenceHub._on_name,
    "join": PresenceHub._on_join,
    "cursor": PresenceHub._on_cursor,
    "typing": PresenceHub._on_typing,
}

#: The process's hub. One server process serves every window, so one hub sees every room.
HUB = PresenceHub()


def principal_key(identity: Any) -> str:
    """``<provider>:<user_id>`` for an authenticated socket; the loopback operator otherwise."""
    if isinstance(identity, dict):
        provider, user_id = identity.get("provider"), identity.get("user_id")
        if isinstance(provider, str) and provider.strip() and isinstance(user_id, str) and user_id.strip():
            return f"{provider.strip()}:{user_id.strip()}"
    return LOCAL_USER_KEY
