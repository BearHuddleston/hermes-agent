---
sidebar_position: 6
---

# Isolated Desktop instances

Give a remote Hermes agent its **own Desktop application** — its own window,
settings, Chromium profile, and single-instance lock — while still sharing
the one local Hermes installation you already update.

This is **not** [Settings → Connections](./multi-connection-desktop.md).
Connections keep one shared Electron shell and add more agent sources
inside it. Isolated instances are for the case where you tried that and
need a second, independent Desktop.

Currently the create / launch / shortcut path is **Windows-only**. Listing
and inspecting instances works on every platform.

## When to use which

| You want… | Use |
|---|---|
| Several remotes in **one** window, one Settings app, one dock icon | **Settings → Connections** |
| Independent windows, caches, and shell identity (`Hermes Grace`, `Hermes Athena`, ordinary Hermes) | **Isolated Desktop instances** |
| Separate agent state without a second Desktop | [`hermes profile`](./profiles.md) |

An explicit rejection of Connections after you have tried it is a workflow
preference. Keep using isolated instances; do not migrate those remotes back
into the shared-shell registry unless you ask to.

## What is isolated vs shared

Each named instance gets:

1. Its own Electron `userData` (`HERMES_DESKTOP_USER_DATA_DIR` plus early `--user-data-dir`)
2. Its own local `HERMES_HOME`
3. Its own app / process name and single-instance namespace
4. A persisted SSH target, absolute remote Hermes path, and remote profile
5. Its own clickable Desktop shortcut

What stays shared:

- The canonical local `Hermes.exe` / runtime / update path
- Adjacent Electron resources (via a differently named **hardlink** next to `Hermes.exe`)

What is **never** cloned locally:

- Remote sessions, memory, skills, configuration, and credentials

A copied, symlinked, or hardlinked executable is **not** isolation by itself.
The two state-root overrides plus the distinct app name are the boundary.

## Create an instance

The remote machine must already have Hermes and a working SSH alias:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=15 <alias> \
  "bash -lc 'command -v hermes; hermes --version; hermes profile list'"
```

Then, on the Windows machine that runs Desktop:

```bash
hermes desktop instance create grace \
  --ssh-host grace \
  --remote-hermes-path /home/you/.local/bin/hermes \
  --remote-profile default \
  --display-name "Hermes Grace"

hermes desktop instance create athena \
  --ssh-host bear-agent \
  --remote-hermes-path /home/you/.local/bin/hermes \
  --remote-profile default \
  --display-name "Hermes Athena"
```

That writes a non-secret manifest, seeds isolated `connection.json` (SSH
fields only — no token bytes), compiles a small native launcher, creates
the named hardlink beside canonical `Hermes.exe`, and drops a Desktop
shortcut that points at the launcher (icon from canonical `Hermes.exe`).

```bash
hermes desktop instance list
hermes desktop instance launch grace
hermes desktop instance shortcut grace     # recreate the .lnk
hermes desktop instance repair --all       # after a local Desktop update
hermes desktop instance remove grace       # launcher + shortcut only
hermes desktop instance remove grace --purge-local
```

`remove` never deletes anything on the remote machine. Without
`--purge-local` it also keeps the isolated local home and Electron
userData so you can recreate the launcher later.

Ordinary `hermes desktop` is unchanged and still opens the canonical
local shell.

## Layout

Defaults (no hardcoded usernames or hosts):

```text
%LOCALAPPDATA%\hermes\desktop-instances\<name>\
  instance.json          # non-secret manifest
  home\                  # isolated HERMES_HOME
  user-data\             # isolated Electron userData
  launcher\              # compiled native winexe + generated .cs
```

The named hardlink lives **beside** the shared executable, for example
`…\release\win-unpacked\Hermes Grace.exe` → same bytes as `Hermes.exe`.
That avoids a path-specific Windows AppCompat `RUNASADMIN` layer on the
canonical exe while still sharing updates.

## Updates

Close isolated windows before rebuilding the shared Desktop artifact
(`hermes desktop --force-build` or the in-app updater). A successful
packaged rebuild then refreshes every instance hardlink it can; a running
instance keeps its in-use image and is repaired on the next clean launch.

If a shortcut opens the ordinary Desktop after an update, run:

```bash
hermes desktop instance repair --all
hermes desktop instance shortcut <name>
```

Update each **remote** Hermes install separately. Isolated instances do
not copy or pin the remote runtime.

## Migrating from a hand-rolled launcher

If you already have a working native launcher (the documented workaround):

1. Leave those launchers and isolated roots in place.
2. Create first-party instances with the same SSH alias, absolute remote
   path, and remote profile. If a `connection.json` already exists in the
   new instance `user-data` directory, Hermes will not overwrite it.
3. Launch from the new shortcut and confirm a visible renderer plus
   `SSH: <host>` in the status badge. A ready backend without a window is
   a failure.
4. Only then retire the old `.lnk` / compiled launcher. Do not delete
   remote state.

To go the other way — from isolated instances back to **one** shared
shell — use Settings → Connections, then `hermes desktop instance remove`
once the shared-shell route is verified. Isolated local roots can stay
until you pass `--purge-local`.

## Reverting / uninstalling the feature

- `hermes desktop instance remove NAME` — drop launcher, named hardlink,
  and shortcut.
- `--purge-local` — also delete that instance's local home and userData.
- Ordinary Desktop, `%LOCALAPPDATA%\hermes`, and every remote host are
  left alone.
- There is no first-party macOS/Linux launcher yet. On those platforms
  `create` / `launch` / `shortcut` / `repair` fail with an explicit
  incompatible-platform error; `list` / `show` / `remove` still work.

## Pitfalls

- **VBS / Python / `ShellExecute` wrappers** focus the ordinary Desktop
  or lose process-local `HERMES_HOME`. Use the compiled launcher or
  `hermes desktop instance launch`.
- **Win32 error 740** — canonical `Hermes.exe` has a path-specific
  AppCompat run-as-admin layer. The named hardlink is the supported
  workaround; do not change the ordinary app's compatibility tab.
- **`__COMPAT_LAYER=RunAsInvoker`** can start the backend while the
  renderer dies (`render-process-gone`, `exitCode=18`). Do not add
  `--no-sandbox`.
- **Backend-only false positive** — `Remote Hermes backend is ready` is
  not success. You need a visible window and the SSH status badge.
- Only one shell can own the global quick-entry hotkey. That does not
  invalidate SSH connectivity.

## Follow-up

A Settings → Connections action to “Open as isolated Desktop” and a
native macOS/Linux launcher are intentionally out of this first cut.
The Windows CLI (`hermes desktop instance`) is the supported surface.
