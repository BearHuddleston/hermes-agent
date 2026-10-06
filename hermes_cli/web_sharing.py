"""Who may open, follow and steer each chat on a shared Hermes host (Webapp, POC).

Nous Portal decides who can sign in to this agent at all. This module decides what each signed-in
person reaches once they are in:

* **Owners** (``dashboard.shared_chats.owners`` in the launch profile's config.yaml) see every chat,
  start chats and use everything the host offers, as before sharing existed.
* **Everyone else** is a *member*. A member reaches only the chats shared with them, as a ``viewer``
  (read, follow live, presence) or a ``participant`` (also send messages and answer their own turns'
  prompts). Members cannot start chats or open settings, files or terminals: whatever a participant
  makes the agent do runs on the host's tools and credentials, and the host's files hold every other
  chat, so the only safe default for a member is the chat itself.

With no owner configured, sharing is off and every signed-in person keeps full access. Claiming
ownership turns it on; it grants nothing new, since before it everyone already has full access.
The loopback operator, the legacy session token, service tokens and stdio carry no identity and are
never restricted.

Access lists and the people directory are host state in ``shared_chats.json`` beside that config. A
chat is keyed ``<profile>:<compression-root session id>``, the same key as its presence room, so
auto-compression keeps its access list.
"""

from __future__ import annotations

import contextvars
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional

from hermes_constants import get_routing_process_hermes_home, reset_hermes_home_override, set_hermes_home_override
from utils import atomic_json_write, file_signature

logger = logging.getLogger(__name__)

OWNER, PARTICIPANT, VIEWER = "owner", "participant", "viewer"
SHARE_ROLES = (VIEWER, PARTICIPANT)
#: The principal web_presence gives a socket with no sign-in.
LOCAL_PRINCIPAL = "local:operator"
STATE_FILE = "shared_chats.json"
PRINCIPAL_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._@|+-]{0,127}$")
MAX_PEOPLE = 2048
MAX_SHARES_PER_CHAT = 64
# A person's "last seen" is written at most this often (every request notes them).
_SEEN_WRITE_INTERVAL_S = 600.0


def launch_profile() -> str:
    """The profile name this process stamps on its own session rows (``_cron_default_profile``), so a chat's
    key agrees with the ``profile`` field the listings carry and the room the Webapp joins."""
    from hermes_cli.web_server_cron import _cron_default_profile
    return _cron_default_profile()


def chat_key(profile: Optional[str], root_session_id: str) -> str:
    return f"{(profile or '').strip() or launch_profile()}:{root_session_id}"


def open_store(profile: Optional[str]):
    """A read-only handle on ``profile``'s session store; this process's own store for its own profile (a custom
    ``HERMES_HOME`` has no ``profiles/<name>`` directory to resolve by name). The caller closes it."""
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    name = (profile or "").strip()
    return _open_session_db_for_profile(None if not name or name == launch_profile() else name, read_only=True)


def resolve_chat(profile: Optional[str], session_id: str) -> Optional["ChatRef"]:
    db = open_store(profile)
    try:
        return chat_of(db, profile, session_id)
    finally:
        db.close()


def principal_of(identity: Any) -> Optional[str]:
    """``<provider>:<user id>`` of a verified identity (a WS identity dict or a dashboard Session)."""
    if identity is None:
        return None
    if isinstance(identity, dict):
        provider, user_id = identity.get("provider"), identity.get("user_id")
    else:
        provider, user_id = getattr(identity, "provider", None), getattr(identity, "user_id", None)
    if not (isinstance(provider, str) and provider.strip() and isinstance(user_id, str) and user_id.strip()):
        return None
    from hermes_cli.dashboard_auth.ws_tickets import INTERNAL_PROVIDER, INTERNAL_USER_ID
    if provider == INTERNAL_PROVIDER and user_id == INTERNAL_USER_ID:
        return None
    return f"{provider.strip()}:{user_id.strip()}"


# ---- owners (config.yaml) ---------------------------------------------------------------------

def _config_path() -> Path:
    return get_routing_process_hermes_home() / "config.yaml"


def owners() -> frozenset[str]:
    """Principals listed in ``dashboard.shared_chats.owners`` of the launch profile."""
    home = get_routing_process_hermes_home()
    token = set_hermes_home_override(str(home))
    try:
        from hermes_cli.config import load_config_readonly
        config = load_config_readonly()
    except Exception:
        logger.debug("shared chats: config unreadable; treating the host as ownerless", exc_info=True)
        return frozenset()
    finally:
        reset_hermes_home_override(token)
    dashboard = config.get("dashboard") if isinstance(config, dict) else None
    shared = dashboard.get("shared_chats") if isinstance(dashboard, dict) else None
    listed = shared.get("owners") if isinstance(shared, dict) else None
    if not isinstance(listed, list):
        return frozenset()
    return frozenset(p.strip() for p in listed if isinstance(p, str) and PRINCIPAL_RE.match(p.strip()))


_claim_lock = threading.Lock()


def claim_ownership(principal: str) -> bool:
    """Make ``principal`` the first owner. False when the host already has one."""
    if not PRINCIPAL_RE.match(principal):
        raise ValueError("not a principal")
    from hermes_cli.config import atomic_config_write, read_user_config_raw
    with _claim_lock:
        if owners():
            return False
        path = _config_path()
        raw = read_user_config_raw(path)
        dashboard: dict = raw.get("dashboard") or {}
        dashboard = dashboard if isinstance(dashboard, dict) else {}
        shared: dict = dashboard.get("shared_chats") or {}
        shared = shared if isinstance(shared, dict) else {}
        raw["dashboard"] = {**dashboard, "shared_chats": {**shared, "owners": [principal]}}
        atomic_config_write(path, raw)
    logger.info("shared chats: %s claimed ownership of this host", principal)
    return True


# ---- policy -----------------------------------------------------------------------------------

def is_member(principal: Optional[str]) -> bool:
    """True for a signed-in person who is not an owner of a host that has owners."""
    if principal is None or principal == LOCAL_PRINCIPAL:
        return False
    listed = owners()
    return bool(listed) and principal not in listed


def role_in_chat(principal: Optional[str], chat: str, creator: Optional[str] = None) -> Optional[str]:
    """``owner`` / ``participant`` / ``viewer`` for ``principal`` in ``chat``; None when it is not shared with them.

    The person who created a chat owns it, so chats a member started before ownership was claimed stay theirs.
    """
    if principal is None or not is_member(principal):
        return OWNER
    if creator and creator == principal:
        return OWNER
    return STORE.members(chat).get(principal)


def may_send(role: Optional[str]) -> bool:
    return role in (OWNER, PARTICIPANT)


def visible_rows(principal: Optional[str], rows: Iterable[dict], profile: Optional[str] = None) -> list[dict]:
    """The listing rows ``principal`` may see. Rows carry ``profile`` (else ``profile``), ``id``, an optional
    ``_lineage_root_id`` (the compression root of a projected tip) and ``user_id`` (the creator)."""
    rows = list(rows)
    if principal is None or not is_member(principal):
        return rows
    shared = STORE.chats_for(principal)
    kept = []
    for row in rows:
        root = row.get("_lineage_root_id") or row.get("id")
        chat = chat_key(row.get("profile") or profile, str(root or ""))
        if chat in shared or (row.get("user_id") and row.get("user_id") == principal):
            kept.append(row)
    return kept


#: The member a dashboard request runs for (set by the HTTP gate); None for everyone unrestricted.
REQUEST_MEMBER: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("hermes_request_member", default=None)


def listing_member() -> Optional[str]:
    """The member whose session listings this request must filter, else None."""
    return REQUEST_MEMBER.get()


def visible_search_results(principal: Optional[str], results: list[dict]) -> list[dict]:
    if principal is None:
        return results
    shared = STORE.chats_for(principal)
    return [r for r in results if chat_key(r.get("profile"), str(r.get("lineage_root") or r.get("session_id") or "")) in shared]


def member_may_read_file(principal: str, path: str) -> bool:
    """A member reads a chat's app pages (``.html``) inside the working directory of a chat shared with them."""
    try:
        target = Path(path).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return False
    if target.suffix.lower() not in (".html", ".htm"):
        return False
    for chat in STORE.chats_for(principal):
        ref = chat_for_room(chat)
        if ref is None or not ref.cwd:
            continue
        try:
            if target.is_relative_to(Path(ref.cwd).expanduser().resolve()):
                return True
        except (OSError, RuntimeError, ValueError):
            continue
    return False


def may_join_room(principal: str, room: str) -> bool:
    """Presence/app rooms are chat keys: a member joins only chats shared with them (or that they created)."""
    if not is_member(principal):
        return True
    ref = chat_for_room(room)
    return ref is not None and role_in_chat(principal, ref.key, ref.creator) is not None


# ---- resolving a chat -------------------------------------------------------------------------

class ChatRef:
    """A chat as access control sees it: its key, who created it and its working directory."""

    __slots__ = ("key", "creator", "cwd")

    def __init__(self, key: str, creator: Optional[str], cwd: str) -> None:
        self.key, self.creator, self.cwd = key, creator, cwd


def chat_of(db: Any, profile: Optional[str], session_id: str) -> Optional[ChatRef]:
    """The chat a stored session id (any compression segment) belongs to in ``db``; None if unknown.

    Exact ids only: prefix and title lookups would let a member probe for chats they were not given.
    """
    if not session_id:
        return None
    row = db.get_session(session_id)
    if not row:
        return None
    lineage = db.get_compression_lineage(row["id"]) or [row["id"]]
    root = lineage[0]
    root_row = row if root == row["id"] else (db.get_session(root) or row)
    return ChatRef(chat_key(profile, root), root_row.get("user_id") or None,
                   str(row.get("cwd") or root_row.get("cwd") or ""))


_room_refs: dict[str, Optional[ChatRef]] = {}
_ROOM_REF_CACHE_MAX = 1024


def chat_for_room(room: str) -> Optional[ChatRef]:
    """``<profile>:<root session id>`` (a presence or app room) resolved against that profile's store."""
    if room in _room_refs:
        return _room_refs[room]
    profile, _, root = room.partition(":")
    try:
        ref = resolve_chat(profile, root)
    except Exception:
        logger.debug("shared chats: room %s did not resolve", room, exc_info=True)
        return None  # not cached: the store may be busy
    if ref is None or ref.key != room:
        return None  # unknown yet (a chat's row lands with its first message), or not a root: never cached
    if len(_room_refs) >= _ROOM_REF_CACHE_MAX:
        _room_refs.pop(next(iter(_room_refs)))
    _room_refs[room] = ref
    return ref


# ---- host state (shared_chats.json) -----------------------------------------------------------

class SharingStore:
    """Per-chat access lists and the directory of people who signed in, in one small JSON file.

    Writes are atomic; reads are cached on the file signature, so an edit by hand is picked up.
    """

    def __init__(self, path_fn=None) -> None:
        self._path_fn = path_fn or (lambda: get_routing_process_hermes_home() / STATE_FILE)
        self._lock = threading.RLock()
        self._cache: Optional[tuple[str, Any, dict]] = None

    def _load(self) -> dict:
        path = Path(self._path_fn())
        try:
            sig = file_signature(path.stat())
        except FileNotFoundError:
            sig = None
        cached = self._cache
        if cached is not None and cached[0] == str(path) and cached[1] == sig:
            return cached[2]
        data: dict = {}
        if sig is not None:
            from utils import read_json_or_empty
            data = read_json_or_empty(path)
        chats: dict = data.get("chats") or {}
        people: dict = data.get("people") or {}
        clean: dict[str, Any] = {
            "version": 1,
            "chats": {k: v for k, v in chats.items() if isinstance(v, dict)} if isinstance(chats, dict) else {},
            "people": ({k: v for k, v in people.items() if isinstance(v, dict) and PRINCIPAL_RE.match(k)}
                       if isinstance(people, dict) else {})}
        self._cache = (str(path), sig, clean)
        return clean

    def _save(self, data: dict) -> None:
        path = Path(self._path_fn())
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json_write(path, data, mode=0o600)
        self._cache = (str(path), file_signature(path.stat()), data)

    # reads

    def members(self, chat: str) -> dict[str, str]:
        entry = self._load()["chats"].get(chat) or {}
        people = entry.get("people") if isinstance(entry.get("people"), dict) else {}
        return {p: v["role"] for p, v in people.items()
                if isinstance(v, dict) and v.get("role") in SHARE_ROLES and PRINCIPAL_RE.match(p)}

    def chats_for(self, principal: str) -> set[str]:
        return {chat for chat, entry in self._load()["chats"].items()
                if isinstance(entry.get("people"), dict) and isinstance(entry["people"].get(principal), dict)
                and entry["people"][principal].get("role") in SHARE_ROLES}

    def name(self, principal: str) -> str:
        person = self._load()["people"].get(principal) or {}
        name = person.get("name")
        return name if isinstance(name, str) else ""

    def people(self) -> list[dict]:
        rows = []
        for principal, person in self._load()["people"].items():
            rows.append({"principal": principal, "name": person.get("name") or "",
                         "first_seen": person.get("first_seen") or 0, "last_seen": person.get("last_seen") or 0})
        rows.sort(key=lambda r: r["last_seen"], reverse=True)
        return rows

    # writes

    def set_role(self, chat: str, principal: str, role: Optional[str], *, by: Optional[str]) -> None:
        """Share ``chat`` with ``principal`` as ``role``; None removes them."""
        if not PRINCIPAL_RE.match(principal):
            raise ValueError("not a principal")
        if role is not None and role not in SHARE_ROLES:
            raise ValueError("unknown role")
        with self._lock:
            data = self._copy()
            entry = data["chats"].setdefault(chat, {"people": {}})
            people = entry.setdefault("people", {})
            if role is None:
                people.pop(principal, None)
                if not people:
                    data["chats"].pop(chat, None)
            else:
                if principal not in people and len(people) >= MAX_SHARES_PER_CHAT:
                    raise ValueError("this chat is shared with too many people")
                people[principal] = {"role": role, "by": by, "at": time.time()}
                self._note(data, principal, None)
            self._save(data)

    def note_person(self, principal: Optional[str], *, name: Optional[str] = None) -> None:
        """Record that ``principal`` signed in (and the display name they chose)."""
        if principal is None or principal == LOCAL_PRINCIPAL or not PRINCIPAL_RE.match(principal):
            return
        with self._lock:
            person = self._load()["people"].get(principal)
            now = time.time()
            stale = person is None or now - float(person.get("last_seen") or 0) > _SEEN_WRITE_INTERVAL_S
            renamed = name is not None and name != (person or {}).get("name")
            if not (stale or renamed):
                return
            data = self._copy()
            self._note(data, principal, name)
            try:
                self._save(data)
            except OSError:
                logger.warning("shared chats: could not record %s", principal, exc_info=True)

    @staticmethod
    def _note(data: dict, principal: str, name: Optional[str]) -> None:
        now = time.time()
        person: dict[str, Any] = dict(data["people"].get(principal) or {"first_seen": now})
        if name is not None:
            person["name"] = name
        person["last_seen"] = now
        data["people"][principal] = person
        while len(data["people"]) > MAX_PEOPLE:
            oldest = min(data["people"], key=lambda p: data["people"][p].get("last_seen") or 0)
            data["people"].pop(oldest)

    def _copy(self) -> dict:
        loaded = self._load()
        return {"version": 1, "chats": {k: {"people": dict((v.get("people") or {}))} for k, v in loaded["chats"].items()},
                "people": {k: dict(v) for k, v in loaded["people"].items()}}


STORE = SharingStore()
