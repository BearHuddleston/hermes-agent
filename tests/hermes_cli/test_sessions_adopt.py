"""`hermes sessions adopt` brings a profile's pre-gateway chats under its gateway, as the host.

The Webapp attaches as the remote login it authenticated (an exposure grant), which may not make
the first claim on an unowned historical row (gateway-local-sessions.md, shared operator access).
The host's own native client adopts them in one pass, after which the browser login continues each.
"""
import argparse
import asyncio

import pytest

from tests.gateway.fixtures.owner_process import running_owner
from tests.gateway.test_delegated_attach import ALICE, _rpc

_OLD_CHATS = (('old-desktop', 'desktop', None), ('old-desktop-nous', 'desktop', 'nous:account'),
              ('old-cli', 'cli', None), ('foreign-desktop', 'desktop', 'telegram:42'),
              ('api-row', 'api_server', None))


def _seed(home):
    from hermes_state import SessionDB
    db = SessionDB(db_path=home / 'state.db')
    try:
        for sid, source, user_id in _OLD_CHATS:
            db.create_session(sid, source=source, model='old-model', cwd=str(home), user_id=user_id)
            db.append_message(sid, role='user', content=sid.upper())
            db.end_session(sid, 'session_switch')
    finally:
        db.close()


def _adopt(capsys, *argv):
    from hermes_cli import sessions_cmd
    from hermes_cli.subcommands.sessions import build_sessions_parser
    parser = argparse.ArgumentParser()
    build_sessions_parser(parser.add_subparsers(dest='command'), cmd_sessions=sessions_cmd.cmd_sessions)
    args = parser.parse_args(['sessions', 'adopt', *argv])
    status = args.func(args)
    return status, capsys.readouterr().out


async def _browser_resume(home, descriptor, sid):
    """What the Webapp's relay opens for the browser: an exposure socket as the logged-in user."""
    from websockets.asyncio.client import connect
    from tests.gateway.test_normal_runtime_boot import control
    grant = control(home, 'session-ticket', {'profile_id': str(home.resolve()), 'instance_id': descriptor['instance_id'],
                                             'purpose': 'exposure', 'scope': 'host', 'subject': ALICE})
    url = descriptor['api_origin'].replace('http:', 'ws:') + '/api/ws'
    async with connect(url, subprotocols=['hermes-gateway-v1', 'hermes-gateway-ticket.' + grant['ticket']],
                       proxy=None) as socket:
        return await _rpc(socket, 'session.resume', session_id=sid)


@pytest.mark.platforms("linux")
def test_adopting_old_chats_lets_the_browser_login_continue_them(tmp_path, model_peer, monkeypatch, capsys):
    with running_owner(tmp_path, model_peer, prepare=_seed) as (home, descriptor, _env):
        monkeypatch.setenv('HERMES_HOME', str(home))
        assert asyncio.run(_browser_resume(home, descriptor, 'old-desktop'))['error']['message'] == 'not_found'

        status, out = _adopt(capsys, '--dry-run')
        assert status == 0 and '3 pre-gateway chat(s) to adopt (1 cli, 2 desktop)' in out, out
        assert asyncio.run(_browser_resume(home, descriptor, 'old-desktop'))['error']['message'] == 'not_found'

        status, out = _adopt(capsys)
        assert status == 0 and 'Adopted 3 chat(s).' in out, out
        for sid in ('old-desktop', 'old-desktop-nous', 'old-cli'):
            resumed = asyncio.run(_browser_resume(home, descriptor, sid))
            assert resumed.get('result', {}).get('session_id') == sid, resumed
            assert [m['content'] for m in resumed['result']['messages']] == [sid.upper()]
        # Another identity's row and a non-local row were never offered, so they stay as they were.
        assert asyncio.run(_browser_resume(home, descriptor, 'foreign-desktop'))['error']['message'] == 'not_found'

        status, out = _adopt(capsys)
        assert status == 0 and 'Nothing to adopt' in out, out
