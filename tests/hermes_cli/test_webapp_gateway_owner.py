"""The Webapp finds or starts its profile's gateway the way local Desktop does (``webapp_gateway_owner``).

Fakes stand in only at the discovery/ensure boundary and the restart runner, so the ladder itself runs
for real: start an absent owner, refuse an owner too old for browser attach with its remedy, pass a
lasting verdict to the browser, and restart an owner running other code once, then attach as-is
(Electron's ``createStaleGatewayRestarter``).
"""
import asyncio
import logging

import pytest

from hermes_cli import gateway_runtime, version_info, webapp_gateway_owner as owner
from hermes_cli.gateway_runtime import GatewayDiscovery, GatewayEndpoint

CAPABILITIES = frozenset({'session-authority-v1', 'durable-admission-v1', 'event-replay-v1', 'delegated-attach-v1'})


def _endpoint(home, **overrides):
    fields = dict(profile_id=str(home), instance_id='inst', authority_epoch=1, runtime_protocol=1,
                  api_origin='http://127.0.0.1:1', supervisor='systemd', capabilities=CAPABILITIES,
                  code_sha='same-code')
    return GatewayEndpoint(**{**fields, **overrides})


@pytest.fixture
def ladder(monkeypatch, tmp_path):
    """``(calls, set_owner)``: discovery answers with the owner set last, ensure starts one."""
    state = {'owner': None, 'started': None}
    calls = {'ensure': 0, 'restart': []}

    def discover(home, timeout=2.0):
        return GatewayDiscovery('ready', state['owner']) if state['owner'] else GatewayDiscovery('absent')

    def ensure(home, *, timeout=60.0, idle_exit=False):
        calls['ensure'] += 1
        assert idle_exit is False  # a Webapp-started gateway serves messaging too: never an idle exiter
        state['owner'] = state['started'].endpoint
        return state['started']

    def restart(profile, done):
        calls['restart'].append(profile)
        done.set()

    monkeypatch.setattr(gateway_runtime, 'discover_gateway_endpoint', discover)
    monkeypatch.setattr(gateway_runtime, 'ensure_gateway_runtime', ensure)
    monkeypatch.setattr(version_info, 'get_code_identity', lambda refresh=False: {'sha': 'same-code'})
    monkeypatch.setattr(owner, '_run_restart', restart)
    monkeypatch.setattr(owner, '_restarts', {})
    monkeypatch.setattr(owner, '_warned_unsupervised', set())
    monkeypatch.setattr('gateway.status._profile_label_for_home', lambda home: 'default')
    return state, calls, tmp_path


def test_an_absent_owner_is_started_and_a_service_webapp_says_how_to_keep_it(ladder, monkeypatch, caplog):
    state, calls, home = ladder
    state['started'] = GatewayDiscovery('ready', _endpoint(home, supervisor='none'))
    monkeypatch.setattr('gateway.control_socket._detect_supervisor', lambda: 'systemd')
    with caplog.at_level(logging.WARNING, logger='hermes_cli.web_server'):
        assert asyncio.run(owner.owner_endpoint(home)).instance_id == 'inst'
        assert asyncio.run(owner.owner_endpoint(home)).instance_id == 'inst'  # now discovered: no start
    assert calls['ensure'] == 1
    warnings = [r.getMessage() for r in caplog.records if 'hermes gateway install' in r.getMessage()]
    assert len(warnings) == 1, warnings


def test_a_lasting_verdict_and_an_owner_too_old_to_attach_reach_the_browser(ladder):
    state, _calls, home = ladder
    state['started'] = GatewayDiscovery('incompatible', None, 'runtime_protocol', 'another install owns it')
    with pytest.raises(owner.GatewayAttachError) as refused:
        asyncio.run(owner.owner_endpoint(home))
    assert refused.value.verdict() == {'state': 'incompatible', 'reason_code': 'runtime_protocol',
                                       'detail': 'another install owns it'}
    state['owner'] = _endpoint(home, capabilities=CAPABILITIES - {'delegated-attach-v1'})
    with pytest.raises(owner.GatewayAttachError) as old:
        asyncio.run(owner.owner_endpoint(home))
    assert old.value.reason_code == 'delegated_attach_unavailable'
    assert 'hermes gateway restart' in old.value.detail


def test_an_owner_running_other_code_is_restarted_once_then_attached_as_is(ladder):
    state, calls, home = ladder
    state['owner'] = _endpoint(home, code_sha='old-code')
    for _ in range(3):
        assert asyncio.run(owner.owner_endpoint(home)).code_sha == 'old-code'
    assert calls['restart'] == ['default']
    # An owner that cannot name its code is never restarted on a guess.
    state['owner'] = _endpoint(home, code_sha=None)
    asyncio.run(owner.owner_endpoint(home))
    assert calls['restart'] == ['default']
