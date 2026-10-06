"""``/api/apps`` — live shared state for the apps the agent builds in a chat (POC).

A sibling of ``/api/presence``: same pre-accept gate, its own connection, so app traffic never shares the
session event mailbox. The principal comes from the upgrade credential; each ``open`` names the chat and the
app file, and the hub checks that chat's access list. See :mod:`hermes_cli.web_apps`.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, WebSocket

from hermes_cli import web_apps, web_presence, web_sharing
from hermes_cli.web_server_chat import _ws_gate

router = APIRouter()

_CLOSE_TOO_BIG = 1009


def _retrieve(task: asyncio.Task) -> None:
    if not task.cancelled():
        task.exception()


@router.websocket("/api/apps")
async def apps_ws(ws: WebSocket) -> None:
    if await _ws_gate(ws, "apps") is None:
        return
    await ws.accept()
    identity = getattr(ws, "_hermes_auth_identity", None)

    async def close(code: int) -> None:
        await ws.close(code=code)

    hub = web_apps.HUB
    conn = hub.connect(principal=web_sharing.principal_of(identity), user_key=web_presence.principal_key(identity),
                       send=ws.send_text, close=close)
    sender = asyncio.create_task(conn.run_sender())
    sender.add_done_callback(_retrieve)
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                return
            text = message.get("text")
            if text is None:
                continue
            if len(text.encode("utf-8")) > web_apps.MAX_FRAME_BYTES:
                await ws.close(code=_CLOSE_TOO_BIG)
                return
            try:
                frame = json.loads(text)
            except ValueError:
                frame = None
            await hub.handle(conn, frame)
    finally:
        sender.cancel()
        await hub.disconnect(conn)
