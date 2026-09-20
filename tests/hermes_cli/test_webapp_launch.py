"""Operator handoff must not turn the launch credential into process-list data."""
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote, urlsplit

import pytest


def test_private_launch_uses_existing_token_and_owner_only_browser_redirect(monkeypatch, tmp_path, capsys, caplog):
    import webbrowser
    from hermes_cli import web_server as server, web_server_lifecycle as lifecycle

    monkeypatch.setattr(server.app.state, "ui_surface", "webapp", raising=False)
    monkeypatch.setattr(server.app.state, "auth_required", False, raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("DISPLAY", ":test")
    # Execute the scheduled opener deterministically, without launching a browser.
    monkeypatch.setattr(lifecycle.threading, "Thread", lambda target, **kw: SimpleNamespace(start=target))
    monkeypatch.setattr(lifecycle.time, "sleep", lambda seconds: None)
    opened = []
    monkeypatch.setattr(webbrowser, "open", opened.append)
    lifecycle._maybe_open_browser("::1", 9123, False, "coder")
    launch = capsys.readouterr().out.split(": ", 1)[1].strip()
    parsed = urlsplit(launch)
    assert parsed.hostname == "::1"
    assert parse_qs(parsed.query) == {"profile": ["coder"]}
    assert parse_qs(parsed.fragment) == {"hermes-session": [server._SESSION_TOKEN]}
    assert not opened
    lifecycle._maybe_open_browser("::1", 9123, True, "coder")
    capsys.readouterr()
    assert len(opened) == 1 and server._SESSION_TOKEN not in opened[0]
    target = Path(unquote(urlsplit(opened[0]).path))
    assert target.is_relative_to(tmp_path / "cache" / "scratch")
    assert server._SESSION_TOKEN in target.read_text()
    # This permission contract applies to POSIX, not a simulated Windows host.
    import os
    if os.name != "nt":
        assert target.stat().st_mode & 0o077 == 0
    assert server._SESSION_TOKEN not in caplog.text

    # Real startup credential branch, stopping at the socket construction seam.
    # Both inherited values and prior starts must be replaced for local Webapp.
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_TOKEN", "inherited")
    monkeypatch.setattr(server, "_SESSION_TOKEN", "inherited")
    monkeypatch.setattr(server, "_configure_auth_gate", lambda *a: None)
    monkeypatch.setattr("hermes_cli.nous_auth_keepalive.start_nous_auth_keepalive", lambda: None)
    def stop_at_bind(*args, **kwargs):
        raise RuntimeError("test bind boundary")
    monkeypatch.setattr(server, "_build_uvicorn_server", stop_at_bind)
    with pytest.raises(RuntimeError, match="test bind boundary"):
        server.start_server(port=0, open_browser=False, ui_surface="webapp")
    first = server._SESSION_TOKEN
    with pytest.raises(RuntimeError, match="test bind boundary"):
        server.start_server(port=0, open_browser=False, ui_surface="webapp")
    assert first != "inherited" and server._SESSION_TOKEN != first
    assert os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] == "inherited"

    server.app.state.auth_required = True
    lifecycle._maybe_open_browser("127.0.0.1", 9123, True, "coder")
    assert not capsys.readouterr().out
    assert urlsplit(opened[-1]).fragment == ""


def test_existing_named_webapp_preserves_profile_and_explains_private_access(monkeypatch, capsys):
    import webbrowser
    from hermes_cli import main_dashboard, profiles

    monkeypatch.setattr(profiles, "get_active_profile_name", lambda: "coder")
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.setattr(main_dashboard, "_dashboard_surface_at", lambda *a: "webapp")
    opened = []
    monkeypatch.setattr(webbrowser, "open", opened.append)
    args = SimpleNamespace(host="127.0.0.1", port=9123, webapp_surface=True,
                           no_open=False, isolated=False, open_profile="")
    with pytest.raises(SystemExit) as result:
        main_dashboard._route_named_profile_dashboard(args, False, "", "")
    assert result.value.code == 0
    output = capsys.readouterr().out
    assert "?profile=coder" in output
    assert "private launch link" in output and "BEFORE its # fragment" in output
    assert not opened
