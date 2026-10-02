"""``hermes webapp setup`` — make the Webapp reachable from other devices, behind a login.

Configures this home (public URL pin, Nous sign-in or a password) through
:mod:`hermes_cli.webapp_access` — the same functions Desktop's Web access pane calls — and prints
the exact ``hermes webapp`` command that serves it. It never starts the server itself, so the
running server's argv always carries its real host and port for ``--status``.
"""

from __future__ import annotations

import getpass
import sys
from typing import NoReturn


def _fail(message: str) -> NoReturn:
    print(f"✗ {message}")
    sys.exit(1)


def _profile_prefix() -> str:
    from hermes_constants import get_hermes_home, profile_name_for_home

    name = profile_name_for_home(get_hermes_home())
    return f"-p {name} " if name and name != "default" else ""


def _prompt_password() -> tuple[str, str]:
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        _fail("Setting a password needs an interactive terminal.")
    from hermes_cli.cli_output import line_input

    try:
        username = line_input("  Username [admin]: ").strip() or "admin"
        password = getpass.getpass("  Password: ")
        confirm = getpass.getpass("  Confirm password: ")
    except (EOFError, KeyboardInterrupt):
        _fail("Cancelled.")
    if not password:
        _fail("Empty password — aborting.")
    if password != confirm:
        _fail("Passwords don't match — aborting.")
    return username, password


def cmd_webapp_setup(args) -> None:
    from hermes_cli.dashboard_auth_setup import save_basic_auth
    from hermes_cli.webapp_access import WebappAccessError, plan_access, prepare, sign_in_methods

    mode = "public" if args.public_url else "lan"
    try:
        plan = plan_access(mode, port=args.port, public_url=args.public_url)
    except WebappAccessError as exc:
        _fail(str(exc))

    auth = args.auth or ("" if any(sign_in_methods().values()) else "nous")
    if auth == "password":
        if mode == "public":
            _fail("Use Nous sign-in (--auth nous) for a public URL; a shared password is for a "
                  "trusted network only.")
        username, password = _prompt_password()
        if save_basic_auth(username, password):
            print("  ✓ Re-enabled the bundled 'basic' auth plugin (was in plugins.disabled)")
    try:
        methods = prepare(plan, enable_nous=auth == "nous", name=args.name)
    except WebappAccessError as exc:
        _fail(str(exc))

    where = "your network" if mode == "lan" else plan.public_url
    print(f"✓ The web app is ready to serve {where}.")
    if methods["nous"]:
        print("  Sign-in: your Nous account")
    if methods["password"]:
        print(f"  Sign-in: password (user {methods['password']})")
        if mode == "public":
            print("  ⚠ Password sign-in is also on for this public URL. Remove it with "
                  "`hermes config set dashboard.basic_auth.password_hash ''` if you only want Nous.")
    print(f"\n  Start it:   hermes {_profile_prefix()}webapp --host {plan.bind_host} --port {plan.port}")
    if mode == "public":
        print(f"  Then point your HTTPS proxy or tunnel for {plan.public_url} at http://127.0.0.1:{plan.port}")
    print(f"  Open:       {plan.url}")
