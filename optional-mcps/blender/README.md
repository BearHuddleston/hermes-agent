# Blender catalog review

This is Siddharth Ahuja's community integration, not an official Blender
integration. Installing this catalog entry configures the stdio bridge only;
`post_install` lists the separate add-on installation, telemetry preference,
local server, and live-scene checks. No add-on bootstrap is run automatically.

## Release evidence

- [Upstream README](https://github.com/ahujasid/mcp-for-blender/blob/6f992ffbca3cb715d111fc640b737b808632273c/README.md)
  documents the rename from `ahujasid/blender-mcp`, Blender 3.0+, Python 3.10+,
  `uvx`, `install-addon`, `addon-paths`, localhost:9876, and safe mode.
- [PyPI release metadata](https://pypi.org/pypi/mcp-for-blender/2.0.0/json)
  identifies `mcp-for-blender==2.0.0`, published 2026-09-16, not yanked.
  Its wheel declares `mcp-for-blender = blender_mcp.server:main`, Python
  `>=3.10`, `mcp>=1.9.0,<2`, and `httpx>=0.27.0`. The catalog pins the server
  release; upstream's transitive dependencies are not a fully locked environment.
- The downloaded wheel's SHA-256 was checked against PyPI:
  `785ad7ed2d5d2d880c985451e14a312e0ffdd8a8c7efb8f4997b14c07657784c`.
  The wheel was inspected without installing or executing it.
- [Upstream package metadata](https://github.com/ahujasid/mcp-for-blender/blob/6f992ffbca3cb715d111fc640b737b808632273c/pyproject.toml)
  and [LICENSE](https://github.com/ahujasid/mcp-for-blender/blob/6f992ffbca3cb715d111fc640b737b808632273c/LICENSE)
  agree on MIT, copyright 2025 Siddharth Ahuja. The wheel includes the license.
- [Old package metadata](https://pypi.org/pypi/blender-mcp/2.0.0/json) declares
  a compatibility wrapper depending on `mcp-for-blender>=2.0.0`; it is deliberately
  not used here. Some diagnostic strings in the new wheel still use the old
  name. Follow this manifest's pinned install command rather than those strings.

## Privacy and safety

The reviewed wheel's `telemetry.py` disables event collection and screenshot
uploads when `DISABLE_TELEMETRY=true`; `trajectory.py` checks that same setting
before collection. Disabling add-on consent alone still permits anonymous counts.
The add-on's `Allow Telemetry` and `Auto-Start Server` preferences default to ON.
Uncheck telemetry consent and save preferences as well as retaining the bridge's
environment opt-out. The upstream may still create a local telemetry identifier;
the opt-out is not a promise that no local state is written.

`BLENDER_MCP_SAFE_MODE=1` validates `execute_blender_code` in the MCP process.
It does not sandbox Blender or protect its unauthenticated socket from other
local processes. Saving, rendering, and import/export remain allowed. The default
tool selection omits external asset/generation and feedback tools. Sampling is
not a supported manifest setting: `post_install` explicitly instructs disabling
it through `hermes config set` before use, rather than implying it was applied.

## Suggestion contract

`applications: [Blender]` is an exact, case-insensitive app-name relevance signal
on the Hermes backend host. `requires_app: true` prevents interest-only local
app suggestions; a detected app or configured integration can qualify them, but
neither proves the add-on is enabled or a scene is reachable. Suggestions route
to the existing `manage_connections` install flow with `{name: blender, mcp: true}`.
The examples need only local modeling, materials, and rendering, not paid cloud
asset services. Live Blender execution remains a separate verification step.
