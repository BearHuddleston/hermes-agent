"""Which JSON-RPC calls a signed-in *member* of a shared host may make (``hermes_cli/web_sharing.py``).

Owners, the loopback operator, the legacy token and stdio are never restricted: for them every call
goes straight to its handler. A member reaches only chats shared with them: chat reads as a viewer,
chat writes as a participant, a handful of calls that touch neither a chat nor a host resource, and
nothing else. Listing calls are filtered instead of refused, so the sidebar shows exactly the chats
shared with them. Turn ownership (``shared_turns.py``) still decides who steers a running turn.
"""

from __future__ import annotations

from typing import Any, Callable

from .method_ctx import bind_module

ACCESS_REFUSED_CODE = 4126

# A member's window needs these; none touches a chat or a host resource.
_MEMBER_FREE = frozenset({
    "gateway.ping", "ping", "client.capabilities", "gateway.capabilities", "groups.capabilities",
    "commands.catalog", "setup.status", "setup.runtime_check", "free_tier.status", "shared_metrics.status",
    "pet.info", "profiles.list", "model.options", "wake.status"})
# Reads on a live chat the member can see (``session_id`` is the runtime id).
_CHAT_READ = frozenset({
    "session.activate", "session.events.since", "session.history", "session.status", "session.usage",
    "session.context_breakdown", "session.control.read", "approval.pending", "subagent.list", "subagent.tail"})
# Writes a participant may also make on that chat.
_CHAT_SEND = frozenset({
    "prompt.submit", "session.interrupt", "session.steer", "session.redirect", "approval.respond",
    "image.attach_bytes", "image.detach", "message.react"})
# Answers to an open prompt, addressed by the request id rather than the session.
_PROMPT_ANSWERS = frozenset({"request.answer", "clarify.lock"})


def _sharing():
    from hermes_cli import web_sharing
    return web_sharing


def _member_principal(transport: Any) -> str | None:
    """The signed-in principal behind ``transport`` when the host restricts them, else None."""
    principal = _transport_auth_user_id(transport)
    return principal if principal is not None and _sharing().is_member(principal) else None


def _live_chat_ref(session: dict):
    """The stored chat a live session belongs to, cached on the record per stored key."""
    key = str(session.get("session_key") or "")
    cached = session.get("_chat_ref")
    if isinstance(cached, tuple) and cached[0] == key:
        return cached[1]
    home = session.get("profile_home")
    profile = profile_name_for_home(home) if home else None
    ref = None
    with _session_db(session) as db:
        if db is not None and key:
            ref = _sharing().chat_of(db, profile, key)
    if ref is not None:  # a chat's row lands with its first message: an unknown chat is asked again
        session["_chat_ref"] = (key, ref)
    return ref


def _member_role(session: dict | None, principal: str) -> str | None:
    if session is None:
        return None
    ref = _live_chat_ref(session)
    if ref is None:
        return None
    # The STORED creator only: the live record's login is whoever opened the chat in this process.
    return _sharing().role_in_chat(principal, ref.key, ref.creator)


def _member_may_send(session: dict | None, transport: Any) -> bool:
    principal = _member_principal(transport)
    return principal is None or _sharing().may_send(_member_role(session, principal))


def _refused(rid: Any, message: str) -> dict:
    return _err(rid, ACCESS_REFUSED_CODE, message)


def _resume_refusal(rid: Any, params: dict, principal: str) -> dict | None:
    """``session.resume`` names a STORED id: a member may only open a chat shared with them, by exact id."""
    target = str(params.get("session_id") or "").strip()
    with _profile_db(params) as db:
        ref = _sharing().chat_of(db, params.get("profile"), target) if db is not None else None
    if ref is None or _sharing().role_in_chat(principal, ref.key, ref.creator) is None:
        return _refused(rid, "This chat has not been shared with you.")
    return None


def _filter_stored_listing(params: dict, response: dict, principal: str) -> dict:
    rows = (response.get("result") or {}).get("sessions")
    if not isinstance(rows, list):
        return response
    kept = []
    with _profile_db(params) as db:
        for row in rows:
            ref = _sharing().chat_of(db, params.get("profile"), str(row.get("id") or "")) if db is not None else None
            if ref is not None and _sharing().role_in_chat(principal, ref.key, ref.creator) is not None:
                kept.append(row)
    return {**response, "result": {**response["result"], "sessions": kept}}


def _filter_live_listing(response: dict, principal: str) -> dict:
    rows = (response.get("result") or {}).get("sessions")
    if not isinstance(rows, list):
        return response
    kept = [row for row in rows if _member_role(_sessions.get(str(row.get("id") or "")), principal) is not None]
    return {**response, "result": {**response["result"], "sessions": kept}}


def _call_with_chat_access(rid: Any, method: str, params: dict, fn: Callable[[Any, dict], dict | None]):
    """Run ``fn`` for this RPC unless the caller is a member it is not open to."""
    principal = _member_principal(current_transport())
    if principal is None or method in _MEMBER_FREE:
        return fn(rid, params)
    if method == "session.resume":
        return _resume_refusal(rid, params, principal) or fn(rid, params)
    if method == "session.list":
        response = fn(rid, params)
        return _filter_stored_listing(params, response, principal) if isinstance(response, dict) else response
    if method == "session.most_recent":
        # Answer "nothing to continue" rather than another person's latest chat.
        response = fn(rid, params)
        result = response.get("result") if isinstance(response, dict) else None
        if isinstance(result, dict) and result.get("session_id"):
            listing = {"result": {"sessions": [{"id": result["session_id"]}]}}
            if not _filter_stored_listing(params, listing, principal)["result"]["sessions"]:
                return _ok(rid, {"session_id": None})
        return response
    if method == "session.active_list":
        response = fn(rid, params)
        return _filter_live_listing(response, principal) if isinstance(response, dict) else response
    if method == "session.close":
        return _ok(rid, {"closed": False})  # closing tears the chat down for everyone: owners only
    if method in _PROMPT_ANSWERS:
        route = _request_route(str(params.get("request_id") or params.get("id") or ""))
        if route is not None and not _sharing().may_send(_member_role(_sessions.get(route[0]), principal)):
            return _refused(rid, "You can view this chat but not answer its prompts.")
        return fn(rid, params)
    is_read = method in _CHAT_READ or (method == "session.title" and "title" not in params)
    if is_read or method in _CHAT_SEND:
        role = _member_role(_sessions.get(str(params.get("session_id") or "")), principal)
        if role is None:
            return _refused(rid, "This chat has not been shared with you.")
        if not is_read and not _sharing().may_send(role):
            return _refused(rid, "You can view this chat. Ask its owner to let you send messages.")
        return fn(rid, params)
    if method == "session.create":
        return _refused(rid, "Only this agent's owners can start chats. Open one that was shared with you.")
    return _refused(rid, "Only this agent's owners can do that.")


def _global_event_reaches(transport: Any, event: str) -> bool:
    """Host-wide broadcasts (connector accounts, reclaimed sessions, display state) skip members' windows;
    only appearance changes reach them."""
    return event in _MEMBER_GLOBAL_EVENTS or _member_principal(transport) is None


_MEMBER_GLOBAL_EVENTS = frozenset({"skin.changed"})


def _refresh_chat_list(principal: str) -> int:
    """Have ``principal``'s open windows refetch their chat list. The host-wide ``sessions.changed`` skips
    members, so a chat shared with them (or taken back) would reach their sidebar only on a reload."""
    frame = _event_frame("sessions.changed", "", {})
    with _live_transports_lock:
        targets = [t for t in _live_transports if _transport_auth_user_id(t) == principal]
    for transport in targets:
        try:
            transport.write(frame)
        except Exception:  # a wedged window must not fail the owner's change; disconnect teardown drops it
            logger.debug("chat-list refresh write failed for %s", principal, exc_info=True)
    return len(targets)


def _revoke_chat_member(chat: str, principal: str) -> int:
    """Detach ``principal``'s windows from every live session of ``chat``; returns how many were detached."""
    detached = 0
    with _sessions_lock:
        live = list(_sessions.values())
    for session in live:
        ref = _live_chat_ref(session)
        if ref is None or ref.key != chat:
            continue
        for transport in _session_live_transports(session):
            if _transport_auth_user_id(transport) == principal:
                _detach_session_transport(session, transport)
                detached += 1
    return detached


def register(server) -> None:
    bind_module(globals(), server)
