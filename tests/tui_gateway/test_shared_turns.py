"""Turn ownership in a chat several signed-in people share (``tui_gateway/shared_turns.py``).

Two WebSocket clients with different sign-ins attach to one live session through the real RPC
handlers. The person who sent a turn answers its prompts and alone stops or redirects it; anyone
else's message queues behind it instead of interrupting it; the chat's creator takes over once the
sender left. The sender card is display metadata and never reaches the model's messages.
"""

import json
import threading
import types

import pytest

from agent.message_metadata import without_persistence_fields
from hermes_state import SessionDB
from tui_gateway import server, server_requests
from tui_gateway.transport import bind_transport, reset_transport

ALICE = {"provider": "nous", "user_id": "usr_alice"}
BOB = {"provider": "nous", "user_id": "usr_bob"}


class Client:
    """A live browser window: a transport carrying the identity minted at WS upgrade."""

    def __init__(self, identity):
        self.auth_identity = identity
        self.frames, self._closed = [], False

    def write(self, frame):
        self.frames.append(frame)
        return True

    def close(self):
        self._closed = True


def _call(client, method, **params):
    token = bind_transport(client)
    try:
        return server.handle_request({"id": f"{method}-1", "method": method, "params": params})
    finally:
        reset_transport(token)


@pytest.fixture
def shared_chat(monkeypatch, tmp_path):
    """Alice creates a chat; Bob's window attaches to it. Turns never actually run a model."""
    db = SessionDB(db_path=tmp_path / "state.db")
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_schedule_agent_build", lambda _sid: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    monkeypatch.setattr(server, "_start_agent_build", lambda *a: None)
    monkeypatch.setattr(server, "_restart_completed_failed_agent_build", lambda *a: False)
    monkeypatch.setattr(server, "_run_after_agent_ready", lambda *a: None)  # the turn stays "running"
    interrupts = []
    monkeypatch.setattr(server, "_interrupt_session_turn", lambda sid, session, **kw: interrupts.append(sid))
    monkeypatch.setattr(server, "_interrupt_busy_session", lambda sid, session, agent: interrupts.append(sid))
    alice, bob = Client(ALICE), Client(BOB)
    created = _call(alice, "session.create", cols=96, source="desktop")["result"]
    sid = created["session_id"]
    session = server._sessions[sid]
    session["agent"] = types.SimpleNamespace(interrupt=lambda: None, clear_interrupt=lambda: None,
                                             steer=lambda text: True)
    session["agent_ready"].set()
    assert server._attach_session_transport(session, bob)
    server_requests.reset_for_tests()
    try:
        yield types.SimpleNamespace(db=db, sid=sid, key=created["stored_session_id"], session=session,
                                    alice=alice, bob=bob, interrupts=interrupts)
    finally:
        server_requests.reset_for_tests()
        server._sessions.pop(sid, None)
        db.close()


def _owner_id(session):
    return server._turn_owner(session)


def test_a_peer_message_queues_behind_the_running_turn_instead_of_interrupting_it(shared_chat):
    assert _call(shared_chat.alice, "prompt.submit", session_id=shared_chat.sid, text="Alice's question")["result"][
        "status"] == "streaming"
    assert _owner_id(shared_chat.session) == "nous:usr_alice"

    reply = _call(shared_chat.bob, "prompt.submit", session_id=shared_chat.sid, text="Bob's follow-up")
    assert reply["result"]["status"] == "queued"
    assert shared_chat.interrupts == []  # Alice's turn keeps running
    queued = shared_chat.session["queued_prompt"]
    assert (queued["text"], queued["sender"]) == ("Bob's follow-up", "nous:usr_bob")

    # Both rows carry who sent them; the model-bound copies carry none of it.
    rows = shared_chat.db.get_messages_as_conversation(shared_chat.key)
    senders = [(r["content"], (r.get("display_metadata") or {}).get("sender", {}).get("id")) for r in rows]
    assert senders == [("Alice's question", "nous:usr_alice"), ("Bob's follow-up", "nous:usr_bob")]
    for row in rows:
        assert "Bob" not in json.dumps(without_persistence_fields(row)).replace("Bob's follow-up", "")
        assert "display_metadata" not in without_persistence_fields(row)


def test_the_same_words_from_another_person_are_not_dropped_as_a_duplicate(shared_chat):
    _call(shared_chat.alice, "prompt.submit", session_id=shared_chat.sid, text="ship it")
    assert _call(shared_chat.bob, "prompt.submit", session_id=shared_chat.sid, text="ship it")["result"][
        "status"] == "queued"
    assert shared_chat.session["queued_prompt"]["sender"] == "nous:usr_bob"


def test_only_the_turn_owner_stops_or_redirects_it(shared_chat):
    _call(shared_chat.alice, "prompt.submit", session_id=shared_chat.sid, text="long task")

    refused = _call(shared_chat.bob, "session.interrupt", session_id=shared_chat.sid)
    assert refused["error"]["code"] == server.TURN_REFUSED_CODE
    assert refused["error"]["data"]["owner"]["id"] == "nous:usr_alice"
    assert _call(shared_chat.bob, "session.redirect", session_id=shared_chat.sid, text="do X instead")["result"][
        "status"] == "rejected"
    assert shared_chat.interrupts == []

    assert _call(shared_chat.alice, "session.interrupt", session_id=shared_chat.sid)["result"]["status"] == "interrupted"
    assert shared_chat.interrupts == [shared_chat.sid]


def test_only_the_turn_owner_answers_its_approval(shared_chat):
    _call(shared_chat.bob, "prompt.submit", session_id=shared_chat.sid, text="clean the build dir")
    answers = []
    server_requests.send_async("approval", shared_chat.sid, {"request_id": "ap-1", "command": "rm -rf build"},
                               answers.append)
    request_id = server_requests.open_requests(shared_chat.sid)[0]["id"]

    # Alice created the chat but Bob is still here: her answer, by frame or by RPC, is refused.
    server.dispatch({"jsonrpc": "2.0", "id": request_id, "result": {"choice": "once"}}, shared_chat.alice)
    assert answers == [] and server_requests.open_requests(shared_chat.sid)
    assert _call(shared_chat.alice, "request.answer", id=request_id, result={"choice": "once"})["error"][
        "code"] == server.TURN_REFUSED_CODE

    server.dispatch({"jsonrpc": "2.0", "id": request_id, "result": {"choice": "once"}}, shared_chat.bob)
    assert answers == [{"choice": "once"}]


def test_the_chat_creator_takes_over_a_turn_whose_sender_left(shared_chat):
    _call(shared_chat.bob, "prompt.submit", session_id=shared_chat.sid, text="clean the build dir")
    answers = []
    server_requests.send_async("approval", shared_chat.sid, {"request_id": "ap-2", "command": "rm -rf build"},
                               answers.append)
    request_id = server_requests.open_requests(shared_chat.sid)[0]["id"]

    server._detach_session_transport(shared_chat.session, shared_chat.bob)  # Bob closed his tab
    server.dispatch({"jsonrpc": "2.0", "id": request_id, "result": {"choice": "deny"}}, shared_chat.alice)
    assert answers == [{"choice": "deny"}]
    assert _call(shared_chat.alice, "session.interrupt", session_id=shared_chat.sid)["result"]["status"] == "interrupted"


def test_session_info_names_the_turn_owner_for_every_window(shared_chat):
    _call(shared_chat.bob, "prompt.submit", session_id=shared_chat.sid, text="hello")
    info = server._session_info(shared_chat.session["agent"], shared_chat.session)
    assert info["turn_owner"]["id"] == "nous:usr_bob" and info["turn_owner"]["color"].startswith("#")
    assert (info["chat_owner"], info["turn_control"]) == ("nous:usr_alice", "sender")


def test_turn_control_anyone_restores_the_all_equal_model(shared_chat, monkeypatch):
    monkeypatch.setattr(server, "_load_cfg", lambda: {"dashboard": {"shared_chats": {"turn_control": "anyone"}}})
    _call(shared_chat.alice, "prompt.submit", session_id=shared_chat.sid, text="long task")
    assert _call(shared_chat.bob, "session.interrupt", session_id=shared_chat.sid)["result"]["status"] == "interrupted"


def test_a_window_with_no_sign_in_keeps_full_control(shared_chat):
    """The loopback operator and the legacy session token carry no identity: nothing changes for them."""
    operator = Client(None)
    server._attach_session_transport(shared_chat.session, operator)
    _call(shared_chat.alice, "prompt.submit", session_id=shared_chat.sid, text="long task")
    assert _call(operator, "session.interrupt", session_id=shared_chat.sid)["result"]["status"] == "interrupted"


def test_message_start_echoes_the_prompt_for_windows_that_did_not_send_it(shared_chat, monkeypatch):
    """The turn's start frame carries its prompt and owner, so a peer window never sees the reply first."""
    emitted = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: emitted.append((event, payload)) or True)
    monkeypatch.setattr(server, "_start_session_work", lambda run, **kw: object())  # the turn body is not run
    _call(shared_chat.alice, "prompt.submit", session_id=shared_chat.sid, text="what changed?")
    row_id = shared_chat.session["_submit_user_row"]["_row_id"]

    assert server._run_prompt_submit("r", shared_chat.sid, shared_chat.session, "what changed?",
                                     display_metadata=server._sender_metadata("nous:usr_alice"), echo_prompt=True)
    starts = [payload for event, payload in emitted if event == "message.start"]
    assert starts[-1]["owner"]["id"] == "nous:usr_alice"
    assert starts[-1]["user"] == {"text": "what changed?", "row_id": row_id,
                                  "sender": server._sender_card("nous:usr_alice")}
    # Synthesized turns (goal follow-ups, wake-ups) do not echo a prompt nobody typed.
    assert server._prompt_echo("note", "hidden", 1, None) is None


def test_concurrent_answers_from_owner_and_peer_resolve_once_for_the_owner(shared_chat):
    _call(shared_chat.bob, "prompt.submit", session_id=shared_chat.sid, text="clean up")
    answers = []
    server_requests.send_async("approval", shared_chat.sid, {"request_id": "ap-3", "command": "rm -rf tmp"},
                               answers.append)
    request_id = server_requests.open_requests(shared_chat.sid)[0]["id"]
    threads = [threading.Thread(target=server.dispatch, args=(
        {"jsonrpc": "2.0", "id": request_id, "result": {"choice": choice}}, client))
        for client, choice in ((shared_chat.alice, "deny"), (shared_chat.bob, "once"))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    assert answers == [{"choice": "once"}]
