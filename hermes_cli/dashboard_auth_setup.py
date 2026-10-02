"""Write and clear the bundled username/password dashboard login.

Shared by the interactive ``hermes dashboard``/``webapp`` prompt, ``hermes webapp setup`` and
Desktop's Web access pane, so every surface stores the same shape: a scrypt hash (never the
plaintext) plus a stable signing secret under ``dashboard.basic_auth`` in config.yaml.
"""

from __future__ import annotations

import secrets


def save_basic_auth(username: str, password: str) -> bool:
    """Persist *username*/*password* as the password login.

    Returns True when the bundled ``basic`` plugin had to be re-enabled (it was listed in
    ``plugins.disabled``), so a caller can tell the operator. Raises on an empty username or
    password and on a config write failure. A process that will start a server itself must
    re-run ``discover_plugins(force=True)`` afterwards so the provider registers.
    """
    username = username.strip()
    if not username or not password:
        raise ValueError("Username and password are required.")

    from hermes_cli.config import load_config, save_config
    from hermes_cli.plugins_cmd import ensure_basic_auth_plugin_enabled_in_config
    from plugins.dashboard_auth.basic import hash_password

    cfg = load_config()
    basic = cfg.setdefault("dashboard", {}).setdefault("basic_auth", {})
    basic["username"] = username
    basic["password_hash"] = hash_password(password)
    basic["password"] = ""  # never persist plaintext
    # A stable token-signing secret so sessions survive a server restart.
    if not str(basic.get("secret", "") or "").strip():
        basic["secret"] = secrets.token_urlsafe(32)
    # The bundled basic provider is a backend plugin that honours plugins.disabled.
    reenabled = ensure_basic_auth_plugin_enabled_in_config(cfg)
    save_config(cfg)
    return reenabled


def clear_basic_auth() -> None:
    """Remove the password login (username, hash, plaintext and signing secret).

    Clearing the secret too invalidates every session it signed, so removing the password
    also signs out whoever logged in with it. A server already running keeps its provider
    until it restarts.
    """
    from hermes_cli.config import load_config, save_config

    cfg = load_config()
    basic = cfg.setdefault("dashboard", {}).setdefault("basic_auth", {})
    for key in ("username", "password_hash", "password", "secret"):
        basic[key] = ""
    save_config(cfg)

