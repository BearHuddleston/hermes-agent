"""One-use child-window handoff for the private, loopback Webapp session."""
from __future__ import annotations

import json
import secrets
import threading
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

from hermes_cli.dashboard_auth.request_utils import _http_origin

router = APIRouter()
WINDOW_TICKET_TTL_SECONDS = 30
_MAX_WINDOW_TICKETS = 128
_ticket_lock = threading.Lock()


def _require_private_webapp(request: Request) -> None:
    if (getattr(request.app.state, "ui_surface", None) != "webapp"
            or getattr(request.app.state, "auth_required", False)):
        raise HTTPException(404, "Private Webapp window handoff is unavailable")


@router.post("/api/webapp/window-ticket")
async def issue_window_ticket(request: Request):
    from hermes_cli.web_server import _SESSION_TOKEN, _require_token

    _require_private_webapp(request)
    _require_token(request)
    now = time.monotonic()
    with _ticket_lock:
        tickets = getattr(request.app.state, "webapp_window_tickets", {})
        tickets = {key: value for key, value in tickets.items()
                   if value[0] > now and value[1] == _SESSION_TOKEN}
        request.app.state.webapp_window_tickets = tickets
        if len(tickets) >= _MAX_WINDOW_TICKETS:
            raise HTTPException(429, "Too many pending Webapp windows; try again shortly")
        ticket = secrets.token_urlsafe(32)
        tickets[ticket] = (now + WINDOW_TICKET_TTL_SECONDS, _SESSION_TOKEN)
    return JSONResponse({"ticket": ticket}, headers={"Cache-Control": "no-store"})


@router.post("/webapp/window-session")
async def redeem_window_ticket(request: Request):
    from hermes_cli.web_server import _SESSION_TOKEN

    _require_private_webapp(request)
    # This endpoint deliberately sits outside /api: the child has no session
    # yet. Only this purpose-specific ticket can exchange for the existing one.
    # Private links use the actual bind origin, which may differ from a
    # configured loopback public_url. Host validation remains in middleware;
    # proxy-normalized ASGI scheme/Host (not raw forwarded headers) are trusted.
    origins = request.headers.getlist("origin")
    origin = _http_origin(origins[0]) if len(origins) == 1 else None
    target_origin = _http_origin(f"{request.url.scheme}://{request.url.netloc}")
    if origin is None or origin != target_origin:
        raise HTTPException(403, "Webapp window handoff requires a same-origin request")
    # Keep the unauthenticated exchange body-free; never parse an arbitrary
    # JSON/multipart payload just to extract a fixed-size capability.
    ticket = request.headers.get("X-Hermes-Window-Ticket", "")
    with _ticket_lock:
        entry = getattr(request.app.state, "webapp_window_tickets", {}).pop(ticket, None)
    if entry is None or entry[0] <= time.monotonic() or entry[1] != _SESSION_TOKEN:
        raise HTTPException(403, "Webapp window link expired or was already used; open a new window")
    return JSONResponse({"token": _SESSION_TOKEN}, headers={"Cache-Control": "no-store"})


@router.get("/webapp/window")
async def child_window_page(request: Request):
    from hermes_cli.web_server_dashboard import _normalise_prefix

    _require_private_webapp(request)
    prefix = _normalise_prefix(request.headers.get("x-forwarded-prefix"))
    nonce = secrets.token_urlsafe(16)
    # No credential appears in this public page or in its URL. The fragment
    # names a transient channel; the authorized parent mints a one-use ticket.
    script = r"""
const basePath = __BASE_PATH__;
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
const id = params.get('channel') || '';
const status = document.getElementById('status');
if (!/^[a-f0-9-]{36}$/.test(id)) {
  status.textContent = 'Open this window from an authorized Hermes Webapp tab.';
} else {
  const channel = new BroadcastChannel(`hermes.webapp.window:${id}`);
  let receiving = false;
  let finished = false;
  const controller = new AbortController();
  const fail = message => {
    if (finished) return;
    finished = true;
    controller.abort();
    status.textContent = message;
    channel.postMessage({type: 'error'});
    channel.close();
    clearTimeout(timeout);
  };
  const timeout = setTimeout(() => fail('This window link expired. Open a new window from the original tab.'), 30000);
  channel.onmessage = async event => {
    if (receiving) return;
    if (event.data?.error) { fail(event.data.error); return; }
    const ticket = event.data?.ticket;
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return;
    receiving = true;
    try {
      const response = await fetch(`${basePath}/webapp/window-session`, {
        method: 'POST', credentials: 'same-origin',
        headers: {'X-Hermes-Window-Ticket': ticket}, signal: controller.signal
      });
      if (!response.ok) throw new Error('Window authorization expired. Open a new window from the original tab.');
      const {token} = await response.json();
      if (finished) return;
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid window authorization.');
      sessionStorage.setItem(`hermes.webapp.session.v1:${JSON.stringify([location.origin, basePath])}`, token);
      const target = new URL(`${basePath}/`, location.origin);
      target.search = params.get('query') || '';
      target.hash = params.get('route') || '/';
      channel.postMessage({type: 'done'});
      finished = true;
      clearTimeout(timeout);
      channel.close();
      location.replace(target.href);
    } catch (error) { fail(error.message || 'Could not authorize this window. Open it again from the original tab.'); }
  };
  channel.postMessage({type: 'ready'});
}
""".replace("__BASE_PATH__", json.dumps(prefix).replace("</", "<\\/"))
    return HTMLResponse(
        '<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
        '<title>Opening Hermes</title><p id="status">Authorizing this Hermes window…</p>'
        f'<script nonce="{nonce}">{script}</script>',
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": f"default-src 'none'; script-src 'nonce-{nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        },
    )
