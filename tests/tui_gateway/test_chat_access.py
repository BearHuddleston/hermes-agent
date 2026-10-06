"""What a shared-chat member's window may do over JSON-RPC (``tui_gateway/chat_access.py``).

Alice owns the agent and creates a chat through the real handlers; Bob is a signed-in member. Bob reaches
the chat only once Alice shares it, can follow it as a viewer, send and answer his own turns' prompts as a
participant, and never starts chats or touches the host.
"""

import types

import pytest

from hermes_cli import web_sharing
from hermes_state import SessionDB
from tui_gateway import server, server_requests
from tui_gateway.transport import bind_transport, reset_transport

ALICE = {"provider": "nous", "user_id": "usr_alice"}
BOB = {"provider": "nous", "user_id": "usr_bob"}


class Client:
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
def chat(monkeypatch, tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    monkeypatch.setattr(server, "_get_db", lambda: db)
    for name in ("_schedule_agent_build", "_register_session_cwd"):
        monkeypatch.setattr(server, name, lambda *_a: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    monkeypatch.setattr(server, "_start_agent_build", lambda *a: None)
    monkeypatch.setattr(server, "_restart_completed_failed_agent_build", lambda *a: False)
    monkeypatch.setattr(server, "_run_after_agent_ready", lambda *a: None)
    monkeypatch.setattr(web_sharing, "owners", lambda: frozenset({"nous:usr_alice"}))
    monkeypatch.setattr(web_sharing, "STORE", web_sharing.SharingStore(lambda: tmp_path / "shared_chats.json"))
    alice, bob = Client(ALICE), Client(BOB)
    created = _call(alice, "session.create", cols=96, source="desktop")["result"]
    sid, key = created["session_id"], created["stored_session_id"]
    session = server._sessions[sid]
    session["agent"] = types.SimpleNamespace(interrupt=lambda: None, clear_interrupt=lambda: None, steer=lambda t: True)
    session["agent_ready"].set()
    _call(alice, "prompt.submit", session_id=sid, text="Plan the launch")  # the first message stores the chat
    session["running"] = False
    server_requests.reset_for_tests()
    try:
        yield types.SimpleNamespace(db=db, sid=sid, key=key, session=session, alice=alice, bob=bob,
                                    room=web_sharing.chat_key(None, key))
    finally:
        server_requests.reset_for_tests()
        server._sessions.pop(sid, None)
        db.close()


def _share(chat, role):
    web_sharing.STORE.set_role(chat.room, "nous:usr_bob", role, by="nous:usr_alice")
    chat.session.pop("_chat_ref", None)


def test_a_member_cannot_open_list_or_start_a_chat_until_it_is_shared(chat):
    assert _call(chat.bob, "session.resume", session_id=chat.key)["error"]["code"] == server.ACCESS_REFUSED_CODE
    assert _call(chat.bob, "session.history", session_id=chat.sid)["error"]["code"] == server.ACCESS_REFUSED_CODE
    assert _call(chat.bob, "session.list")["result"]["sessions"] == []
    assert _call(chat.bob, "session.active_list")["result"]["sessions"] == []
    assert _call(chat.bob, "session.create", cols=80)["error"]["code"] == server.ACCESS_REFUSED_CODE
    assert _call(chat.bob, "config.get", key="model")["error"]["code"] == server.ACCESS_REFUSED_CODE
    assert [r["id"] for r in _call(chat.alice, "session.list")["result"]["sessions"]] == [chat.key]

    _share(chat, "viewer")
    assert [r["id"] for r in _call(chat.bob, "session.list")["result"]["sessions"]] == [chat.key]
    assert "result" in _call(chat.bob, "session.history", session_id=chat.sid)


def test_a_viewer_follows_the_chat_but_cannot_send_or_answer(chat):
    _share(chat, "viewer")
    refused = _call(chat.bob, "prompt.submit", session_id=chat.sid, text="do something")
    assert refused["error"]["code"] == server.ACCESS_REFUSED_CODE
    assert _call(chat.bob, "session.interrupt", session_id=chat.sid)["error"]["code"] == server.ACCESS_REFUSED_CODE

    server._attach_session_transport(chat.session, chat.bob)
    _call(chat.alice, "prompt.submit", session_id=chat.sid, text="clean the build dir")
    answers = []
    server_requests.send_async("approval", chat.sid, {"request_id": "ap-1", "command": "rm -rf build"}, answers.append)
    request_id = server_requests.open_requests(chat.sid)[0]["id"]
    server.dispatch({"jsonrpc": "2.0", "id": request_id, "result": {"choice": "once"}}, chat.bob)
    assert answers == [] and server_requests.open_requests(chat.sid), "a viewer's answer is dropped"


def test_a_participant_sends_and_answers_their_own_turn(chat):
    _share(chat, "participant")
    server._attach_session_transport(chat.session, chat.bob)
    assert _call(chat.bob, "prompt.submit", session_id=chat.sid, text="clean the build dir")["result"]["status"] in (
        "streaming", "queued")
    answers = []
    server_requests.send_async("approval", chat.sid, {"request_id": "ap-2", "command": "rm -rf build"}, answers.append)
    request_id = server_requests.open_requests(chat.sid)[0]["id"]
    server.dispatch({"jsonrpc": "2.0", "id": request_id, "result": {"choice": "once"}}, chat.bob)
    assert answers == [{"choice": "once"}]
    assert _call(chat.bob, "session.close", session_id=chat.sid)["result"] == {"closed": False}
    assert chat.sid in server._sessions, "closing ends the chat for everyone: owners only"


def test_reopening_someone_elses_chat_keeps_its_creator(chat):
    """The creator answers a turn whose sender left; a member opening the chat cold must not become it."""
    _share(chat, "participant")
    server._sessions.pop(chat.sid, None)
    resumed = _call(chat.bob, "session.resume", session_id=chat.key, lazy=True)["result"]
    assert server._session_auth_user_id(server._sessions[resumed["session_id"]]) == "nous:usr_alice"
    server._sessions.pop(resumed["session_id"], None)


def test_host_wide_broadcasts_skip_member_windows(chat, monkeypatch):
    monkeypatch.setattr(server, "_live_transports", {chat.alice, chat.bob})
    # A reclaimed session names another chat's stored id: owners only.
    server._broadcast_global_event("session.reclaimed", {"session_id": "x1", "stored_session_id": "other-chat",
                                                         "reason": "idle_timeout"})
    server._broadcast_global_event("skin.changed", {})
    assert [f["params"]["type"] for f in chat.alice.frames if "params" in f][-2:] == ["session.reclaimed", "skin.changed"]
    assert [f["params"]["type"] for f in chat.bob.frames if "params" in f] == ["skin.changed"]
