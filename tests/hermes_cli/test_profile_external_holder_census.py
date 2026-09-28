"""The external-holder census reads open files of same-user processes only.

Fetching another user's (system) process handles faulted inside psutil on Windows +
Python 3.14 and killed ``hermes profile delete``/``rename`` with no Python exception
(PR #93508 review). Ownership must be settled before ``open_files`` is touched.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

from hermes_cli import profile_lifecycle


class _Denied(Exception):
    pass


def _fake_psutil(procs: list["_Proc"], me: str) -> types.ModuleType:
    module = types.ModuleType("psutil")
    module.NoSuchProcess = module.ZombieProcess = module.AccessDenied = _Denied

    def process_iter(attrs):
        # psutil populates ``info`` by calling every requested attribute up front.
        for proc in procs:
            proc.info = {name: getattr(proc, name)() for name in attrs}
            yield proc

    module.process_iter = process_iter
    module.Process = lambda _pid: types.SimpleNamespace(username=lambda: me)
    return module


class _Proc:
    def __init__(self, pid: int, user: str | None, paths: list[Path]):
        self._pid, self._user, self._paths = pid, user, paths
        self.open_files_calls = 0

    def pid(self):
        return self._pid

    def ppid(self):
        return 1

    def name(self):
        return "python.exe"

    def create_time(self):
        return 1.0

    def username(self):
        return self._user

    def open_files(self):
        self.open_files_calls += 1
        return [types.SimpleNamespace(path=str(path)) for path in self._paths]


def test_census_never_reads_handles_of_processes_it_cannot_prove_same_user(tmp_path, monkeypatch):
    profile = tmp_path / "profiles" / "alpha"
    profile.mkdir(parents=True)
    held = profile / "state.db"
    system = _Proc(4, "NT AUTHORITY\\SYSTEM", [held])
    unreadable_owner = _Proc(5, None, [held])
    sibling = _Proc(6, "me", [held])
    stranger = _Proc(7, "me", [tmp_path / "elsewhere.txt"])
    monkeypatch.setitem(sys.modules, "psutil", _fake_psutil([system, unreadable_owner, sibling, stranger], "me"))

    assert profile_lifecycle.external_profile_file_holders(profile) == [6]
    assert system.open_files_calls == 0
    assert unreadable_owner.open_files_calls == 0

    # A retry narrowed to the first census's holders reads no other process's handles.
    stranger.open_files_calls = 0
    assert profile_lifecycle.external_profile_file_holders(profile, [6]) == [6]
    assert stranger.open_files_calls == 0


def test_windows_candidates_cover_every_holder_class_hermes_creates():
    """Windows reads open files only for these; each read walks the system handle table."""
    processes = {
        10: (1, "explorer.exe"),
        20: (10, "python.exe"),       # Hermes backend
        21: (20, "node.exe"),         # its MCP server (inherits the profile's stderr log)
        22: (21, "chrome.exe"),       # a browser the tool launched, two levels down
        30: (10, "Hermes.exe"),       # the Desktop app and what it spawns
        31: (30, "Hermes.exe"),
        40: (10, "chrome.exe"),       # argv names the profile
        50: (10, "code.exe"),         # unrelated same-user app with a living parent
        51: (800, "svc-child.exe"),   # parented by another user's live service
        60: (61, "loop.exe"),         # a ppid cycle must terminate
        61: (60, "loop.exe"),
        70: (999, "node.exe"),        # MCP server whose Hermes parent crashed
        71: (72, "node.exe"),         # parent PID since reused by a younger process
        72: (10, "notepad.exe"),
    }
    started = {pid: 100.0 for pid in processes} | {1: 1.0, 800: 1.0, 72: 500.0}

    candidates = profile_lifecycle._holder_candidates(processes, started, lambda pid: pid == 40)

    assert candidates == {20, 21, 22, 30, 31, 40, 70, 71}


def test_release_is_confirmed_by_a_fresh_census(monkeypatch):
    """A holder that exits can leave a child it spawned holding the profile; that child is
    only visible to a new census, so re-checking the old holders alone must not release."""
    parent, child = 7, 8
    live = {parent, child}
    visible = {parent}  # the child is not a candidate while its parent lives

    def census(_profile, candidates=None):
        if candidates is None:
            return sorted(live & visible)
        held = sorted(live & set(candidates))
        live.discard(parent)  # the parent exits after its first re-check
        visible.add(child)
        return held

    monkeypatch.setattr(profile_lifecycle, "external_profile_file_holders", census)
    monkeypatch.setattr(profile_lifecycle, "_PROFILE_DB_RELEASE_TIMEOUT_SECONDS", 0.5)

    assert profile_lifecycle.wait_for_external_profile_file_release("profile") == [child]
