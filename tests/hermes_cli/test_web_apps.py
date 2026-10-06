"""Live shared state for chat apps (``hermes_cli/web_apps.py``).

Values are last-writer-wins in the order the server receives sets; text follows the
``@codemirror/collab`` protocol (the server holds the document and the numbered updates, a stale push
is answered with what it missed); both persist to ``<app>.state.json``, which the agent edits with its
own file tools and open windows pick up.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from hermes_cli import web_apps


@pytest.mark.parametrize("old,new", [
    ("", "hello"), ("hello", ""), ("héllo 😀 world", "héllo 😀 brave world"), ("a\nb\nc", "a\nB\nc\nd"),
    ("same", "same"), ("😀😀", "😀x😀"),
])
def test_a_diff_applied_to_the_old_text_gives_the_new_text(old, new):
    changes = web_apps.diff_change_set(old, new)
    assert (changes is None) == (old == new)
    if changes is not None:
        assert web_apps.apply_change_set(old, changes) == new


@pytest.mark.parametrize("changes", [[3], [[100]], [1, "x"], "nope", [[1, 2]], [True]])
def test_a_change_set_that_does_not_cover_the_document_is_refused(changes):
    with pytest.raises(ValueError):
        web_apps.apply_change_set("héllo", changes)


@pytest.fixture
def app_file(tmp_path, monkeypatch):
    page = tmp_path / "board.html"
    page.write_text("<p>board</p>", encoding="utf-8")
    roles = {"nous:alice": "owner", "nous:bob": "participant", "nous:vic": "viewer"}
    monkeypatch.setattr(web_apps, "authorize_open",
                        lambda principal, profile, sid, file: ("default:s1", "nous:alice", str(page), roles[principal]))
    monkeypatch.setattr(web_apps, "SAVE_DELAY_S", 0.01)
    monkeypatch.setattr(web_apps, "WATCH_INTERVAL_S", 0.05)
    return page


async def _people(hub, *names):
    inbox, conns = {}, {}
    for name in names:
        inbox[name] = []

        async def send(text, box=inbox[name]):
            box.append(json.loads(text))

        async def close(code):
            return None

        conns[name] = hub.connect(principal=f"nous:{name}", user_key=f"nous:{name}", send=send, close=close)
        asyncio.get_running_loop().create_task(conns[name].run_sender())
        await hub.handle(conns[name], {"type": "open", "handle": "h", "session_id": "s1", "file": "board.html"})
    await asyncio.sleep(0.05)
    return conns, inbox


def test_values_are_last_writer_wins_and_viewers_only_watch(app_file):
    async def scenario():
        hub = web_apps.AppsHub()
        conns, inbox = await _people(hub, "alice", "bob", "vic")
        await hub.handle(conns["alice"], {"type": "set", "handle": "h", "key": "count", "value": 1})
        await hub.handle(conns["bob"], {"type": "set", "handle": "h", "key": "count", "value": 2})
        refused = await hub.handle(conns["vic"], {"type": "set", "handle": "h", "key": "count", "value": 9})
        await asyncio.sleep(0.1)
        for conn in conns.values():
            await hub.disconnect(conn)
        return refused, inbox

    refused, inbox = asyncio.run(scenario())
    assert refused == "read_only"
    for name in ("alice", "bob", "vic"):
        sets = [(f["value"], f["rev"]) for f in inbox[name] if f["type"] == "set"]
        assert sets == [(1, 1), (2, 2)], "every window sees the same sets in the same order"
    assert json.loads(web_apps.state_path(app_file).read_text())["values"] == {"count": 2}


def test_two_people_typing_at_once_converge_on_one_text(app_file):
    """Both push against version 0. The second is answered with the first's update and must rebase;
    the server never applies a change against a document it was not made for."""
    async def scenario():
        hub = web_apps.AppsHub()
        conns, inbox = await _people(hub, "alice", "bob")
        await hub.handle(conns["alice"], {"type": "text.push", "handle": "h", "key": "notes", "version": 0,
                                          "updates": [{"clientID": "ca", "changes": [[0, "hello"]]}]})
        await hub.handle(conns["bob"], {"type": "text.push", "handle": "h", "key": "notes", "version": 0,
                                        "updates": [{"clientID": "cb", "changes": [[0, "world"]]}]})
        await asyncio.sleep(0.05)
        missed = [f for f in inbox["bob"] if f["type"] == "text.updates"]
        # Bob rebased "world" over "hello" (insert at the end) and pushes against version 1.
        await hub.handle(conns["bob"], {"type": "text.push", "handle": "h", "key": "notes", "version": 1,
                                        "updates": [{"clientID": "cb", "changes": [5, [0, " world"]]}]})
        await asyncio.sleep(0.1)
        doc = hub.apps["default:s1|" + str(app_file)].texts["notes"].doc
        for conn in conns.values():
            await hub.disconnect(conn)
        return missed, doc, inbox

    missed, doc, inbox = asyncio.run(scenario())
    assert missed[0]["version"] == 0 and missed[0]["updates"][0]["clientID"] == "ca"
    assert doc == "hello world"
    alice_seen = [u["clientID"] for f in inbox["alice"] if f["type"] == "text.updates" for u in f["updates"]]
    assert alice_seen == ["ca", "cb"], "accepted updates reach every window in version order"
    assert json.loads(web_apps.state_path(app_file).read_text())["texts"] == {"notes": "hello world"}


def test_the_text_an_app_starts_with_is_seeded_once(app_file):
    """Two windows open a fresh app at once and both offer its starting text: it appears once."""
    async def scenario():
        hub = web_apps.AppsHub()
        conns, inbox = await _people(hub, "alice", "bob")
        for name in ("alice", "bob"):
            await hub.handle(conns[name], {"type": "text.seed", "handle": "h", "key": "notes", "text": "Agenda\n- "})
        await asyncio.sleep(0.1)
        doc = hub.apps["default:s1|" + str(app_file)].texts["notes"]
        for conn in conns.values():
            await hub.disconnect(conn)
        return (doc.doc, doc.version), inbox

    (text, version), inbox = asyncio.run(scenario())
    assert (text, version) == ("Agenda\n- ", 1)
    assert [f["version"] for f in inbox["bob"] if f["type"] == "text.updates"] == [0]


def test_an_edit_the_agent_writes_to_the_state_file_reaches_open_windows(app_file):
    async def scenario():
        hub = web_apps.AppsHub()
        conns, inbox = await _people(hub, "bob")
        await hub.handle(conns["bob"], {"type": "text.push", "handle": "h", "key": "notes", "version": 0,
                                        "updates": [{"clientID": "cb", "changes": [[0, "draft"]]}]})
        await asyncio.sleep(0.1)
        web_apps.state_path(app_file).write_text(
            json.dumps({"values": {"status": "reviewed"}, "texts": {"notes": "draft, checked by Hermes"}}))
        await asyncio.sleep(0.3)
        await hub.disconnect(conns["bob"])
        return inbox["bob"]

    frames = asyncio.run(scenario())
    by_agent = [f for f in frames if (f.get("by") or {}).get("name") == "Hermes"]
    assert [f["type"] for f in by_agent] == ["set", "text.updates"]
    assert by_agent[0]["value"] == "reviewed"
    assert web_apps.apply_change_set("draft", by_agent[1]["updates"][0]["changes"]) == "draft, checked by Hermes"
