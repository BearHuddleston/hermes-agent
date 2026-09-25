"""Profile-generation fence for retained TUI/Desktop session state."""

from __future__ import annotations

from collections.abc import Callable, MutableMapping
from contextlib import contextmanager
from pathlib import Path
import threading
from typing import Any, Iterator

from hermes_cli.profile_incarnation import (
    ensure_profile_incarnation,
    profile_incarnation_lease,
    profile_incarnation_matches,
    read_profile_incarnation,
)
from hermes_constants import (
    named_profile_home_is_unavailable,
    profile_deletion_marker_path,
)


class ProfileLifecycleFence:
    """Track retired paths and incarnations inside one gateway process."""

    def __init__(self) -> None:
        # Never acquire a disk lease while holding this short in-memory lock.
        self._lock = threading.RLock()
        self.retired_homes: set[str] = set()
        self._retired_home_incarnations: dict[str, str | None] = {}
        self.retired_incarnations: set[tuple[str, str]] = set()

    @staticmethod
    def key(profile_home: Path | str) -> str:
        try:
            return str(Path(profile_home).resolve())
        except OSError:
            return str(Path(profile_home))

    def capture(self, profile_home: Path | str | None) -> str | None:
        if profile_home is None:
            return None
        with profile_incarnation_lease(profile_home):
            # Never backfill a missing marker to bypass a local retirement.
            self._check_retirement(profile_home, read_profile_incarnation(profile_home))
            return ensure_profile_incarnation(profile_home)

    def _check_retirement(
        self, profile_home: Path | str, expected_incarnation: str | None,
    ) -> None:
        """Reconcile a published successor while holding its disk lifecycle lease."""
        key = self.key(profile_home)
        with self._lock:
            if expected_incarnation is not None and (key, expected_incarnation) in self.retired_incarnations:
                raise FileNotFoundError(f"Profile incarnation is retired: {profile_home}")
            if key not in self.retired_homes:
                return
            current = read_profile_incarnation(profile_home)
            if (current is None or (key, current) in self.retired_incarnations
                    or self._retired_home_incarnations.get(key) is None):
                raise FileNotFoundError(f"Profile home is retired: {profile_home}")
            # Another process can publish without calling allow() in this server.
            # Drop only the pathname fence; old captured tokens stay rejected.
            self.retired_homes.discard(key)
            self._retired_home_incarnations.pop(key, None)

    @contextmanager
    def lease(
        self,
        profile_home: Path | str,
        expected_incarnation: str | None,
        *,
        require_incarnation: bool = True,
    ) -> Iterator[Path]:
        """Bind one profile resource without crossing a mutation boundary."""
        with profile_incarnation_lease(
            profile_home,
            expected_incarnation,
            require_incarnation=require_incarnation,
        ) as home:
            self._check_retirement(home, expected_incarnation)
            yield home

    def rejected(
        self,
        profile_home: Path | str,
        expected_incarnation: str | None = None,
        *,
        require_incarnation: bool = False,
    ) -> bool:
        key = self.key(profile_home)
        with self._lock:
            # Old callbacks need no disk lease (and may hold the sessions lock
            # while a deleting thread owns the disk lease and waits for it).
            if expected_incarnation is not None and (key, expected_incarnation) in self.retired_incarnations:
                return True
            retired = key in self.retired_homes
        try:
            named_marker = profile_deletion_marker_path(profile_home)
            if named_profile_home_is_unavailable(profile_home):
                return True
        except Exception:
            return True
        if retired:
            try:
                with self.lease(profile_home, expected_incarnation,
                                require_incarnation=require_incarnation):
                    return False
            except (OSError, RuntimeError):
                return True
        if named_marker is None:
            return False
        if expected_incarnation is None:
            if require_incarnation:
                return True
            return False
        with self._lock:
            if (key, expected_incarnation) in self.retired_incarnations:
                return True
        return not profile_incarnation_matches(profile_home, expected_incarnation)

    def retire(
        self,
        profile_home: Path | str,
        incarnation: str | None = None,
    ) -> None:
        key = self.key(profile_home)
        if incarnation is None:
            try:
                incarnation = read_profile_incarnation(profile_home)
            except (OSError, RuntimeError):
                incarnation = None
        with self._lock:
            self.retired_homes.add(key)
            self._retired_home_incarnations[key] = incarnation
            if incarnation is not None:
                self.retired_incarnations.add((key, incarnation))

    def allow(
        self,
        profile_home: Path | str,
        incarnation: str | None = None,
    ) -> None:
        key = self.key(profile_home)
        if incarnation is None:
            try:
                incarnation = read_profile_incarnation(profile_home)
            except (OSError, RuntimeError):
                incarnation = None
        # Rollback of a failed delete admits the unchanged generation.  A
        # same-name recreate has a fresh token, so its call leaves the retired
        # predecessor tuple intact.
        with self._lock:
            self.retired_homes.discard(key)
            self._retired_home_incarnations.pop(key, None)
            if incarnation is not None:
                self.retired_incarnations.discard((key, incarnation))

    def retire_sessions(
        self,
        profile_home: Path | str,
        incarnation: str | None,
        *,
        launch_home: Path | str,
        sessions: MutableMapping[str, dict],
        sessions_lock: Any,
        close_session: Callable[[str], bool],
        close_launch_db: Callable[[], int],
    ) -> int:
        """Fence a profile and tear down every retained in-process session."""
        try:
            target = Path(profile_home).resolve()
        except OSError:
            target = Path(profile_home)
        try:
            resolved_launch_home = Path(launch_home).resolve()
        except OSError:
            resolved_launch_home = Path(launch_home)
        retiring_launch_home = target == resolved_launch_home

        def belongs(session: dict) -> bool:
            if retiring_launch_home and not session.get("profile_home"):
                return True
            raw = session.get("profile_home")
            if not raw:
                return False
            try:
                return Path(raw).resolve() == target
            except OSError:
                return Path(raw) == target

        with sessions_lock:
            self.retire(target, incarnation)
            session_ids = [sid for sid, session in sessions.items() if belongs(session)]

        retired = 0
        unsettled: list[str] = []
        for sid in session_ids:
            if close_session(sid):
                retired += 1
            else:
                unsettled.append(sid)
        if retiring_launch_home:
            retired += close_launch_db()
        if unsettled:
            raise RuntimeError(
                "Profile still has active session turn(s): " + ", ".join(unsettled)
            )
        return retired
