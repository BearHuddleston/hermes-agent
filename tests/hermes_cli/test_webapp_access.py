"""Remote Webapp access (``hermes_cli.webapp_access``, ``/api/webapp-access/*``).

Contracts: a Webapp that Desktop's backend launches can never qualify for the Desktop-owned
loopback auth exemption, LAN access registers the LAN callback without pinning a public URL, and
nothing is spawned or written while no login is configured.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402


class _FakeProc:
    pid = 4242

    def poll(self):
        return None


@pytest.fixture()
def client():
    from hermes_cli import web_server

    c = TestClient(web_server.app, raise_server_exceptions=False)
    c.headers["Authorization"] = f"Bearer {web_server._SESSION_TOKEN}"
    return c


@pytest.fixture()
def spawned(monkeypatch):
    """Capture the detached ``hermes webapp`` child instead of starting it."""
    import hermes_cli.web_server_gateway as gw
    from hermes_cli import webapp_access

    # No live process-table scan under the test sandbox: nothing is already serving.
    monkeypatch.setattr(webapp_access, "running_webapps", lambda: [])
    calls: list[dict] = []

    def _popen(cmd, **kwargs):
        calls.append({"cmd": list(cmd), "env": dict(kwargs["env"])})
        return _FakeProc()

    monkeypatch.setattr(gw.subprocess, "Popen", _popen)
    return calls


def _dotenv() -> dict:
    from hermes_cli.config import load_env

    return load_env()


def test_launched_webapp_cannot_inherit_the_desktop_auth_exemption(client, spawned, monkeypatch):
    from hermes_cli import web_server
    from hermes_cli.dashboard_auth_setup import save_basic_auth

    # What Desktop's own backend carries: the per-spawn ownership credential, plus a stale
    # public URL that would beat the profile's .env in the child.
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_TOKEN", "desktop-spawn-token")
    monkeypatch.setenv("HERMES_DASHBOARD_PUBLIC_URL", "https://stale.example.test")
    save_basic_auth("admin", "pw-for-test")

    response = client.post(
        "/api/webapp-access/start",
        json={"mode": "public", "public_url": "https://hermes.example.test", "port": 9333})

    assert response.status_code == 200, response.text
    [child] = spawned
    assert child["cmd"][-6:] == ["webapp", "--host", "127.0.0.1", "--port", "9333", "--no-open"]
    assert not any(key.startswith("HERMES_DASHBOARD_") for key in child["env"])
    # HERMES_DESKTOP=1 alone already makes a server act Desktop-spawned (cron ticker, dist).
    assert "HERMES_DESKTOP" not in child["env"]
    with patch.dict(os.environ, child["env"], clear=True):
        assert not web_server._desktop_loopback_auth_exempt("127.0.0.1")
    # The child reads the public URL from the profile's .env, which engages its gate.
    assert _dotenv().get("HERMES_DASHBOARD_PUBLIC_URL") == "https://hermes.example.test"


def test_lan_access_registers_the_lan_callback_and_unpins_a_public_url(monkeypatch):
    import hermes_cli.dashboard_register as dashboard_register
    from hermes_cli import webapp_access
    from hermes_cli.config import save_env_value

    save_env_value("HERMES_DASHBOARD_OAUTH_CLIENT_ID", "agent:test-client")
    save_env_value("HERMES_DASHBOARD_PUBLIC_URL", "https://old.example.test")
    monkeypatch.setattr(webapp_access, "lan_address", lambda: "192.168.1.50")
    registered: list[dict] = []
    monkeypatch.setattr(
        dashboard_register, "register_dashboard_client", lambda **kw: registered.append(kw))

    plan = webapp_access.plan_access("lan", port=9119)
    webapp_access.prepare(plan)

    assert plan.bind_host == "0.0.0.0"
    assert [(r["redirect_uri"], r["write_public_url"]) for r in registered] == [
        ("http://192.168.1.50:9119/auth/callback", False)]
    assert "HERMES_DASHBOARD_PUBLIC_URL" not in _dotenv()


def test_start_without_a_login_spawns_and_writes_nothing(client, spawned):
    response = client.post(
        "/api/webapp-access/start",
        json={"mode": "public", "public_url": "https://hermes.example.test"})

    assert response.status_code == 400
    assert spawned == []
    assert "HERMES_DASHBOARD_PUBLIC_URL" not in _dotenv()
