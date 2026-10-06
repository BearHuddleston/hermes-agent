"""Who may steer a turn in a chat several signed-in people share (Webapp).

The person who sent a turn owns it: only they answer its approval, clarify, sudo, secret and vault
prompts, and only they stop or redirect it. The chat's creator may act too once the sender has left
(no socket of theirs is attached), so a turn never strands on someone who closed the tab. Anyone
else's message while the turn runs is queued behind it, never steered into it.

Only authenticated principals are gated. The loopback operator, the legacy session token and stdio
carry no identity and keep full control, and a chat used by one person never sees a difference.
``dashboard.shared_chats.turn_control: anyone`` restores the all-equal model of SECURITY.md §2
rule 4. The sender card on a message is display metadata: it is stripped from every provider-bound
copy (``agent/message_metadata.py::PERSISTENCE_ONLY_MESSAGE_FIELDS``) and never reaches the model.
"""

from __future__ import annotations

from typing import Any

from .method_ctx import bind_module

TURN_CONTROL_SENDER = "sender"
TURN_CONTROL_ANYONE = "anyone"
TURN_REFUSED_CODE = 4125
# Server→client requests a person answers. Window-owned reads (preview, terminal, tour) stay
# answerable by whichever window shows the pane.
HUMAN_PROMPTS = frozenset({
    "approval", "clarify", "sudo", "secret", "vault.unlock_prompt", "vault.save_login", "vault.code"})


def _turn_control_mode() -> str:
    dashboard = _load_cfg().get("dashboard")
    shared = dashboard.get("shared_chats") if isinstance(dashboard, dict) else None
    value = str((shared or {}).get("turn_control") or "").strip().lower() if isinstance(shared, dict) else ""
    return TURN_CONTROL_ANYONE if value == TURN_CONTROL_ANYONE else TURN_CONTROL_SENDER


def _sender_card(principal: str) -> dict:
    from hermes_cli.web_presence import sender_card
    return sender_card(principal)


def _sender_metadata(principal: str | None) -> dict | None:
    """``display_metadata`` naming who sent a message, or None for a sender with no sign-in."""
    return {"sender": _sender_card(principal)} if principal else None


def _turn_owner(session: dict) -> str | None:
    """Principal who sent the running turn, read off the in-flight turn's sender card (stamped at submit
    or queue drain, gone when the turn ends). None when idle or when nobody signed in sent it."""
    turn = session.get("inflight_turn") if session.get("running") else None
    meta = turn.get("display_metadata") if isinstance(turn, dict) else None
    sender = meta.get("sender") if isinstance(meta, dict) else None
    owner = sender.get("id") if isinstance(sender, dict) else None
    return owner if isinstance(owner, str) and owner else None


def _attached_principals(session: dict) -> set[str]:
    return {p for t in _session_live_transports(session) if (p := _transport_auth_user_id(t))}


def _may_act_on_turn(session: dict, transport: Any) -> bool:
    principal = _transport_auth_user_id(transport)
    if principal is None or not session.get("running") or _turn_control_mode() == TURN_CONTROL_ANYONE:
        return True
    owner, creator = _turn_owner(session), _session_auth_user_id(session)
    if principal == owner:
        return True
    if principal == creator:
        return owner is None or owner not in _attached_principals(session)
    return owner is None and creator is None


def _turn_refusal(rid: Any, session: dict) -> dict:
    holder = _turn_owner(session) or _session_auth_user_id(session)
    name = _sender_card(holder)["name"] if holder else "the person who started it"
    return _err(rid, TURN_REFUSED_CODE,
                f"This turn belongs to {name}: only they can answer its prompts, stop it or redirect it.",
                {"owner": _sender_card(holder) if holder else None})


def _shared_turn_info(session: dict) -> dict:
    """``session.info`` fields a window needs to decide whether it may act on the running turn."""
    owner = _turn_owner(session)
    return {"turn_owner": _sender_card(owner) if owner else None,
            "chat_owner": _session_auth_user_id(session), "turn_control": _turn_control_mode()}


def _windows_share_session(session: dict) -> bool:
    """More than one window is attached, so some window did not send the prompt it is about to see answered."""
    return len(_session_live_transports(session)) > 1


def _message_start_payload(display_metadata: dict | None, prompt_echo: dict | None) -> dict | None:
    """``message.start`` carries who owns the turn and, for a typed prompt, the prompt itself, so a
    window that did not send it can show it before the reply instead of after a transcript refresh.
    Built from the turn's own metadata so an isolated compute-host child emits the same frame."""
    payload: dict = {}
    if isinstance(sender := (display_metadata or {}).get("sender"), dict):
        payload["owner"] = sender
    if prompt_echo:
        payload["user"] = prompt_echo
    return payload or None


def _prompt_echo(text: Any, display_kind: str | None, row_id: Any, display_metadata: dict | None) -> dict | None:
    """The typed prompt a turn answers, for windows that did not send it. None for hidden/synthesized input."""
    if display_kind or not isinstance(text, str) or not text.strip():
        return None
    sender = (display_metadata or {}).get("sender")
    return {"text": text, "row_id": row_id if isinstance(row_id, int) else None,
            **({"sender": sender} if isinstance(sender, dict) else {})}


def _request_route(request_id: str) -> tuple[str, str, dict] | None:
    """``(sid, method, frame)`` of an open server→client request, here or in a compute-host child."""
    from tui_gateway import server_requests
    if (route := server_requests.request_route(request_id)) is not None:
        return route
    if (located := _compute_host_request_session(request_id)) is None:
        return None
    sid, session = located
    mirrored = dict(session.get("_compute_host_open_request") or {})
    return sid, str(mirrored.get("method") or ""), {"jsonrpc": "2.0", **mirrored}


def _refuses_prompt_answer(request_id: str, transport: Any) -> dict | None:
    """The session whose person-answered request ``transport`` may not answer, else None."""
    route = _request_route(request_id) if request_id else None
    if route is None or route[1] not in HUMAN_PROMPTS:
        return None
    session = _sessions.get(route[0])
    if session is None:
        return None
    return session if not (_may_act_on_turn(session, transport) and _member_may_send(session, transport)) else None


def _shared_turn_refuses_response(frame: dict, transport: Any) -> bool:
    """True when ``frame`` answers a person-answered prompt of a turn this socket's user does not own:
    the frame is dropped and the request stays open for its owner."""
    from tui_gateway import server_requests
    if server_requests.is_not_shown(frame):
        return False  # a decline is not an answer
    request_id = str(frame.get("id") or "")
    if _refuses_prompt_answer(request_id, transport) is None:
        return False
    logger.info("shared chat: dropped an answer to %s from a user who does not own the turn", request_id)
    return True


def register(server) -> None:
    bind_module(globals(), server)
