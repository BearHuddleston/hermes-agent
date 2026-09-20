"""Native shell continuity through the real /api/pty route, isolated from user state."""
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from hermes_cli import web_server, web_server_chat
from hermes_cli.web_routers.chat_ws import router


@pytest.fixture
def host_app(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    (home / "config.yaml").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(web_server.app.state, "ui_surface", "webapp", raising=False)
    monkeypatch.setattr(web_server.app.state, "bound_host", "localhost", raising=False)
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    # Do not run login scripts from the real user's shell.
    from hermes_cli import web_host_terminal
    monkeypatch.setattr(web_host_terminal, "shell_spec", lambda: (["/bin/sh", "-i"], "sh"))
    app = FastAPI()
    app.include_router(router)
    from hermes_cli.web_host_terminal_sessions import host_terminal_lifespan
    app.router.lifespan_context = host_terminal_lifespan
    yield app


def url(extra=""):
    return f"ws://localhost/api/pty?mode=shell&persistent=1&token={web_server._SESSION_TOKEN}{extra}"


def metadata(ws):
    text = ws.receive_text()
    assert text.startswith(web_server_chat._HOST_TERMINAL_META_PREFIX)
    return json.loads(text.removeprefix(web_server_chat._HOST_TERMINAL_META_PREFIX))


def output_until(ws, marker):
    output = b""
    while marker not in output:
        output += ws.receive_bytes()
    return output


@pytest.mark.linux_only
def test_real_shell_survives_disconnect_and_explicit_close(host_app, tmp_path):
    import shlex
    import sys
    with TestClient(host_app, base_url="http://localhost") as client:
        with client.websocket_connect(url("&cwd=" + str(tmp_path))) as ws:
            first = metadata(ws)
            token = first["terminalId"]
            bridge = host_app.state.host_terminals._sessions[token].bridge
            ws.send_bytes(b"stty -echo; continuity=retained; printf 'PID=%s\\n' $$\n")
            output_until(ws, b"PID=")
            # Echo can contain the command: use a response marker split in source.
            ws.send_bytes(b"printf 'REA%s=%s\\n' DY $$\n")
            ready = output_until(ws, b"READY=")
            pid = ready.split(b"READY=")[-1].splitlines()[0].strip()
            program = 'import os,sys; print("CHILD="+str(os.getpid()), flush=True); print("INPUT="+repr(sys.stdin.readline()), flush=True)'
            ws.send_bytes(f"{shlex.quote(sys.executable)} -u -c {shlex.quote(program)}\n".encode())
            child = output_until(ws, b"CHILD=")
            child_pid = child.split(b"CHILD=")[-1].splitlines()[0].strip()
        with client.websocket_connect(url("&attach=" + token)) as ws:
            resumed = metadata(ws)
            assert resumed["reconnected"] is True
            assert resumed["terminalId"] == token
            assert b"CHILD=" + child_pid in output_until(ws, b"CHILD=" + child_pid)
            ws.send_bytes(b"foreground survived\n")
            assert b"INPUT='foreground survived\\n'" in output_until(ws, b"INPUT='foreground survived\\n'")
            ws.send_bytes(b"printf 'STATE=%s:%s\\n' \"$continuity\" $$\n")
            assert b"STATE=retained:" + pid in output_until(ws, b"STATE=retained:" + pid)
            program = 'import os,time; print("CLOSING="+str(os.getpid()), flush=True); time.sleep(120)'
            ws.send_bytes(f"{shlex.quote(sys.executable)} -u -c {shlex.quote(program)}\n".encode())
            running = output_until(ws, b"CLOSING=")
            foreground_pid = int(running.split(b"CLOSING=")[-1].splitlines()[0].strip())
        with client.websocket_connect(url("&attach=" + token + "&action=close")) as ws:
            assert metadata(ws)["closed"] is True
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_bytes()
            assert closed.value.code == 1000
            assert not bridge.is_alive()
            import psutil
            try:
                child_process = psutil.Process(foreground_pid)
            except psutil.NoSuchProcess:
                pass
            else:
                assert child_process.status() == psutil.STATUS_ZOMBIE
        with client.websocket_connect(url("&attach=" + token)) as ws:
            with pytest.raises(WebSocketDisconnect) as expired:
                ws.receive_bytes()
            assert expired.value.code == 4410


@pytest.mark.linux_only
@pytest.mark.parametrize("spawn_fails", [False, True])
def test_route_cancelled_spawn_is_owned_through_lifespan(host_app, monkeypatch, spawn_fails):
    import threading

    original_spawn = web_server_chat.PtyBridge.spawn
    entered, release, returned = threading.Event(), threading.Event(), threading.Event()
    closing = threading.Event()
    bridges = []
    releaser = None

    def spawn(argv, **kwargs):
        entered.set()
        assert release.wait(5)
        try:
            if spawn_fails:
                raise OSError("fork failed after disconnect")
            bridge = original_spawn(["/bin/sh", "-c", "sleep 120"], **kwargs)
            bridges.append(bridge)
            return bridge
        finally:
            returned.set()

    def release_on_shutdown():
        if closing.wait(3):
            release.set()

    monkeypatch.setattr(web_server_chat.PtyBridge, "spawn", spawn)
    try:
        with TestClient(host_app) as client:
            registry = host_app.state.host_terminals
            original_close_all = registry.close_all

            async def close_all():
                closing.set()
                await original_close_all()

            monkeypatch.setattr(registry, "close_all", close_all)
            with client.websocket_connect(url()):
                assert entered.wait(2)
            # TestClient cancels the request in its real AnyIO scope. It must
            # not wait for fork/exec or own the cleanup that shutdown awaits.
            assert not returned.is_set()
            releaser = threading.Thread(target=release_on_shutdown)
            releaser.start()
        assert closing.is_set() and returned.is_set()
        assert not registry._sessions and not registry.owners
        assert len(bridges) == (0 if spawn_fails else 1)
        assert all(not bridge.is_alive() for bridge in bridges)
    finally:
        release.set()
        if releaser is not None:
            releaser.join(3)
        for bridge in bridges:
            bridge.close()


class IdleBridge:
    def __init__(self):
        import threading
        self.closed = threading.Event()
        self.writes = []
        self.resizes = []

    def read(self, timeout):
        self.closed.wait(timeout)
        return None if self.closed.is_set() else b""

    async def write(self, data):
        self.writes.append(data)
        return True

    def resize(self, cols, rows):
        self.resizes.append((cols, rows))

    def close(self):
        self.closed.set()


@pytest.fixture
def fake_bridges(monkeypatch):
    bridges = []

    def spawn(*args, **kwargs):
        bridge = IdleBridge()
        bridges.append(bridge)
        return bridge

    monkeypatch.setattr(web_server_chat.PtyBridge, "spawn", spawn)
    return bridges


def rejection(client, request, expected):
    # Handles pre-accept gate failures and post-accept terminal refusals.
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect(request) as ws:
            ws.receive_text()
    assert error.value.code == expected


def ticket_url(user="owner", extra=""):
    from hermes_cli.dashboard_auth.ws_tickets import mint_ticket
    ticket = mint_ticket(user_id=user, provider="test-provider")
    return f"ws://localhost/api/pty?mode=shell&persistent=1&ticket={ticket}{extra}"


def test_identity_profile_incarnation_and_auth_gate(host_app, fake_bridges, tmp_path, monkeypatch):
    from hermes_cli.profile_incarnation import ensure_profile_incarnation, write_fresh_profile_incarnation
    from hermes_cli.profile_lifecycle import profile_lifecycle_lease
    home = tmp_path / ".hermes"
    for name in ("alpha", "beta"):
        profile = home / "profiles" / name
        profile.mkdir(parents=True)
        (profile / "config.yaml").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(web_server.app.state, "auth_required", True)
    with TestClient(host_app) as client:
        with client.websocket_connect(ticket_url(extra="&profile=alpha")) as ws:
            token = metadata(ws)["terminalId"]
        rejection(client, ticket_url("other", "&profile=alpha&attach=" + token), 4403)
        rejection(client, ticket_url(extra="&profile=beta&attach=" + token), 4403)
        rejection(client, ticket_url("other", "&profile=alpha&attach=" + token + "&action=close"), 4403)
        rejection(client, ticket_url(extra="&profile=beta&attach=" + token + "&action=close"), 4403)
        rejection(client, url("&profile=alpha&attach=" + token), 4401)
        rejection(client, url("&profile=alpha&attach=" + token + "&action=close"), 4401)
        assert len(fake_bridges) == 1 and not fake_bridges[0].closed.is_set()
        with client.websocket_connect(ticket_url(extra="&profile=alpha&attach=" + token)) as ws:
            assert metadata(ws)["reconnected"]
        assert fake_bridges[0].writes == []  # never Ctrl-L into a host shell
        alpha = home / "profiles" / "alpha"
        with profile_lifecycle_lease(alpha):
            previous = ensure_profile_incarnation(alpha)
            assert write_fresh_profile_incarnation(alpha) != previous
        rejection(client, ticket_url(extra="&profile=alpha&attach=" + token), 4410)
        rejection(client, ticket_url(extra="&profile=alpha&attach=" + token + "&action=close"), 4410)
        assert len(fake_bridges) == 1
        assert fake_bridges[0].closed.wait(3)  # live reaper retires stale generations


@pytest.mark.linux_only
def test_real_profile_a_b_a_and_process_exit_never_respawns(host_app, tmp_path):
    homes = {}
    for name in ("alpha", "beta"):
        homes[name] = tmp_path / ".hermes" / "profiles" / name
        homes[name].mkdir(parents=True)
        (homes[name] / "config.yaml").write_text("{}", encoding="utf-8")
    with TestClient(host_app) as client:
        tokens = {}
        for name in ("alpha", "beta", "alpha"):
            extra = "&profile=" + name
            if name in tokens:
                extra += "&attach=" + tokens[name]
            with client.websocket_connect(url(extra)) as ws:
                tokens[name] = metadata(ws)["terminalId"]
                ws.send_bytes(b"printf 'HO%s=%s\\n' ME \"$HERMES_HOME\"\n")
                assert b"HOME=" + str(homes[name]).encode() in output_until(ws, b"HOME=" + str(homes[name]).encode())
        token = tokens["alpha"]
        with client.websocket_connect(url("&profile=alpha&attach=" + token)) as ws:
            metadata(ws)
            ws.send_bytes(b"exit\n")
            with pytest.raises(WebSocketDisconnect) as error:
                while True:
                    ws.receive_bytes()
            assert error.value.code == 4410
        rejection(client, url("&profile=alpha&attach=" + token), 4410)
        assert set(host_app.state.host_terminals._sessions) <= set(tokens.values())


def test_capacity_expiry_close_idempotence_and_lifespan(host_app, fake_bridges):
    with TestClient(host_app) as client:
        registry = host_app.state.host_terminals
        registry._max = 1
        with client.websocket_connect(url()) as ws:
            token = metadata(ws)["terminalId"]
            rejection(client, url(), 1013)
            assert not fake_bridges[0].closed.is_set()
        detached = registry._sessions[token].last_detached_at
        assert detached is not None
        registry._sessions[token].last_detached_at = detached - registry._ttl - 1
        rejection(client, url("&attach=" + token), 4410)
        assert len(fake_bridges) == 1
        # A fresh request may create, an expired attach never does.
        with client.websocket_connect(url()) as ws:
            next_token = metadata(ws)["terminalId"]
            assert next_token != token
        for _ in range(2):
            with client.websocket_connect(url("&attach=" + next_token + "&action=close")) as ws:
                assert metadata(ws)["closed"]
        with client.websocket_connect(url()) as ws:
            metadata(ws)
    assert all(bridge.closed.is_set() for bridge in fake_bridges)
    assert not registry._sessions and not registry.owners
    assert not hasattr(host_app.state, "host_terminals")


def test_simultaneous_viewer_supersedes_without_respawn(host_app, fake_bridges):
    with TestClient(host_app) as client:
        with client.websocket_connect(url()) as old:
            token = metadata(old)["terminalId"]
            assert old.receive_bytes() == b""  # explicit empty replay boundary
            with client.websocket_connect(url("&attach=" + token)) as new:
                assert metadata(new)["reconnected"]
                with pytest.raises(WebSocketDisconnect) as error:
                    old.receive_bytes()
                assert error.value.code == 4409
                new.send_bytes(b"current")
        assert len(fake_bridges) == 1
        assert fake_bridges[0].writes == [b"current"]


def test_cross_process_retirement_closes_attached_shell(host_app, fake_bridges, tmp_path):
    import os
    import subprocess
    import sys
    profile = tmp_path / ".hermes" / "profiles" / "alpha"
    profile.mkdir(parents=True)
    (profile / "config.yaml").write_text("{}", encoding="utf-8")
    with TestClient(host_app) as client:
        with client.websocket_connect(url("&profile=alpha")) as ws:
            metadata(ws)
            assert ws.receive_bytes() == b""  # empty replay precedes retirement
            subprocess.run([
                sys.executable, "-c",
                "import sys; from hermes_cli.profile_lifecycle import profile_lifecycle_lease, mark_profile_deleting; "
                "from hermes_cli.profile_incarnation import read_profile_incarnation; "
                "\nwith profile_lifecycle_lease(sys.argv[1]): mark_profile_deleting(sys.argv[1], read_profile_incarnation(sys.argv[1]))",
                str(profile),
            ], env={**os.environ, "HOME": str(tmp_path)}, check=True, timeout=5)
            with pytest.raises(WebSocketDisconnect) as error:
                ws.receive_bytes()
            assert error.value.code == 4410
        assert fake_bridges[0].closed.wait(3)


@pytest.mark.parametrize("failure", ["metadata", "replay"])
def test_route_lost_initial_delivery_detaches_and_expires(host_app, fake_bridges, monkeypatch, failure):
    from starlette.websockets import WebSocket
    from hermes_cli.pty_session import PtySession
    original_start = PtySession.start

    async def start(session):
        session.buffer.append(b"startup output")
        await original_start(session)

    async def broken(*args, **kwargs):
        raise RuntimeError("transport lost")

    monkeypatch.setattr(PtySession, "start", start)
    monkeypatch.setattr(WebSocket, "send_text" if failure == "metadata" else "send_bytes", broken)
    with TestClient(host_app) as client:
        with client.websocket_connect(url()) as ws:
            if failure == "replay":
                metadata(ws)
            with pytest.raises(WebSocketDisconnect) as error:
                ws.receive_bytes()
            assert error.value.code == 1011
        registry = host_app.state.host_terminals
        session = next(iter(registry._sessions.values()))
        assert not session.attached and session.last_detached_at is not None
        assert client.portal is not None
        client.portal.call(registry.reap_idle, session.last_detached_at + registry._ttl + 1)
        assert not registry._sessions and fake_bridges[0].closed.is_set()


def test_host_policy_and_missing_profile_do_not_spawn(host_app, fake_bridges, monkeypatch):
    with TestClient(host_app) as client:
        rejection(client, url("&profile=missing"), 4410)
        rejection(client, url("&attach=" + "x" * 43), 4410)
        monkeypatch.setattr(web_server.app.state, "ui_surface", "dashboard")
        for extra in ("", "&attach=" + "x" * 43, "&attach=" + "x" * 43 + "&action=close"):
            rejection(client, url(extra), 4403)
        assert not fake_bridges


def test_capture_and_spawn_hold_profile_incarnation_lease(host_app, fake_bridges, tmp_path, monkeypatch):
    import threading
    from hermes_cli import profile_lifecycle, web_host_terminal
    from hermes_cli.profile_incarnation import write_fresh_profile_incarnation
    profile = tmp_path / ".hermes" / "profiles" / "alpha"
    profile.mkdir(parents=True)
    (profile / "config.yaml").write_text("{}", encoding="utf-8")
    began, retired = threading.Event(), threading.Event()
    errors = []

    def retirement():
        try:
            try:
                with profile_lifecycle.profile_lifecycle_lease(profile, timeout=0):
                    raise AssertionError("terminal configuration ran without a profile lease")
            except TimeoutError:
                began.set()
            with profile_lifecycle.profile_lifecycle_lease(profile):
                write_fresh_profile_incarnation(profile)
                retired.set()
        except Exception as exc:
            errors.append(exc)
            began.set()

    workers = []
    original = web_host_terminal.resolve_argv

    def resolving(**kwargs):
        worker = threading.Thread(target=retirement)
        workers.append(worker)
        worker.start()
        assert began.wait(2)
        assert not errors
        assert not retired.is_set()
        return original(**kwargs)

    monkeypatch.setattr(web_host_terminal, "resolve_argv", resolving)
    with TestClient(host_app) as client:
        with client.websocket_connect(url("&profile=alpha")) as ws:
            # Retirement may win after spawn but before metadata; neither path
            # may retarget the request to a new generation or spawn twice.
            first = ws.receive()
            if first["type"] != "websocket.close":
                # Metadata is always followed by the snapshot, even when empty.
                assert ws.receive_bytes() == b""
                with pytest.raises(WebSocketDisconnect) as error:
                    ws.receive_bytes()
                assert error.value.code == 4410
            else:
                assert first["code"] == 4410
        for worker in workers:
            worker.join(3)
        assert not errors
        assert retired.is_set() and len(fake_bridges) == 1
        assert fake_bridges[0].closed.wait(3)
