"""Co-presence hub (POC): who is in a chat, where they point, whether they type.

Contracts, not snapshots: identity comes from the authenticated socket and never from a frame;
peers in one room see each other and nobody else; a burst of pointer moves reaches a receiver as
one coalesced update; and the ``/api/presence`` socket shares the dashboard's pre-accept gate.
Nothing here touches the transcript or the prompt the model sees.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from hermes_cli import web_presence
from hermes_cli.web_presence import PresenceHub, principal_key


class _Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def _hub() -> tuple[PresenceHub, _Clock]:
    clock = _Clock()
    return PresenceHub(clock=clock), clock


async def _noop_send(_text: str) -> None:
    return None


def _join(hub: PresenceHub, user_key: str, room: str | None):
    client = hub.connect(user_key=user_key, send=_noop_send)
    assert hub.handle(client, {"type": "join", "room": room}) is None
    hub.drain(client)  # discard the self frame + initial snapshot
    return client


def _peer_updates(hub: PresenceHub, client) -> dict[str, dict]:
    updates: dict[str, dict] = {}
    for frame in hub.drain(client):
        if frame["type"] == "peers":
            updates.update({u["id"]: u for u in frame["updates"]})
        if frame["type"] == "room":
            updates.update({u["id"]: u for u in frame["peers"]})
    return updates


def test_peers_in_one_room_see_each_other_and_other_rooms_see_nothing():
    hub, _ = _hub()
    alice = _join(hub, "nous:alice", "default:s1")
    bob = _join(hub, "nous:bob", "default:s1")
    carol = _join(hub, "nous:carol", "default:s2")

    hub.handle(bob, {"type": "cursor", "cursor": {"kind": "turn", "turn": 0, "x": 0.25, "y": 0.5}})

    seen_by_alice = _peer_updates(hub, alice)
    assert seen_by_alice[bob.id]["user"] == "nous:bob"
    assert seen_by_alice[bob.id]["cursor"] == {"kind": "turn", "turn": 0, "x": 0.25, "y": 0.5}
    assert _peer_updates(hub, carol) == {}, "a different chat must not see this room"


def test_a_frame_can_never_choose_the_principal():
    hub, _ = _hub()
    alice = _join(hub, "nous:alice", "default:s1")
    mallory = _join(hub, "nous:mallory", "default:s1")

    hub.handle(mallory, {"type": "cursor", "user": "nous:alice", "id": alice.id,
                         "cursor": {"kind": "viewport", "x": 0.1, "y": 0.1}})
    hub.handle(mallory, {"type": "name", "name": "Alice", "user": "nous:alice"})

    updates = _peer_updates(hub, alice)
    assert set(updates) == {mallory.id}
    # The label is cosmetic and self-chosen; the principal beside it is the socket's, never a frame field.
    assert updates[mallory.id]["name"] == "Alice"
    assert updates[mallory.id]["user"] == "nous:mallory"
    assert updates[mallory.id]["label"].startswith("nous …")
    assert alice.cursor is None


def test_a_burst_of_pointer_moves_reaches_a_receiver_as_one_latest_update():
    hub, _ = _hub()
    alice = _join(hub, "nous:alice", "default:s1")
    bob = _join(hub, "nous:bob", "default:s1")

    for step in range(20):
        hub.handle(bob, {"type": "cursor", "cursor": {"kind": "viewport", "x": step / 20, "y": 0.5}})

    frames = hub.drain(alice)
    assert len(frames) == 1 and frames[0]["type"] == "peers"
    assert [u["cursor"]["x"] for u in frames[0]["updates"]] == [0.95]


def test_leaving_or_switching_rooms_tells_the_old_room_the_peer_is_gone():
    hub, _ = _hub()
    alice = _join(hub, "nous:alice", "default:s1")
    bob = _join(hub, "nous:bob", "default:s1")

    hub.handle(bob, {"type": "join", "room": "default:s2"})
    assert _peer_updates(hub, alice)[bob.id] == {"id": bob.id, "gone": True}

    hub.handle(bob, {"type": "join", "room": "default:s1"})
    _peer_updates(hub, alice)
    hub.disconnect(bob)
    assert _peer_updates(hub, alice)[bob.id] == {"id": bob.id, "gone": True}
    assert [m.id for m in hub.room_members("default:s1")] == [alice.id]


def test_typing_expires_without_a_stop_frame():
    hub, clock = _hub()
    alice = _join(hub, "nous:alice", "default:s1")
    bob = _join(hub, "nous:bob", "default:s1")

    hub.handle(bob, {"type": "typing", "typing": True})
    assert _peer_updates(hub, alice)[bob.id]["typing"] is True

    clock.now += web_presence.TYPING_TTL_S + 1
    late = hub.connect(user_key="nous:carol", send=_noop_send)
    hub.handle(late, {"type": "join", "room": "default:s1"})
    snapshot = _peer_updates(hub, late)
    assert snapshot[bob.id]["typing"] is False, "a window that vanished mid-word must not type forever"


def test_a_chosen_name_follows_the_principal_into_every_window():
    hub, _ = _hub()
    alice = _join(hub, "nous:alice", "default:s1")
    bob_one = _join(hub, "nous:bob", "default:s1")
    bob_two = _join(hub, "nous:bob", "default:s2")

    assert hub.handle(bob_one, {"type": "name", "name": "  Bob\u0007 the\nbuilder "}) is None
    assert bob_one.name == bob_two.name == "Bob the builder"
    assert _peer_updates(hub, alice)[bob_one.id]["name"] == "Bob the builder"
    later = hub.connect(user_key="nous:bob", send=_noop_send)
    assert later.name == "Bob the builder"


@pytest.mark.parametrize("frame", [
    {"type": "join", "room": "../../etc"},
    {"type": "cursor", "cursor": {"kind": "turn", "turn": -1, "x": 0, "y": 0}},
    {"type": "name", "name": "\u200b\u0000"},
    {"type": "nope"},
    ["not", "a", "dict"],
])
def test_malformed_frames_change_nothing_peers_can_see(frame):
    hub, _ = _hub()
    alice = _join(hub, "nous:alice", "default:s1")
    bob = _join(hub, "nous:bob", "default:s1")

    hub.handle(bob, frame)

    updates = _peer_updates(hub, alice)
    assert all(u.get("cursor") is None for u in updates.values())
    assert [m.id for m in hub.room_members("default:s1")] == [alice.id, bob.id]


def test_principal_key_is_the_authenticated_identity_or_the_loopback_operator():
    assert principal_key({"provider": "nous", "user_id": "usr_1"}) == "nous:usr_1"
    assert principal_key({"provider": "nous", "user_id": ""}) == web_presence.LOCAL_USER_KEY
    assert principal_key(None) == web_presence.LOCAL_USER_KEY


def test_presence_socket_is_gated_like_every_other_dashboard_socket():
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from hermes_cli import web_server
    from hermes_cli.dashboard_auth.ws_tickets import _reset_for_tests, mint_ticket

    _reset_for_tests()
    keys = ("auth_required", "bound_host", "trusted_public_hosts")
    prev = {k: getattr(web_server.app.state, k, None) for k in keys}
    web_server.app.state.auth_required = True
    web_server.app.state.bound_host = "testserver"
    web_server.app.state.trusted_public_hosts = frozenset()
    client = TestClient(web_server.app)
    try:
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect("/api/presence") as conn:
                conn.receive_text()
        assert refused.value.code == 4401

        def frames_until(conn, pred):
            while True:
                frame = json.loads(conn.receive_text())
                if pred(frame):
                    return frame

        alice_ticket = mint_ticket(user_id="usr_alice", provider="nous")
        bob_ticket = mint_ticket(user_id="usr_bob", provider="nous")
        with client.websocket_connect(f"/api/presence?ticket={alice_ticket}") as alice:
            hello = json.loads(alice.receive_text())
            assert hello["type"] == "self"
            assert hello["self"]["user"] == "nous:usr_alice", "the ticket's principal, stamped server-side"
            alice.send_text(json.dumps({"type": "join", "room": "default:s1"}))
            frames_until(alice, lambda f: f["type"] == "room")

            with client.websocket_connect(f"/api/presence?ticket={bob_ticket}") as bob:
                bob_id = json.loads(bob.receive_text())["self"]["id"]
                bob.send_text(json.dumps({"type": "join", "room": "default:s1"}))
                bob.send_text(json.dumps({"type": "typing", "typing": True}))
                seen = frames_until(alice, lambda f: f["type"] == "peers" and any(
                    u.get("typing") for u in f["updates"]))
                assert [u["user"] for u in seen["updates"]] == ["nous:usr_bob"]

            gone = frames_until(alice, lambda f: f["type"] == "peers" and any(u.get("gone") for u in f["updates"]))
            assert gone["updates"] == [{"id": bob_id, "gone": True}], "closing a window leaves the room"
    finally:
        client.close()
        _reset_for_tests()
        for k, v in prev.items():
            setattr(web_server.app.state, k, v)


def test_the_sender_loop_flushes_coalesced_frames_to_the_socket():
    async def scenario() -> list[dict]:
        hub, _ = _hub()
        sent: list[dict] = []

        async def capture(text: str) -> None:
            sent.append(json.loads(text))

        alice = hub.connect(user_key="nous:alice", send=capture)
        bob = _join(hub, "nous:bob", "default:s1")
        task = asyncio.create_task(hub.run_sender(alice))
        hub.handle(alice, {"type": "join", "room": "default:s1"})
        hub.handle(bob, {"type": "typing", "typing": True})
        await asyncio.sleep(web_presence.FLUSH_INTERVAL_S * 4)
        task.cancel()
        return sent

    frames = asyncio.run(scenario())
    kinds = [f["type"] for f in frames]
    assert kinds[0] == "self" and "room" in kinds
    typing_states = [u["typing"] for f in frames if f["type"] in {"room", "peers"}
                     for u in (f.get("peers") or f.get("updates"))]
    assert typing_states[-1] is True
