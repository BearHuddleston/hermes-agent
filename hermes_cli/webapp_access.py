"""Remote access to the browser-hosted Webapp: plan, configure, launch and report.

One owner for "make ``hermes webapp`` reachable from other devices, behind a login", shared by
``hermes webapp setup`` and Desktop's Web access pane. Two shapes:

- ``lan`` — bind ``0.0.0.0`` and open ``http://<this machine's LAN address>:<port>``. No
  ``public_url`` is pinned: the server rebuilds its OAuth callback from each request, and the
  portal is told the LAN callback explicitly.
- ``public`` — the operator already has an HTTPS URL (reverse proxy, Tailscale Serve, a tunnel)
  that forwards to ``127.0.0.1:<port>``. ``HERMES_DASHBOARD_PUBLIC_URL`` is pinned to it, which
  both engages the auth gate on the loopback bind and fixes the OAuth callback.

The login itself is the dashboard's: Nous OAuth (a self-hosted portal client) or the bundled
username/password provider. Nothing here can turn the gate off; ``start_server`` still refuses
to bind without a provider.
"""

from __future__ import annotations

import socket
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit

DEFAULT_PORT = 9119
MODES = ("lan", "public")
_LAN_BIND = "0.0.0.0"
_LOOPBACK_BIND = "127.0.0.1"
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
_PUBLIC_URL_ENV = "HERMES_DASHBOARD_PUBLIC_URL"
_CLIENT_ID_ENV = "HERMES_DASHBOARD_OAUTH_CLIENT_ID"


class WebappAccessError(RuntimeError):
    """Remote access cannot be set up as asked; ``str(exc)`` is the user-facing reason."""


@dataclass(frozen=True)
class AccessPlan:
    mode: str
    port: int
    bind_host: str
    url: str  # what the user opens
    callback_url: str  # registered with the portal for Nous sign-in
    public_url: str  # pinned HERMES_DASHBOARD_PUBLIC_URL ("" for lan)


def lan_address() -> Optional[str]:
    """This machine's primary LAN IPv4 address, or None when it has none.

    Connecting a UDP socket only asks the kernel which interface would route to a
    non-local address; no packet is sent, so this works offline on a LAN too.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))
            address = probe.getsockname()[0]
    except OSError:
        return None
    return None if address.startswith("127.") or address == "0.0.0.0" else address


def normalize_public_url(raw: str) -> str:
    """``https://host[:port][/prefix]`` without a trailing slash, or WebappAccessError."""
    value = (raw or "").strip().rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise WebappAccessError("The public URL must start with https:// and name a host.")
    if parsed.hostname in _LOOPBACK_HOSTS:
        raise WebappAccessError("The public URL must be the address other devices use, not localhost.")
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise WebappAccessError("The public URL cannot carry credentials, a query or a fragment.")
    return value


def plan_access(mode: str, *, port: int = DEFAULT_PORT, public_url: Optional[str] = None) -> AccessPlan:
    """Resolve *mode* into the bind, the URL to open and the OAuth callback."""
    if mode not in MODES:
        raise WebappAccessError(f"Unknown access mode {mode!r}; expected one of {', '.join(MODES)}.")
    if not 1 <= int(port) <= 65535:
        raise WebappAccessError("The port must be between 1 and 65535.")
    if mode == "lan":
        address = lan_address()
        if address is None:
            raise WebappAccessError("This machine has no network address other devices can reach.")
        url = f"http://{address}:{port}"
        return AccessPlan(mode, port, _LAN_BIND, url, f"{url}/auth/callback", "")
    url = normalize_public_url(public_url or "")
    return AccessPlan(mode, port, _LOOPBACK_BIND, url, f"{url}/auth/callback", url)


def launch_argv(plan: AccessPlan) -> list[str]:
    """``hermes`` argv that serves *plan*; host and port stay on argv so ``--status`` reads them."""
    return ["webapp", "--host", plan.bind_host, "--port", str(plan.port), "--no-open"]


def launch_env_removals(environ) -> list[str]:
    """Keys a launched Webapp must NOT inherit from the process that starts it.

    ``HERMES_DESKTOP=1`` plus the Desktop's per-spawn session token would mark the child as a
    Desktop-owned loopback backend, which ignores ``public_url`` and serves WITHOUT the auth gate
    (``web_server._desktop_loopback_auth_exempt``). Every other ``HERMES_DASHBOARD_*`` key goes too:
    the dotenv loader never overrides an inherited value, so a stale public URL or client id from
    the launching process would beat the profile's own ``.env``.
    """
    return [
        key for key in environ
        if key.startswith("HERMES_DASHBOARD_")
        or key in {"HERMES_DESKTOP", "HERMES_WEB_DIST", "HERMES_SERVE_HEADLESS"}
    ]


def _env(key: str) -> str:
    """The profile's ``.env`` value only — what a launched Webapp reads.

    Never the process environment: a long-lived backend keeps the copy it loaded at start, and
    the launch strips every ``HERMES_DASHBOARD_*`` key, so the file is the one truth.
    """
    from hermes_cli.config import load_env

    return str(load_env().get(key) or "").strip()


def _dashboard_section() -> dict:
    from hermes_cli.config import load_config

    section = load_config().get("dashboard")
    return section if isinstance(section, dict) else {}


def sign_in_methods() -> dict:
    """Configured logins for this home: ``{"nous": client_id or "", "password": username or ""}``."""
    section = _dashboard_section()
    oauth = section.get("oauth") if isinstance(section.get("oauth"), dict) else {}
    basic = section.get("basic_auth") if isinstance(section.get("basic_auth"), dict) else {}
    has_password = bool(str(basic.get("password_hash") or basic.get("password") or "").strip())
    return {
        "nous": _env(_CLIENT_ID_ENV) or str(oauth.get("client_id") or "").strip(),
        "password": str(basic.get("username") or "").strip() if has_password else "",
    }


def apply_public_url(plan: AccessPlan) -> None:
    """Pin (public) or clear (lan) ``HERMES_DASHBOARD_PUBLIC_URL`` for *plan*."""
    from hermes_cli.config import remove_env_value, save_env_value

    if plan.mode == "public":
        if _env(_PUBLIC_URL_ENV) != plan.public_url:
            save_env_value(_PUBLIC_URL_ENV, plan.public_url)
        return
    configured = str(_dashboard_section().get("public_url") or "").strip()
    if configured:
        raise WebappAccessError(
            f"config.yaml sets dashboard.public_url to {configured}, which only allows that address. "
            "Remove it to serve on your network.")
    remove_env_value(_PUBLIC_URL_ENV)


def register_nous_sign_in(plan: AccessPlan, *, name: Optional[str] = None):
    """Register or update this home's portal client with *plan*'s callback."""
    from hermes_cli.dashboard_register import DashboardRegisterError, register_dashboard_client

    try:
        return register_dashboard_client(
            name=name, redirect_uri=plan.callback_url, write_public_url=plan.mode == "public")
    except DashboardRegisterError as exc:
        raise WebappAccessError(str(exc)) from exc


def remove_nous_sign_in() -> None:
    """Forget the portal client locally; revoke it at the portal's Local Dashboards page."""
    from hermes_cli.config import remove_env_value

    remove_env_value(_CLIENT_ID_ENV)


def prepare(plan: AccessPlan, *, enable_nous: bool = False, name: Optional[str] = None) -> dict:
    """Make this home ready to serve *plan*; returns the sign-in methods it will accept.

    The public URL is pinned or cleared, and Nous sign-in (already configured, or turned on with
    *enable_nous*) is registered with this plan's callback — idempotent, so it follows a changed
    LAN address or URL. Refuses when no login is configured, so a caller never spawns a server
    that ``start_server`` would refuse.
    """
    methods = sign_in_methods()
    nous = enable_nous or bool(methods["nous"])
    # Refuse before writing anything: a refused start must leave the home as it found it.
    if not (nous or methods["password"]):
        raise WebappAccessError("Set up a sign-in method (Nous account or password) first.")
    if plan.mode == "public" and not nous:
        raise WebappAccessError(
            "Your own URL needs Nous sign-in. A password alone is for a network you trust.")
    apply_public_url(plan)
    if nous:
        register_nous_sign_in(plan, name=name)
    return sign_in_methods()


def _mode_for_bind(host: str) -> str:
    if host in _LOOPBACK_HOSTS:
        return "public" if _env(_PUBLIC_URL_ENV) else "local"
    return "lan"


def _configures_instead_of_serving(command: str) -> bool:
    """``hermes webapp setup|register …``: a configuration command, never a server."""
    import shlex

    from hermes_cli.dashboard_procs import _dashboard_subcommand_index
    from hermes_cli.subcommands.dashboard import WEBAPP_CONFIG_SUBCOMMANDS

    try:
        argv = shlex.split(command)
    except ValueError:
        return False
    index = _dashboard_subcommand_index(argv)
    return index is not None and len(argv) > index + 1 and argv[index + 1] in WEBAPP_CONFIG_SUBCOMMANDS


def running_webapps(*, check_listening: bool = True) -> list[dict]:
    """Live ``hermes webapp`` servers of THIS home, with their bind.

    ``listening`` separates a server that accepts connections from one still preparing its
    runtime or renderer: the process exists for up to a minute before its port opens.
    """
    from hermes_cli.dashboard_procs import _pids_owned_by_hermes_home, _scan_dashboard_processes
    from hermes_cli.main_dashboard import _dashboard_listening, _parse_dashboard_runtime
    from hermes_constants import get_hermes_home

    servers: dict[int, tuple[str, int]] = {}
    for pid, command in _scan_dashboard_processes():
        runtime = _parse_dashboard_runtime(command)
        if runtime and runtime[0] == "webapp" and not _configures_instead_of_serving(command):
            servers[pid] = (runtime[1], runtime[2])
    owned = _pids_owned_by_hermes_home(list(servers), str(get_hermes_home()))
    return [
        {
            "pid": pid, "host": host, "port": port, "mode": _mode_for_bind(host),
            "listening": _dashboard_listening(host, port) if check_listening else None,
        }
        for pid in owned
        for host, port in [servers[pid]]
    ]


def stop_webapps(reason: str = "requested via Web access") -> tuple[bool, list[dict]]:
    """Stop THIS home's Webapp servers in-process: ``(found any, still alive)``.

    The same home-scoped kill as ``hermes webapp --stop``, without spawning a CLI child: a
    stop must keep working when spawning ``hermes`` itself is what is broken.
    """
    from hermes_cli.dashboard_procs import _kill_stale_dashboard_processes
    from hermes_constants import get_hermes_home

    pids = {server["pid"] for server in running_webapps(check_listening=False)}
    if not pids:
        return False, []
    _kill_stale_dashboard_processes(reason=reason, include_pids=pids, scope_home=str(get_hermes_home()))
    return True, running_webapps(check_listening=False)


def access_status() -> dict:
    """Everything the Web access pane shows, read for the current home."""
    methods = sign_in_methods()
    return {
        "running": running_webapps(),
        "lan_address": lan_address(),
        "public_url": _env(_PUBLIC_URL_ENV),
        "nous_client_id": methods["nous"],
        "password_username": methods["password"],
        "default_port": DEFAULT_PORT,
    }
