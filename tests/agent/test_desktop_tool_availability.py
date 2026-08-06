"""Desktop tool availability when the gateway is not Desktop-managed."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from run_agent import AIAgent
from tools.registry import invalidate_check_fn_cache


def test_remote_desktop_agent_includes_preview_tools_without_process_flag(
    monkeypatch, tmp_path
):
    """The session platform, not gateway launch ownership, defines the UI surface."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.delenv("HERMES_DESKTOP_TERMINAL", raising=False)

    import model_tools

    model_tools._clear_tool_defs_cache()
    invalidate_check_fn_cache()
    home_token = set_hermes_home_override(tmp_path)
    try:
        agent = AIAgent(
            api_key="test-key",
            base_url="http://127.0.0.1:1/v1",
            provider="custom",
            model="anthropic/claude-sonnet-4.6",
            platform="desktop",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            enabled_toolsets=["terminal"],
        )
    finally:
        reset_hermes_home_override(home_token)

    assert {"open_preview", "read_preview"} <= getattr(agent, "valid_tool_names")


def test_preview_tool_cache_isolated_between_desktop_and_cli(monkeypatch):
    """A shared gateway must not leak Desktop-only schemas into other clients."""
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.delenv("HERMES_DESKTOP_TERMINAL", raising=False)

    import model_tools

    model_tools._clear_tool_defs_cache()
    invalidate_check_fn_cache()

    def preview_names(platform):
        definitions = model_tools.get_tool_definitions(
            enabled_toolsets=["terminal"],
            quiet_mode=True,
            platform=platform,
        )
        return {
            item["function"]["name"]
            for item in definitions
            if item["function"]["name"] in {"open_preview", "read_preview"}
        }

    assert preview_names("desktop") == {"open_preview", "read_preview"}
    assert preview_names("cli") == set()


def test_preview_tool_availability_context_is_thread_local(monkeypatch):
    """Concurrent Desktop and non-Desktop builds must not share availability state."""
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.delenv("HERMES_DESKTOP_TERMINAL", raising=False)

    import model_tools

    model_tools._clear_tool_defs_cache()
    invalidate_check_fn_cache()
    barrier = Barrier(2)

    def preview_names(platform):
        barrier.wait()
        definitions = model_tools.get_tool_definitions(
            enabled_toolsets=["terminal"],
            quiet_mode=True,
            platform=platform,
        )
        return {
            item["function"]["name"]
            for item in definitions
            if item["function"]["name"] in {"open_preview", "read_preview"}
        }

    with ThreadPoolExecutor(max_workers=2) as pool:
        desktop = pool.submit(preview_names, "desktop")
        cli = pool.submit(preview_names, "cli")

    assert desktop.result() == {"open_preview", "read_preview"}
    assert cli.result() == set()
