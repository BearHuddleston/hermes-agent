"""``/api/sharing/*`` — owners, people and per-chat access lists for a shared host (POC).

See :mod:`hermes_cli.web_sharing` for the model. Anyone signed in may ask who they are and read the access
list of a chat they can open; only a chat's owner changes it, and only a host with no owner can be claimed.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from hermes_cli import web_presence, web_sharing

router = APIRouter()


class ChatAccessUpdate(BaseModel):
    session_id: str
    profile: Optional[str] = None
    principal: str
    role: Optional[str] = None  # viewer | participant; null removes them


def _caller(request: Request) -> Optional[str]:
    return web_sharing.principal_of(getattr(request.state, "session", None))


def _person(principal: str) -> dict:
    return {"principal": principal, "name": web_sharing.STORE.name(principal) or web_presence.HUB.display_name(principal),
            "label": web_presence.user_label(principal), "color": web_presence.user_color(principal)}


def _resolve(profile: Optional[str], session_id: str) -> web_sharing.ChatRef:
    ref = web_sharing.resolve_chat(profile, session_id)
    if ref is None:
        raise HTTPException(status_code=404, detail="Chat not found")
    return ref


@router.get("/api/sharing/me")
async def sharing_me(request: Request):
    principal = _caller(request)
    owners = await asyncio.to_thread(web_sharing.owners)
    return {
        "principal": principal,
        "person": _person(principal) if principal else None,
        "sharing": bool(owners),
        "owner": principal is None or not owners or principal in owners,
        "can_claim": principal is not None and not owners,
    }


@router.post("/api/sharing/claim")
async def sharing_claim(request: Request):
    principal = _caller(request)
    if principal is None:
        raise HTTPException(status_code=400, detail="Sign in to claim this agent.")
    if not await asyncio.to_thread(web_sharing.claim_ownership, principal):
        raise HTTPException(status_code=409, detail="This agent already has an owner.")
    return {"owner": True}


@router.get("/api/sharing/people")
async def sharing_people(request: Request):
    principal = _caller(request)
    if web_sharing.is_member(principal):
        raise HTTPException(status_code=403, detail="Only this agent's owners can list who signed in.")
    owners = await asyncio.to_thread(web_sharing.owners)
    people = await asyncio.to_thread(web_sharing.STORE.people)
    return {"people": [{**_person(p["principal"]), "last_seen": p["last_seen"], "owner": p["principal"] in owners}
                       for p in people]}


@router.get("/api/sharing/chat")
async def sharing_chat(request: Request, session_id: str, profile: Optional[str] = None):
    principal = _caller(request)
    ref = await asyncio.to_thread(_resolve, profile, session_id)
    role = web_sharing.role_in_chat(principal, ref.key, ref.creator)
    if role is None:
        raise HTTPException(status_code=404, detail="Chat not found")
    members = await asyncio.to_thread(web_sharing.STORE.members, ref.key)
    return {
        "chat": ref.key, "role": role, "can_share": role == web_sharing.OWNER,
        "creator": _person(ref.creator) if ref.creator else None,
        "people": [{**_person(p), "role": r} for p, r in sorted(members.items())],
    }


@router.put("/api/sharing/chat")
async def sharing_set_role(request: Request, body: ChatAccessUpdate):
    principal = _caller(request)
    ref = await asyncio.to_thread(_resolve, body.profile, body.session_id)
    if web_sharing.role_in_chat(principal, ref.key, ref.creator) != web_sharing.OWNER:
        raise HTTPException(status_code=403, detail="Only this chat's owner can change who it is shared with.")
    target = body.principal.strip()
    if not web_sharing.PRINCIPAL_RE.match(target):
        raise HTTPException(status_code=400, detail="Paste the person's account ID, e.g. nous:usr_1a2b3c.")
    if target == ref.creator:
        raise HTTPException(status_code=400, detail="That person owns this chat.")
    if body.role is not None and body.role not in web_sharing.SHARE_ROLES:
        raise HTTPException(status_code=400, detail="role must be viewer, participant or null")
    try:
        await asyncio.to_thread(web_sharing.STORE.set_role, ref.key, target, body.role, by=principal)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await asyncio.to_thread(_update_live_windows, ref.key, target, removed=body.role is None)
    # Every window of that person in this chat re-reads its role; a removed one is sent out of the room.
    web_presence.HUB.access_changed(target, ref.key, removed=body.role is None)
    from hermes_cli import web_apps
    web_apps.HUB.access_changed(target, ref.key, removed=body.role is None)
    return {"chat": ref.key, "principal": target, "role": body.role}


def _update_live_windows(chat: str, principal: str, *, removed: bool) -> None:
    """Detach a removed person from the chat, then have all their windows refetch their chat list."""
    from tui_gateway import server
    if removed:
        server._revoke_chat_member(chat, principal)
    server._refresh_chat_list(principal)
