"""``/api/presence`` — who else is looking at a session (POC).

A sibling socket beside ``/api/ws``: same pre-accept gate (credential, Host/Origin, peer), its own
connection so pointer traffic never shares the session event mailbox. The principal comes from the
upgrade credential; frames only carry a display name, the room (``<profile>:<session>``), a pointer
anchor and a typing flag. See :mod:`hermes_cli.web_presence`.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, WebSocket

from hermes_cli import web_presence, web_sharing
from hermes_cli.web_server_chat import _ws_gate
from hermes_cli.web_sharing_gate import ws_member

router = APIRouter()

_CLOSE_TOO_BIG = 1009


def _retrieve(task: asyncio.Task) -> None:
    # A flush racing the peer's close fails; the receive loop sees that close and ends the socket.
    if not task.cancelled():
        task.exception()


@router.websocket("/api/presence")
async def presence_ws(ws: WebSocket) -> None:
    if await _ws_gate(ws, "presence") is None:
        return
    await ws.accept()
    hub = web_presence.HUB
    # A shared-chat member joins only the rooms of chats shared with them (web_sharing.may_join_room).
    member = ws_member(ws)
    principal = web_sharing.principal_of(getattr(ws, "_hermes_auth_identity", None))
    client = hub.connect(
        user_key=web_presence.principal_key(getattr(ws, "_hermes_auth_identity", None)), send=ws.send_text)
    sender = asyncio.create_task(hub.run_sender(client))
    sender.add_done_callback(_retrieve)
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                return
            text = message.get("text")
            if text is None:
                continue  # binary frames carry nothing here
            if len(text.encode("utf-8")) > web_presence.MAX_FRAME_BYTES:
                await ws.close(code=_CLOSE_TOO_BIG)
                return
            try:
                frame = json.loads(text)
            except ValueError:
                frame = None
            if member is not None and isinstance(frame, dict) and frame.get("type") == "join" \
                    and isinstance(frame.get("room"), str) and frame["room"] != client.room \
                    and not await asyncio.to_thread(web_sharing.may_join_room, member, frame["room"]):
                hub.refuse(client, "not_shared")
                continue
            hub.handle(client, frame)
            if principal is not None and isinstance(frame, dict) and frame.get("type") == "name":
                # The people directory shows owners the name each person picked for themselves.
                await asyncio.to_thread(web_sharing.STORE.note_person, principal, name=client.name)
    finally:
        # Nothing awaited past the peer's departure: the room hears "gone" in the same tick.
        sender.cancel()
        hub.disconnect(client)
