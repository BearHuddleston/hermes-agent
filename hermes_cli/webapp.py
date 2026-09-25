"""Build and launch plumbing for the browser-hosted Desktop workspace.

The browser surface shares Hermes' hardened dashboard server. This module owns
only the separate renderer artifact and the one-way handoff into that server;
it never creates a second HTTP/WebSocket stack.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time



_DIST_NAME = "dist-webapp"
_STAMP_NAME = "desktop-webapp-build-stamp.json"
# Serialize renderer publication with Dashboard builds in this checkout.
# Webapp installs dependencies in a private copy; native node_modules stays intact.
_LOCK_NAME = ".web_ui_build.lock"
_LOCK_WAIT_SECONDS = 30 * 60


class WebappBuildError(RuntimeError):
    """The browser-hosted Desktop renderer could not be prepared."""


def webapp_dist_dir(project_root: Path) -> Path:
    return project_root / "apps" / "desktop" / _DIST_NAME


def _desktop_source_files(project_root: Path):
    """Renderer inputs in a stable order, pruning ``.gitignore`` matches."""
    from pathspec import PathSpec

    ignore_file = project_root / ".gitignore"
    spec = PathSpec.from_lines(
        "gitignore", ignore_file.read_text(encoding="utf-8").splitlines() if ignore_file.is_file() else []
    )

    def ignored(path: Path, *, directory: bool = False) -> bool:
        relative = path.relative_to(project_root).as_posix()
        return spec.match_file(relative + "/" if directory else relative)

    for name in ("package.json", "package-lock.json"):
        path = project_root / name
        if path.is_file() and not ignored(path):
            yield path
    for tree in (project_root / "apps" / "desktop", project_root / "apps" / "shared"):
        for dirpath, dirnames, filenames in os.walk(tree, topdown=True):
            dirnames[:] = sorted(d for d in dirnames if not ignored(Path(dirpath) / d, directory=True))
            for filename in sorted(filenames):
                path = Path(dirpath) / filename
                if not ignored(path):
                    yield path


def _compute_desktop_content_hash(project_root: Path) -> str:
    """SHA-256 of Desktop and its shared sources, plus root workspace config."""
    digest = hashlib.sha256()
    for path in _desktop_source_files(project_root):
        digest.update(str(path.relative_to(project_root)).encode())
        digest.update(b"\0")
        try:
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(65536), b""):
                    digest.update(chunk)
        except OSError:
            pass
        digest.update(b"\0")
    return digest.hexdigest()


def _stamp_path() -> Path:
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root() / _STAMP_NAME


def _build_needed(project_root: Path, *, force: bool = False) -> bool:
    dist = webapp_dist_dir(project_root)
    if force or not (dist / "index.html").is_file():
        return True

    stamp = _stamp_path()
    try:
        payload = json.loads(stamp.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True

    saved_hash = str(payload.get("contentHash") or "")
    return not saved_hash or saved_hash != _compute_desktop_content_hash(
        project_root
    )


def _write_stamp(project_root: Path) -> None:
    stamp = _stamp_path()
    payload = {
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "contentHash": _compute_desktop_content_hash(project_root),
        "surface": "desktop-webapp",
    }
    stamp.parent.mkdir(parents=True, exist_ok=True)
    pending = stamp.with_suffix(".tmp")
    pending.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(pending, stamp)


def _workspace_install_args() -> tuple[str, ...]:
    """Install the locked workspace graph without native lifecycle scripts."""
    return (
        "ci",
        "--workspaces",
        "--include-workspace-root",
        "--include=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
    )


def _build_env() -> dict[str, str]:
    """PM-provided Node/npm environment shared with the source builders."""
    from hermes_cli.source_build import source_build_env

    try:
        env = source_build_env()
    except (OSError, RuntimeError) as exc:
        raise WebappBuildError(f"Hermes Webapp needs Node.js/npm to build its Desktop renderer: {exc}") from exc
    env["ELECTRON_SKIP_BINARY_DOWNLOAD"] = "1"
    return env


def _npm_command(project_root: Path, env: dict[str, str]) -> list[str]:
    """npm through the shared resolver, which runs its JS entrypoint without a shell."""
    node = shutil.which("node", path=env.get("PATH", ""))
    if not node:
        raise WebappBuildError("Hermes Webapp needs Node.js/npm to build its Desktop renderer")
    return [node, str(project_root / "scripts" / "build" / "node-deps.mjs"), "--npm"]


def _run_npm(argv: list[str], label: str, *, cwd: Path, env: dict[str, str]) -> None:
    from pm.progress import run_contained

    try:
        run_contained(argv, label, indent="  ", cwd=cwd, env=env)
    except subprocess.CalledProcessError as exc:
        raise WebappBuildError(f"{label} failed (exit {exc.returncode})") from exc
    except OSError as exc:
        raise WebappBuildError(f"{label} failed: {exc}") from exc


def _try_file_lock(handle) -> bool:
    try:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            getattr(msvcrt, "locking")(
                handle.fileno(), getattr(msvcrt, "LK_NBLCK"), 1
            )
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except (BlockingIOError, OSError):
        return False


def _unlock_file(handle) -> None:
    try:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            getattr(msvcrt, "locking")(
                handle.fileno(), getattr(msvcrt, "LK_UNLCK"), 1
            )
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


@contextmanager
def _exclusive_build_lock(path: Path):
    """Cross-platform exclusive lock for one renderer generation."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a+b")
    except OSError as exc:
        raise WebappBuildError(f"Could not open Webapp build lock {path}: {exc}") from exc

    windows = os.name == "nt"
    deadline = time.monotonic() + _LOCK_WAIT_SECONDS
    announced = False
    try:
        if windows:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()

        while True:
            if _try_file_lock(handle):
                break
            if time.monotonic() >= deadline:
                raise WebappBuildError(
                    f"Timed out waiting for another Webapp build ({path})"
                )
            if not announced:
                print("→ Another Hermes Webapp build is running; waiting for it...")
                announced = True
            time.sleep(0.1)

        yield
    finally:
        _unlock_file(handle)
        handle.close()


def _publish_dist(staging: Path, dist: Path) -> None:
    """Publish one complete renderer generation, restoring the old one on error."""
    backup = dist.with_name(f".dist-webapp-backup-{os.getpid()}-{secrets.token_hex(4)}")
    had_previous = dist.exists()
    preserve_backup = False
    try:
        if had_previous:
            os.replace(dist, backup)
        os.replace(staging, dist)
    except OSError as exc:
        if had_previous and backup.exists() and not dist.exists():
            try:
                os.replace(backup, dist)
            except OSError as restore_exc:
                preserve_backup = True
                raise WebappBuildError(
                    f"Could not publish Webapp renderer: {exc}. "
                    f"Restoring the prior renderer also failed; backup preserved at "
                    f"{backup}: {restore_exc}"
                ) from exc
        raise WebappBuildError(f"Could not publish Webapp renderer: {exc}") from exc
    finally:
        if backup.exists() and not preserve_backup:
            try:
                shutil.rmtree(backup)
            except OSError:
                pass


@contextmanager
def _private_build_workspace(project_root: Path):
    """Copy renderer inputs so npm cannot prune the native installation."""
    from pathspec import PathSpec
    from hermes_constants import get_scratch_dir

    manifest = json.loads((project_root / "package.json").read_text(encoding="utf-8"))
    ignore_file = project_root / ".gitignore"
    spec = PathSpec.from_lines(
        "gitignore", ignore_file.read_text(encoding="utf-8").splitlines() if ignore_file.is_file() else []
    )

    def ignore(directory, names):
        parent = Path(directory)
        return [name for name in names if name in {"node_modules", ".git"}
                or spec.match_file((parent / name).relative_to(project_root).as_posix()
                                   + ("/" if (parent / name).is_dir() else ""))]

    with tempfile.TemporaryDirectory(prefix="hermes-webapp-build-", dir=get_scratch_dir()) as temporary:
        workspace = Path(temporary)
        for name in ("package.json", "package-lock.json", ".npmrc"):
            source = project_root / name
            if source.is_file():
                shutil.copy2(source, workspace / name)

        # Keep the locked workspace graph intact without copying unrelated source
        # trees. Only Desktop and its shared package are compiled by this build.
        for pattern in manifest.get("workspaces", []):
            for package in project_root.glob(pattern):
                source = package / "package.json"
                if source.is_file():
                    target = workspace / source.relative_to(project_root)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
        for relative in (Path("apps/desktop"), Path("apps/shared")):
            source = project_root / relative
            if source.is_dir():
                shutil.copytree(source, workspace / relative, ignore=ignore, dirs_exist_ok=True)
        yield workspace


def _do_build(project_root: Path, *, force: bool) -> Path:
    dist = webapp_dist_dir(project_root)
    if not _build_needed(project_root, force=force):
        print(f"✓ Hermes Webapp renderer is up to date: {dist}")
        return dist

    desktop_dir = project_root / "apps" / "desktop"
    if not (desktop_dir / "package.json").is_file():
        raise WebappBuildError(f"Desktop workspace not found at {desktop_dir}")

    env = _build_env()
    npm = _npm_command(project_root, env)
    install_env = dict(env, npm_config_ignore_scripts="true")
    staging = desktop_dir / f".dist-webapp-build-{os.getpid()}-{secrets.token_hex(4)}"
    try:
        with _private_build_workspace(project_root) as workspace:
            _run_npm(
                [*npm, *_workspace_install_args()],
                "Browser-renderer dependency install",
                cwd=workspace,
                env=install_env,
            )
            _run_npm(
                [*npm, "run", "--workspace", "apps/desktop", "build:webapp", "--", "--outDir", str(staging)],
                "Browser-hosted Desktop build",
                cwd=workspace,
                env=env,
            )
            if not (staging / "index.html").is_file():
                raise WebappBuildError("Browser-hosted Desktop build produced no index.html")
        _publish_dist(staging, dist)
    finally:
        if staging.exists():
            try:
                shutil.rmtree(staging)
            except OSError:
                pass

    try:
        _write_stamp(project_root)
    except OSError as exc:
        # The artifact is authoritative; a read-only/contended cache directory
        # only means the next launch recomputes its content hash.
        print(f"⚠ Webapp renderer built, but its build stamp could not be saved: {exc}")
    print(f"✓ Hermes Webapp renderer built: {dist}")
    return dist


def prepare_webapp_renderer(
    project_root: Path,
    *,
    force: bool = False,
    skip_build: bool = False,
) -> Path:
    """Return a verified browser renderer, serializing concurrent builds."""
    project_root = project_root.resolve()
    dist = webapp_dist_dir(project_root)
    lock_path = project_root / _LOCK_NAME
    with _exclusive_build_lock(lock_path):
        if skip_build:
            if not (dist / "index.html").is_file():
                raise WebappBuildError(
                    f"--skip-build was passed but no Webapp renderer exists at {dist}"
                )
            print(f"→ Reusing Hermes Webapp renderer at {dist} (--skip-build)")
            return dist
        return _do_build(project_root, force=force)


def activate_webapp_dist(dist: Path) -> None:
    """Select the caller-managed Desktop bundle for the shared web server."""
    os.environ["HERMES_WEB_DIST"] = str(dist.resolve())
    os.environ.pop("HERMES_SERVE_HEADLESS", None)
