"""Overlapping app lifespans must tear down only their own terminal registry."""
from contextlib import AsyncExitStack

import pytest
from fastapi import FastAPI

from hermes_cli.web_host_terminal_sessions import get_host_terminals, host_terminal_lifespan


@pytest.mark.asyncio
@pytest.mark.parametrize("older_first", [True, False])
async def test_overlapping_lifespans_close_only_their_owned_registry(older_first):
    app = FastAPI()
    async with AsyncExitStack() as older, AsyncExitStack() as newer:
        await older.enter_async_context(host_terminal_lifespan(app))
        first = get_host_terminals(app)
        await newer.enter_async_context(host_terminal_lifespan(app))
        second = get_host_terminals(app)
        assert second is not first

        if older_first:
            await older.aclose()
            assert first._closed and not second._closed
            assert get_host_terminals(app) is second
            await newer.aclose()
        else:
            await newer.aclose()
            assert second._closed and not first._closed
            assert not hasattr(app.state, "host_terminals")
            await older.aclose()

    assert first._closed and second._closed
    assert not hasattr(app.state, "host_terminals")
