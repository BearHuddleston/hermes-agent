"""Shared-chat access over HTTP (``hermes_cli/web_sharing.py`` + ``web_sharing_gate.py``).

Real dashboard app, real sign-in gate (stub identity provider), real session store in the test's
``HERMES_HOME``. Alice claims the agent; Bob is a member who reaches only what Alice shares with him.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server, web_sharing
from hermes_cli.dashboard_auth import clear_providers, register_provider
from hermes_cli.dashboard_auth.cookies import SESSION_AT_COOKIE, SESSION_PROVIDER_COOKIE
from hermes_constants import get_hermes_home
from hermes_state import SessionDB
from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider, _sign

ALICE, BOB = "stub:usr_alice", "stub:usr_bob"


def _client(user_id: str) -> TestClient:
    # A browser sends its Origin on every write; cookie-authenticated writes without one are refused.
    client = TestClient(web_server.app, base_url="https://agent.example.test",
                        headers={"Origin": "https://agent.example.test"})
    token = _sign({"sub": user_id, "email": "", "name": "", "org_id": "", "exp": int(time.time()) + 3600})
    client.cookies.set(SESSION_AT_COOKIE, token)
    client.cookies.set(SESSION_PROVIDER_COOKIE, "stub")
    return client


@pytest.fixture
def host(monkeypatch, tmp_path):
    """A gated agent with two chats: Alice's plan and Alice's private notes."""
    clear_providers()
    register_provider(StubAuthProvider())
    for key, value in (("bound_host", "agent.example.test"), ("bound_port", 443), ("auth_required", True),
                       ("trusted_public_hosts", frozenset())):
        monkeypatch.setattr(web_server.app.state, key, value, raising=False)
    db = SessionDB(db_path=get_hermes_home() / "state.db")
    for sid, text in (("20261006_090000_plan01", "Plan the launch"), ("20261006_090100_note01", "Private notes")):
        db.create_session(sid, "desktop", user_id=ALICE, cwd=str(tmp_path))
        db.append_message(sid, "user", text)
    db.close()
    (tmp_path / "board.html").write_text("<p>board</p>", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("not an app", encoding="utf-8")
    yield tmp_path
    clear_providers()


def _listed(client: TestClient) -> set[str]:
    response = client.get("/api/sessions", params={"limit": 20})
    assert response.status_code == 200
    return {row["id"] for row in response.json()["sessions"]}


def test_an_ownerless_agent_keeps_every_signed_in_person_unrestricted(host):
    bob = _client("usr_bob")
    assert _listed(bob) == {"20261006_090000_plan01", "20261006_090100_note01"}
    assert bob.get("/api/sharing/me").json() | {"person": None} == {
        "principal": BOB, "person": None, "sharing": False, "owner": True, "can_claim": True}


def test_a_member_reaches_only_the_chats_shared_with_them(host):
    alice, bob = _client("usr_alice"), _client("usr_bob")
    assert alice.post("/api/sharing/claim").status_code == 200
    assert bob.post("/api/sharing/claim").status_code == 409, "a host is claimed once"

    assert _listed(bob) == set()
    assert bob.get("/api/sessions/20261006_090000_plan01/messages").status_code == 404
    assert bob.get("/api/sessions/20261006_090000_plan01/messages").json()["detail"] == "This chat has not been shared with you."

    shared = alice.put("/api/sharing/chat", json={"session_id": "20261006_090000_plan01", "principal": BOB,
                                                  "role": "viewer"})
    assert shared.status_code == 200, shared.text
    assert _listed(bob) == {"20261006_090000_plan01"}
    assert [m["content"] for m in bob.get("/api/sessions/20261006_090000_plan01/messages").json()["messages"]] == [
        "Plan the launch"]
    assert bob.get("/api/sessions/20261006_090100_note01/messages").status_code == 404
    assert _listed(alice) == {"20261006_090000_plan01", "20261006_090100_note01"}, "owners keep everything"

    # The rest of the host stays the owners': settings, env, files outside the chat's apps, writes.
    assert bob.get("/api/env").status_code == 403
    assert bob.put("/api/config", json={"config": {}}).status_code == 403
    assert bob.get("/api/fs/read-text", params={"path": str(host / "secret.txt")}).status_code == 403
    assert bob.get("/api/fs/read-text", params={"path": str(host / "board.html")}).status_code == 200
    assert set(bob.get("/api/config").json()) <= {"display", "model", "model_context_length"}
    # Host facts a window reads at boot come back empty for him, never as the host's own.
    assert bob.get("/api/fs/default-cwd").json() == {"cwd": "", "branch": ""}
    assert alice.get("/api/fs/default-cwd").json()["cwd"] != ""

    # Removing him takes the chat back.
    alice.put("/api/sharing/chat", json={"session_id": "20261006_090000_plan01", "principal": BOB, "role": None})
    assert _listed(bob) == set()


def test_only_the_chat_owner_changes_who_it_is_shared_with(host):
    alice, bob = _client("usr_alice"), _client("usr_bob")
    alice.post("/api/sharing/claim")
    alice.put("/api/sharing/chat", json={"session_id": "20261006_090000_plan01", "principal": BOB,
                                         "role": "participant"})

    view = bob.get("/api/sharing/chat", params={"session_id": "20261006_090000_plan01"}).json()
    assert (view["role"], view["can_share"]) == ("participant", False)
    assert [p["principal"] for p in view["people"]] == [BOB]
    denied = bob.put("/api/sharing/chat", json={"session_id": "20261006_090000_plan01", "principal": "stub:usr_eve",
                                                "role": "participant"})
    assert denied.status_code == 403
    assert bob.get("/api/sharing/people").status_code == 403
    assert {p["principal"] for p in alice.get("/api/sharing/people").json()["people"]} >= {BOB}


def test_sharing_or_taking_back_a_chat_refreshes_that_persons_chat_list(host, monkeypatch):
    """Members never get the host-wide ``sessions.changed`` (it would reveal activity in other chats), so the
    change itself must tell their open windows to refetch, or the chat reaches their sidebar only on a reload."""
    from tui_gateway import server

    class Window:
        def __init__(self, user_id):
            self.auth_identity, self.frames = {"provider": "stub", "user_id": user_id}, []

        def write(self, frame):
            self.frames.append(frame)
            return True

    bobs, eves = Window("usr_bob"), Window("usr_eve")
    monkeypatch.setattr(server, "_live_transports", {bobs, eves})
    refreshes = lambda window: [f["params"]["type"] for f in window.frames].count("sessions.changed")  # noqa: E731
    alice = _client("usr_alice")
    alice.post("/api/sharing/claim")

    alice.put("/api/sharing/chat", json={"session_id": "20261006_090000_plan01", "principal": BOB, "role": "viewer"})
    assert (refreshes(bobs), refreshes(eves)) == (1, 0)
    alice.put("/api/sharing/chat", json={"session_id": "20261006_090000_plan01", "principal": BOB, "role": None})
    assert (refreshes(bobs), refreshes(eves)) == (2, 0)


def test_the_room_of_a_chat_admits_a_member_only_once_it_is_shared(host):
    _client("usr_alice").post("/api/sharing/claim")
    room = web_sharing.chat_key(None, "20261006_090000_plan01")
    assert not web_sharing.may_join_room(BOB, room)
    web_sharing.STORE.set_role(room, BOB, "viewer", by=ALICE)
    assert web_sharing.may_join_room(BOB, room)
    assert web_sharing.may_join_room(ALICE, room)
    assert not web_sharing.may_join_room(BOB, web_sharing.chat_key(None, "20261006_090100_note01"))
