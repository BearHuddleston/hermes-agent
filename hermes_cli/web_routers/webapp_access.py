"""Web access routes — Desktop's Web access pane drives remote Webapp access here.

Thin HTTP over :mod:`hermes_cli.webapp_access` (the CLI's ``hermes webapp setup`` uses the same
functions). Every handler runs in the requested profile's scope. The server itself is a
detached ``hermes [-p X] webapp`` child spawned like the gateway verbs, so it outlives the
Desktop session that started it; stop is in-process (the same home-scoped kill as ``--stop``).
"""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hermes_cli import webapp_access
from hermes_cli.web_deps import LateState, late
from hermes_cli.web_routers._common import config_write_scope, http_failure
from hermes_cli.web_server_profiles import _profile_cli_args

_own_profile_selector = late("_own_profile_selector", "hermes_cli.web_server_gateway")
_spawn_hermes_action = late("_spawn_hermes_action", "hermes_cli.web_server_gateway")
_ACTION_LOG_FILES = LateState("_ACTION_LOG_FILES", "hermes_cli.web_server_gateway")

router = APIRouter()

SERVER_ACTION = "webapp-access"


class AccessPlanBody(BaseModel):
    mode: str
    port: int = webapp_access.DEFAULT_PORT
    public_url: Optional[str] = None


class PasswordBody(BaseModel):
    username: str
    password: str


async def _scoped(profile: Optional[str], fn: Callable[[], Any]) -> Any:
    """Run *fn* in the profile's config-write scope off the loop; access errors become 400s."""

    def _run():
        with config_write_scope(profile):
            return fn()

    try:
        return await asyncio.to_thread(_run)
    except (webapp_access.WebappAccessError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _plan(body: AccessPlanBody) -> webapp_access.AccessPlan:
    return webapp_access.plan_access(body.mode, port=body.port, public_url=body.public_url)


def _spawn(profile: Optional[str], argv: list[str], base: str):
    """Spawn ``hermes [-p X] <argv>`` under an action name keyed by the profile it serves.

    Action records are process-global; one primary backend starts web apps for every profile,
    so a shared name would let profile B's start overwrite A's record and log.
    """
    selector = _own_profile_selector(profile)
    name = f"{base}-{re.sub(r'[^a-z0-9]+', '-', (selector or 'default').lower()).strip('-')}"
    _ACTION_LOG_FILES.setdefault(name, f"action-{name}.log")
    proc = _spawn_hermes_action(
        _profile_cli_args(selector) + argv, name,
        env_remove=webapp_access.launch_env_removals(os.environ))
    return proc, name


@router.get("/api/webapp-access/status")
async def webapp_access_status(profile: Optional[str] = None):
    return await _scoped(profile, webapp_access.access_status)


@router.post("/api/webapp-access/password")
async def set_webapp_password(body: PasswordBody, profile: Optional[str] = None):
    from hermes_cli.dashboard_auth_setup import save_basic_auth

    def _save():
        save_basic_auth(body.username, body.password)
        return webapp_access.access_status()

    return await _scoped(profile, _save)


@router.delete("/api/webapp-access/password")
async def remove_webapp_password(profile: Optional[str] = None):
    from hermes_cli.dashboard_auth_setup import clear_basic_auth

    def _clear():
        clear_basic_auth()
        return webapp_access.access_status()

    return await _scoped(profile, _clear)


@router.post("/api/webapp-access/nous")
async def set_webapp_nous_sign_in(body: AccessPlanBody, profile: Optional[str] = None):
    def _register():
        plan = _plan(body)
        webapp_access.apply_public_url(plan)
        webapp_access.register_nous_sign_in(plan)
        return webapp_access.access_status()

    return await _scoped(profile, _register)


@router.delete("/api/webapp-access/nous")
async def remove_webapp_nous_sign_in(profile: Optional[str] = None):
    def _remove():
        webapp_access.remove_nous_sign_in()
        return webapp_access.access_status()

    return await _scoped(profile, _remove)


@router.post("/api/webapp-access/start")
async def start_webapp_access(body: AccessPlanBody, profile: Optional[str] = None):
    def _prepare():
        if webapp_access.running_webapps():
            raise HTTPException(status_code=409, detail="The web app is already running. Stop it first.")
        plan = _plan(body)
        webapp_access.prepare(plan)
        return plan

    plan = await _scoped(profile, _prepare)
    with http_failure("Failed to spawn webapp", 500, "Failed to start the web app"):
        proc, name = _spawn(profile, webapp_access.launch_argv(plan), SERVER_ACTION)
    return {"ok": True, "pid": proc.pid, "name": name, "url": plan.url, "mode": plan.mode}


@router.post("/api/webapp-access/stop")
async def stop_webapp_access(profile: Optional[str] = None):
    """Stop in-process (no CLI child), so it works even when spawning ``hermes`` does not."""

    def _stop():
        if webapp_access.stop_webapps()[1]:
            raise HTTPException(status_code=500, detail="The web app is still running after the stop request.")
        return webapp_access.access_status()

    return await _scoped(profile, _stop)
