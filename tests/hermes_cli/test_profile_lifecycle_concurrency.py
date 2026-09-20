"""Named lifecycle leases isolate contention without weakening generation fences."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import multiprocessing
from pathlib import Path
import threading

import pytest

from hermes_cli import profile_lifecycle, profiles
from hermes_cli.profile_incarnation import ensure_profile_incarnation, profile_incarnation_lease
from hermes_state import SessionDB


def _hold_profile(home, ready, release):
    with profile_incarnation_lease(home):
        ready.set()
        if not release.wait(30):
            raise TimeoutError("parent did not release the profile lease")


@contextmanager
def _external_lease(home):
    context = multiprocessing.get_context("spawn")
    ready, release = context.Event(), context.Event()
    child = context.Process(target=_hold_profile, args=(home, ready, release))
    child.start()
    try:
        assert ready.wait(15), "child did not acquire the profile lease"
        yield
    finally:
        release.set()
        child.join(10)
        if child.is_alive():
            child.terminate()
            child.join(5)
        assert child.exitcode == 0


@pytest.fixture
def profile_pair(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    pair = [profiles.create_profile(name, no_alias=True, no_skills=True)
            for name in ("alpha", "beta")]
    for profile in pair:
        with SessionDB(db_path=profile / "state.db") as db:
            db.create_session(profile.name, "test")
    return pair


def _assert_unrelated_profile_db_opens(profile_pair, monkeypatch):
    alpha, beta = profile_pair
    monkeypatch.setattr(profile_lifecycle, "_PROFILE_LIFECYCLE_LOCK_TIMEOUT_SECONDS", 2)
    # A -> B -> A, real writable and read-only opens; B must complete BEFORE
    # A's holder is released, rather than depending on a tight speed threshold.
    for held, available in ((alpha, beta), (beta, alpha), (alpha, beta)):
        with _external_lease(held):
            for read_only in (False, True):
                with SessionDB(db_path=available / "state.db", read_only=read_only) as db:
                    assert db.get_session(available.name) is not None


def _assert_waiter_deadlines_and_busy_error(profile_pair, monkeypatch):
    alpha, _ = profile_pair
    token = ensure_profile_incarnation(alpha)
    waiting = threading.Event()
    original_sleep = profile_lifecycle.time.sleep

    def observed_sleep(seconds):
        # The polling sleep is reached only after this waiter's deadline was
        # captured, so the next waiter can safely use a shorter budget.
        waiting.set()
        original_sleep(seconds)

    monkeypatch.setattr(profile_lifecycle.time, "sleep", observed_sleep)

    def acquire():
        with profile_incarnation_lease(alpha, token):
            pytest.fail("contended lease admitted a writer")

    with _external_lease(alpha), ThreadPoolExecutor(max_workers=2) as pool:
        waiting.clear()
        monkeypatch.setattr(profile_lifecycle, "_PROFILE_LIFECYCLE_LOCK_TIMEOUT_SECONDS", 8)
        first = pool.submit(acquire)
        assert waiting.wait(5)
        monkeypatch.setattr(profile_lifecycle, "_PROFILE_LIFECYCLE_LOCK_TIMEOUT_SECONDS", 2)
        second = pool.submit(acquire)
        with pytest.raises(TimeoutError, match="profile lifecycle lock"):
            second.result(timeout=5)
        assert not first.done(), "second waiter inherited the first waiter's deadline"
        with pytest.raises(TimeoutError, match="profile lifecycle lock"):
            first.result(timeout=12)
    with profile_incarnation_lease(alpha, token):
        assert ensure_profile_incarnation(alpha) == token


@pytest.mark.linux_only
def test_unrelated_profile_db_opens_on_linux(profile_pair, monkeypatch):
    _assert_unrelated_profile_db_opens(profile_pair, monkeypatch)


@pytest.mark.macos_only
def test_unrelated_profile_db_opens_on_macos(profile_pair, monkeypatch):
    _assert_unrelated_profile_db_opens(profile_pair, monkeypatch)


@pytest.mark.windows_only
def test_unrelated_profile_db_opens_on_windows(profile_pair, monkeypatch):
    _assert_unrelated_profile_db_opens(profile_pair, monkeypatch)


@pytest.mark.linux_only
def test_waiter_deadlines_and_busy_error_on_linux(profile_pair, monkeypatch):
    _assert_waiter_deadlines_and_busy_error(profile_pair, monkeypatch)


@pytest.mark.macos_only
def test_waiter_deadlines_and_busy_error_on_macos(profile_pair, monkeypatch):
    _assert_waiter_deadlines_and_busy_error(profile_pair, monkeypatch)


@pytest.mark.windows_only
def test_waiter_deadlines_and_busy_error_on_windows(profile_pair, monkeypatch):
    _assert_waiter_deadlines_and_busy_error(profile_pair, monkeypatch)
