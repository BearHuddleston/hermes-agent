"""Named isolated Hermes Desktop instances.

Each instance is a separate Electron shell (userData + single-instance
namespace + process name) and a separate local ``HERMES_HOME``, while
sharing one canonical Hermes runtime/install. Remote agent state stays
on the remote machine.

This is the opposite of Settings → Connections, which adds more sources
to one shared Desktop shell.

The Windows launch path follows the validated native-launcher contract:
a differently named hardlink beside canonical ``Hermes.exe``, an explicit
process environment, ``UseShellExecute=false``, and early
``--user-data-dir``.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from hermes_cli.profiles import normalize_profile_name, validate_profile_name
from hermes_constants import get_default_hermes_root
from utils import atomic_write_text

MANIFEST_VERSION = 1
INSTANCES_DIRNAME = "desktop-instances"
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_RESERVED_NAMES = frozenset({
    "hermes",
    "default",
    "test",
    "tmp",
    "root",
    "sudo",
    "desktop",
    "gui",
    "instance",
    "local",
    "connections",
})
_WIN_ABS = re.compile(r"^[A-Za-z]:[\\/]")
_TEMPLATE_NAME = "windows_isolated_desktop_launcher.cs"
_SECRET_KEYS = frozenset({"token", "password", "secret", "passphrase", "private_key"})


class DesktopInstanceError(Exception):
    """User-facing instance management error."""


class InstanceNameError(DesktopInstanceError):
    """The instance slug is not a safe identifier."""


class ManifestError(DesktopInstanceError):
    """The on-disk manifest is missing or invalid."""


class StalePathError(DesktopInstanceError):
    """A required local path is missing or not absolute."""


class MissingSshAliasError(DesktopInstanceError):
    """SSH is missing or the configured host/alias cannot be used."""


class IncompatiblePlatformError(DesktopInstanceError):
    """The requested mutation is only supported on Windows."""


class InstanceLockedError(DesktopInstanceError):
    """The instance executable is running or otherwise locked."""


class InstanceExistsError(DesktopInstanceError):
    """An instance with this name already exists."""


class InstanceNotFoundError(DesktopInstanceError):
    """No instance is registered under that name."""


@dataclass(frozen=True)
class LaunchPlan:
    executable: Path
    arguments: list[str]
    env: dict[str, str]
    cwd: str
    use_shell_execute: bool = False


@dataclass(frozen=True)
class HardlinkRefreshResult:
    path: Path
    refreshed: bool
    retained_running: bool


@dataclass(frozen=True)
class ShortcutSpec:
    path: Path
    target: str
    icon: str
    working_directory: str
    description: str


@dataclass(frozen=True)
class RemoveResult:
    name: str
    remote_state_deleted: bool = False
    purged_local: bool = False


@dataclass(frozen=True)
class DesktopInstance:
    name: str
    display_name: str
    app_name: str
    ssh_host: str
    remote_hermes_path: str
    remote_profile: str
    hermes_home: Path
    user_data: Path
    runtime_root: Path
    canonical_exe: Path
    named_exe: Path
    launcher_dir: Path
    launcher_exe: Path
    shortcut_path: Path
    manifest_path: Path

    def to_manifest(self) -> dict[str, object]:
        return {
            "version": MANIFEST_VERSION,
            "name": self.name,
            "display_name": self.display_name,
            "app_name": self.app_name,
            "ssh_host": self.ssh_host,
            "remote_hermes_path": self.remote_hermes_path,
            "remote_profile": self.remote_profile,
            "hermes_home": str(self.hermes_home),
            "user_data": str(self.user_data),
            "runtime_root": str(self.runtime_root),
            "canonical_exe": str(self.canonical_exe),
            "named_exe": str(self.named_exe),
            "launcher_dir": str(self.launcher_dir),
            "launcher_exe": str(self.launcher_exe),
            "shortcut_path": str(self.shortcut_path),
        }


def validate_instance_name(name: str) -> str:
    """Return the canonical instance slug or raise ``InstanceNameError``."""
    if not isinstance(name, str) or not name.strip():
        raise InstanceNameError("Instance name cannot be empty.")
    slug = name.strip().lower()
    if not _NAME_RE.match(slug):
        raise InstanceNameError(
            f"Invalid instance name {name!r}. Use a slug matching "
            f"[a-z0-9][a-z0-9_-]{{0,63}} (for example 'grace' or 'athena')."
        )
    if slug in _RESERVED_NAMES:
        raise InstanceNameError(
            f"Instance name {slug!r} is reserved. Pick a different name."
        )
    return slug


def validate_remote_hermes_path(path: str) -> str:
    """Require an absolute remote Hermes launcher path."""
    value = (path or "").strip()
    if not value:
        raise StalePathError("Remote Hermes path is required and must be absolute.")
    posix_abs = value.startswith("/")
    windows_abs = bool(_WIN_ABS.match(value) or value.startswith("\\\\"))
    if not posix_abs and not windows_abs:
        raise StalePathError(
            f"Remote Hermes path {path!r} is not absolute. "
            "Pass the full remote launcher path (for example /home/you/.local/bin/hermes)."
        )
    return value


def validate_ssh_host(host: str) -> str:
    value = (host or "").strip()
    if not value:
        raise MissingSshAliasError("SSH host / alias is required.")
    if any(sep in value for sep in ("\\", "/", "\x00")):
        raise MissingSshAliasError(
            f"SSH host {host!r} looks like a path. Pass an ssh config alias or hostname."
        )
    return value


def validate_remote_profile(name: str) -> str:
    canon = normalize_profile_name(name)
    validate_profile_name(canon)
    return canon


def default_display_name(name: str) -> str:
    words = validate_instance_name(name).replace("_", "-").replace("-", " ")
    return "Hermes " + " ".join(part.capitalize() for part in words.split())


def seed_connection_config(instance: DesktopInstance) -> dict[str, object]:
    """Non-secret SSH seed for the isolated shell's ``connection.json``."""
    return {
        "mode": "ssh",
        "remote": {
            "mode": "ssh",
            "host": instance.ssh_host,
            "remoteHermesPath": instance.remote_hermes_path,
            "remoteProfile": instance.remote_profile,
        },
        "profiles": {},
    }


def _csharp_verbatim(value: str) -> str:
    """Escape a value for a C# verbatim string literal.

    A trailing backslash would eat the closing quote (``@"C:\\"``).
    Embedded quotes are doubled.
    """
    text = str(value).replace('"', '""')
    if text.endswith("\\"):
        text += "\\"
    return text


def launcher_template_path() -> Path:
    return Path(__file__).resolve().parent / "templates" / _TEMPLATE_NAME


def csharp_identifier(display_name: str) -> str:
    parts = re.findall(r"[A-Za-z0-9]+", display_name)
    ident = "".join(part[:1].upper() + part[1:] for part in parts) or "HermesInstance"
    if ident[0].isdigit():
        ident = "Hermes" + ident
    return ident + "Launcher"


def _safe_exe_stem(display_name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]', "", display_name).strip(" .")
    return cleaned or "Hermes Instance"


def resolve_packaged_desktop_executable(runtime_root: Path) -> Path | None:
    """Locate the current platform's unpacked Desktop executable."""
    release_dir = Path(runtime_root) / "apps" / "desktop" / "release"
    if sys.platform == "darwin":
        candidates = list(release_dir.glob("mac*/Hermes.app/Contents/MacOS/Hermes"))
    elif sys.platform == "win32":
        candidates = [
            release_dir / "win-unpacked" / "Hermes.exe",
            release_dir / "win-ia32-unpacked" / "Hermes.exe",
            release_dir / "win-arm64-unpacked" / "Hermes.exe",
        ]
    else:
        candidates = [
            release_dir / "linux-unpacked" / "hermes",
            release_dir / "linux-unpacked" / "Hermes",
            release_dir / "linux-arm64-unpacked" / "hermes",
            release_dir / "linux-arm64-unpacked" / "Hermes",
        ]
    existing = [path for path in candidates if path.exists()]
    if not existing:
        return None
    return max(existing, key=lambda path: path.stat().st_mtime)


def default_shortcut_dir() -> Path:
    for key in ("USERPROFILE", "HOME"):
        home = os.environ.get(key, "").strip()
        if home:
            desktop = Path(home) / "Desktop"
            if desktop.is_dir():
                return desktop
    return Path.home() / "Desktop"


def default_ssh_probe(host: str) -> None:
    ssh = shutil.which("ssh")
    if not ssh:
        raise MissingSshAliasError(
            "ssh was not found on PATH. Install OpenSSH or add it to PATH, "
            f"then retry with host {host!r}."
        )
    try:
        result = subprocess.run(
            [ssh, "-G", host],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except OSError as exc:
        raise MissingSshAliasError(
            f"Could not invoke ssh to resolve {host!r}: {exc}"
        ) from exc
    if result.returncode != 0:
        detail = (
            result.stderr or result.stdout or ""
        ).strip() or f"exit {result.returncode}"
        raise MissingSshAliasError(
            f"SSH alias or host {host!r} could not be resolved ({detail})."
        )


def default_is_locked(path: Path) -> bool:
    candidate = Path(path)
    if not candidate.exists():
        return False
    flags = os.O_RDWR
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    try:
        fd = os.open(str(candidate), flags)
    except OSError:
        return True
    os.close(fd)
    return False


def default_compiler(source: str, output: Path) -> None:
    csc = _find_csc()
    if csc is None:
        raise DesktopInstanceError(
            "The .NET Framework C# compiler (csc.exe) was not found. "
            "Isolated Desktop launchers need the in-box Framework compiler."
        )
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    source_path = output.with_suffix(".cs")
    atomic_write_text(source_path, source)
    command = [
        str(csc),
        "/nologo",
        "/target:winexe",
        f"/out:{os.path.normpath(output)}",
        "/r:System.Windows.Forms.dll",
        os.path.normpath(source_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0 or not output.exists():
        detail = (
            result.stderr or result.stdout or ""
        ).strip() or f"exit {result.returncode}"
        raise DesktopInstanceError(
            f"Failed to compile the isolated Desktop launcher: {detail}"
        )


def default_shortcut_writer(spec: ShortcutSpec) -> None:
    spec.path.parent.mkdir(parents=True, exist_ok=True)
    script = (
        "$ws = New-Object -ComObject WScript.Shell; "
        f"$s = $ws.CreateShortcut({_ps_quote(str(spec.path))}); "
        f"$s.TargetPath = {_ps_quote(spec.target)}; "
        f"$s.IconLocation = {_ps_quote(spec.icon)}; "
        f"$s.WorkingDirectory = {_ps_quote(spec.working_directory)}; "
        f"$s.Description = {_ps_quote(spec.description)}; "
        "$s.Save()"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not spec.path.exists():
        detail = (
            result.stderr or result.stdout or ""
        ).strip() or f"exit {result.returncode}"
        raise DesktopInstanceError(f"Failed to create the Desktop shortcut: {detail}")


def default_process_starter(plan: LaunchPlan) -> int:
    env = os.environ.copy()
    env.update(plan.env)
    proc = subprocess.Popen(
        [str(plan.executable), *plan.arguments],
        cwd=plan.cwd or None,
        env=env,
    )
    return int(proc.pid)


def _find_csc() -> Path | None:
    windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
    candidates = [
        windir / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe",
        windir / "Microsoft.NET" / "Framework" / "v4.0.30319" / "csc.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def refresh_named_hardlink(
    canonical_exe: Path,
    named_exe: Path,
    *,
    is_locked: Callable[[Path], bool] = default_is_locked,
) -> HardlinkRefreshResult:
    canonical_exe = Path(canonical_exe)
    named_exe = Path(named_exe)
    if not canonical_exe.is_file():
        raise StalePathError(
            f"The canonical Hermes Desktop executable is missing: {canonical_exe}"
        )
    named_exe.parent.mkdir(parents=True, exist_ok=True)
    if named_exe.exists():
        if is_locked(named_exe):
            return HardlinkRefreshResult(named_exe, False, True)
        try:
            named_exe.unlink()
        except OSError:
            return HardlinkRefreshResult(named_exe, False, True)
    os.link(canonical_exe, named_exe)
    return HardlinkRefreshResult(named_exe, True, False)


class DesktopInstanceStore:
    """Filesystem-backed registry of isolated Desktop instances."""

    def __init__(
        self,
        *,
        hermes_root: Path,
        runtime_root: Path,
        canonical_exe: Path,
        shortcut_dir: Path,
        platform: str | None = None,
        ssh_probe: Callable[[str], None] = default_ssh_probe,
        compiler: Callable[[str, Path], None] = default_compiler,
        shortcut_writer: Callable[[ShortcutSpec], None] = default_shortcut_writer,
        is_locked: Callable[[Path], bool] = default_is_locked,
        process_starter: Callable[[LaunchPlan], int] = default_process_starter,
        cwd: Path | None = None,
    ) -> None:
        self.hermes_root = Path(hermes_root)
        self.runtime_root = Path(runtime_root)
        self.canonical_exe = Path(canonical_exe)
        self.shortcut_dir = Path(shortcut_dir)
        self.platform = platform or sys.platform
        self.ssh_probe = ssh_probe
        self.compiler = compiler
        self.shortcut_writer = shortcut_writer
        self.is_locked = is_locked
        self.process_starter = process_starter
        self.cwd = Path(cwd) if cwd is not None else Path.cwd()

    @classmethod
    def from_defaults(
        cls,
        *,
        runtime_root: Path,
        canonical_exe: Path | None = None,
        hermes_root: Path | None = None,
        cwd: Path | None = None,
    ) -> "DesktopInstanceStore":
        resolved_runtime = Path(runtime_root)
        exe = (
            Path(canonical_exe)
            if canonical_exe is not None
            else resolve_packaged_desktop_executable(resolved_runtime)
        )
        if exe is None:
            exe = (
                resolved_runtime
                / "apps"
                / "desktop"
                / "release"
                / "win-unpacked"
                / "Hermes.exe"
            )
        return cls(
            hermes_root=Path(hermes_root)
            if hermes_root is not None
            else get_default_hermes_root(),
            runtime_root=resolved_runtime,
            canonical_exe=exe,
            shortcut_dir=default_shortcut_dir(),
            cwd=cwd,
        )

    @property
    def registry_root(self) -> Path:
        return self.hermes_root / INSTANCES_DIRNAME

    def instance_root(self, name: str) -> Path:
        return self.registry_root / validate_instance_name(name)

    def _require_windows(self, action: str) -> None:
        if self.platform != "win32":
            raise IncompatiblePlatformError(
                f"{action} is only supported on Windows. "
                "macOS/Linux isolated Desktop shells are a follow-up."
            )

    def _require_runtime(self) -> None:
        if not self.canonical_exe.is_file():
            raise StalePathError(
                "The canonical Hermes Desktop executable is missing: "
                f"{self.canonical_exe}. Build it with `hermes desktop --build-only` "
                "or pass a packaged tree that still contains Hermes.exe."
            )
        if not self.runtime_root.exists():
            raise StalePathError(
                f"The shared Hermes runtime was not found: {self.runtime_root}"
            )

    def build_instance(
        self,
        name: str,
        *,
        ssh_host: str,
        remote_hermes_path: str,
        remote_profile: str,
        display_name: str | None = None,
    ) -> DesktopInstance:
        slug = validate_instance_name(name)
        host = validate_ssh_host(ssh_host)
        remote_path = validate_remote_hermes_path(remote_hermes_path)
        profile = validate_remote_profile(remote_profile)
        label = (display_name or "").strip() or default_display_name(slug)
        app_name = label
        root = self.instance_root(slug)
        launcher_dir = root / "launcher"
        stem = _safe_exe_stem(app_name)
        named_exe = self.canonical_exe.with_name(f"{stem}.exe")
        if (
            named_exe.resolve() == self.canonical_exe.resolve()
            or stem.lower() == "hermes"
        ):
            raise InstanceNameError(
                f"Display name {label!r} would collide with the canonical Hermes.exe. "
                "Use a distinct name such as 'Hermes Grace'."
            )
        return DesktopInstance(
            name=slug,
            display_name=label,
            app_name=app_name,
            ssh_host=host,
            remote_hermes_path=remote_path,
            remote_profile=profile,
            hermes_home=root / "home",
            user_data=root / "user-data",
            runtime_root=self.runtime_root,
            canonical_exe=self.canonical_exe,
            named_exe=named_exe,
            launcher_dir=launcher_dir,
            launcher_exe=launcher_dir / f"{csharp_identifier(app_name)}.exe",
            shortcut_path=self.shortcut_dir / f"{stem}.lnk",
            manifest_path=root / "instance.json",
        )

    def build_launch_plan(self, instance: DesktopInstance) -> LaunchPlan:
        return LaunchPlan(
            executable=instance.named_exe,
            arguments=[f"--user-data-dir={instance.user_data}"],
            env={
                "HERMES_HOME": str(instance.hermes_home),
                "HERMES_DESKTOP_USER_DATA_DIR": str(instance.user_data),
                "HERMES_DESKTOP_HERMES_ROOT": str(instance.runtime_root),
                "HERMES_DESKTOP_APP_NAME": instance.app_name,
                "HERMES_DESKTOP_CWD": str(self.cwd),
            },
            cwd=str(self.cwd),
            use_shell_execute=False,
        )

    def render_launcher_source(self, instance: DesktopInstance) -> str:
        template = launcher_template_path().read_text(encoding="utf-8")
        replacements = {
            "{{CLASS_NAME}}": csharp_identifier(instance.app_name),
            "{{LAUNCHER_DIRECTORY}}": _csharp_verbatim(instance.launcher_dir),
            "{{SHARED_HERMES_EXE}}": _csharp_verbatim(instance.canonical_exe),
            "{{NAMED_HERMES_EXE}}": _csharp_verbatim(instance.named_exe),
            "{{HERMES_ROOT}}": _csharp_verbatim(instance.runtime_root),
            "{{HERMES_HOME}}": _csharp_verbatim(instance.hermes_home),
            "{{USER_DATA}}": _csharp_verbatim(instance.user_data),
            "{{WORKING_DIRECTORY}}": _csharp_verbatim(self.cwd),
            "{{APP_NAME}}": _csharp_verbatim(instance.app_name),
        }
        source = template
        for token, value in replacements.items():
            source = source.replace(token, value)
        if "{{" in source:
            raise DesktopInstanceError(
                "Launcher template still contains unreplaced placeholders."
            )
        return source

    def create(
        self,
        name: str,
        *,
        ssh_host: str,
        remote_hermes_path: str,
        remote_profile: str,
        display_name: str | None = None,
        skip_ssh_check: bool = False,
        install_shortcut: bool = True,
    ) -> DesktopInstance:
        self._require_windows("Creating an isolated Desktop instance")
        self._require_runtime()
        instance = self.build_instance(
            name,
            ssh_host=ssh_host,
            remote_hermes_path=remote_hermes_path,
            remote_profile=remote_profile,
            display_name=display_name,
        )
        if instance.manifest_path.exists():
            raise InstanceExistsError(
                f"Isolated Desktop instance {instance.name!r} already exists at "
                f"{instance.manifest_path}."
            )
        if not skip_ssh_check:
            self.ssh_probe(instance.ssh_host)

        instance.hermes_home.mkdir(parents=True, exist_ok=True)
        instance.user_data.mkdir(parents=True, exist_ok=True)
        instance.launcher_dir.mkdir(parents=True, exist_ok=True)
        self._seed_connection(instance)
        self._materialize_windows_bits(instance, install_shortcut=install_shortcut)
        self._write_manifest(instance)
        return instance

    def list(self) -> list[DesktopInstance]:
        root = self.registry_root
        if not root.is_dir():
            return []
        found: list[DesktopInstance] = []
        for entry in sorted(root.iterdir(), key=lambda path: path.name.lower()):
            manifest = entry / "instance.json"
            if not manifest.is_file():
                continue
            try:
                found.append(self._load_manifest(manifest))
            except ManifestError:
                continue
        return found

    def get(self, name: str) -> DesktopInstance:
        slug = validate_instance_name(name)
        manifest = self.instance_root(slug) / "instance.json"
        if not manifest.is_file():
            raise InstanceNotFoundError(
                f"Isolated Desktop instance {slug!r} was not found. "
                "Run `hermes desktop instance list`."
            )
        return self._load_manifest(manifest)

    def repair(self, name: str) -> HardlinkRefreshResult:
        self._require_windows("Repairing an isolated Desktop instance")
        self._require_runtime()
        instance = self.get(name)
        result = refresh_named_hardlink(
            self.canonical_exe,
            instance.named_exe,
            is_locked=self.is_locked,
        )
        self._compile_launcher(instance)
        return result

    def repair_all(self) -> list[tuple[DesktopInstance, HardlinkRefreshResult]]:
        self._require_windows("Repairing isolated Desktop instances")
        self._require_runtime()
        repaired: list[tuple[DesktopInstance, HardlinkRefreshResult]] = []
        compile_errors: list[str] = []
        for instance in self.list():
            result = refresh_named_hardlink(
                self.canonical_exe,
                instance.named_exe,
                is_locked=self.is_locked,
            )
            repaired.append((instance, result))
        for instance, _result in repaired:
            try:
                self._compile_launcher(instance)
            except DesktopInstanceError as exc:
                compile_errors.append(f"{instance.name}: {exc}")
        if compile_errors:
            raise DesktopInstanceError(
                "Hardlinks were refreshed, but some launchers failed to rebuild: "
                + "; ".join(compile_errors)
            )
        return repaired

    def launch(self, name: str) -> int:
        self._require_windows("Launching an isolated Desktop instance")
        self._require_runtime()
        instance = self.get(name)
        instance.hermes_home.mkdir(parents=True, exist_ok=True)
        instance.user_data.mkdir(parents=True, exist_ok=True)
        self.repair(name)
        plan = self.build_launch_plan(instance)
        if not plan.executable.is_file():
            raise StalePathError(
                f"Named Desktop executable is missing after repair: {plan.executable}"
            )
        return self.process_starter(plan)

    def install_shortcut(self, name: str) -> ShortcutSpec:
        self._require_windows("Installing an isolated Desktop shortcut")
        self._require_runtime()
        instance = self.get(name)
        self._materialize_windows_bits(instance, install_shortcut=True)
        return ShortcutSpec(
            path=instance.shortcut_path,
            target=str(instance.launcher_exe),
            icon=str(self.canonical_exe),
            working_directory=str(self.cwd),
            description=f"{instance.app_name} isolated Desktop",
        )

    def remove(
        self,
        name: str,
        *,
        purge_local: bool = False,
        force: bool = False,
    ) -> RemoveResult:
        instance = self.get(name)
        if (
            self.platform == "win32"
            and instance.named_exe.exists()
            and self.is_locked(instance.named_exe)
        ):
            if not force:
                raise InstanceLockedError(
                    f"{instance.app_name} appears to be running "
                    f"({instance.named_exe}). Close that window, or pass --force "
                    "to remove the launcher while leaving the process alone."
                )
        self._unlink_if_present(instance.shortcut_path)
        self._unlink_if_present(instance.launcher_exe)
        self._unlink_if_present(instance.launcher_exe.with_suffix(".cs"))
        if instance.named_exe.exists() and not self.is_locked(instance.named_exe):
            self._unlink_if_present(instance.named_exe)
        self._unlink_if_present(instance.manifest_path)
        if purge_local:
            shutil.rmtree(instance.hermes_home, ignore_errors=True)
            shutil.rmtree(instance.user_data, ignore_errors=True)
            shutil.rmtree(instance.launcher_dir, ignore_errors=True)
            root = self.instance_root(instance.name)
            if root.is_dir() and not any(root.rglob("*")):
                shutil.rmtree(root, ignore_errors=True)
        return RemoveResult(
            name=instance.name,
            remote_state_deleted=False,
            purged_local=purge_local,
        )

    def _materialize_windows_bits(
        self, instance: DesktopInstance, *, install_shortcut: bool
    ) -> None:
        refresh_named_hardlink(
            self.canonical_exe,
            instance.named_exe,
            is_locked=self.is_locked,
        )
        self._compile_launcher(instance)
        if install_shortcut:
            spec = ShortcutSpec(
                path=instance.shortcut_path,
                target=str(instance.launcher_exe),
                icon=str(self.canonical_exe),
                working_directory=str(self.cwd),
                description=f"{instance.app_name} isolated Desktop",
            )
            self.shortcut_writer(spec)

    def _compile_launcher(self, instance: DesktopInstance) -> None:
        instance.launcher_dir.mkdir(parents=True, exist_ok=True)
        self.compiler(self.render_launcher_source(instance), instance.launcher_exe)

    def _write_manifest(self, instance: DesktopInstance) -> None:
        payload = instance.to_manifest()
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        if not instance.manifest_path.exists():
            payload["created_at"] = payload["updated_at"]
        self._assert_no_secrets(payload)
        atomic_write_text(
            instance.manifest_path,
            json.dumps(payload, indent=2) + "\n",
            create_mode=0o600,
        )

    def _seed_connection(self, instance: DesktopInstance) -> None:
        seed_path = instance.user_data / "connection.json"
        if seed_path.exists():
            return
        payload = seed_connection_config(instance)
        self._assert_no_secrets(payload)
        atomic_write_text(
            seed_path,
            json.dumps(payload, indent=2) + "\n",
            create_mode=0o600,
        )

    def _load_manifest(self, path: Path) -> DesktopInstance:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ManifestError(
                f"Could not read instance manifest {path}: {exc}"
            ) from exc
        if not isinstance(data, dict):
            raise ManifestError(f"Instance manifest {path} is not an object.")
        version = data.get("version")
        if version != MANIFEST_VERSION:
            raise ManifestError(
                f"Unsupported isolated Desktop manifest version {version!r} in {path}."
            )
        required = (
            "name",
            "ssh_host",
            "remote_hermes_path",
            "remote_profile",
            "display_name",
            "app_name",
        )
        missing = [key for key in required if not data.get(key)]
        if missing:
            raise ManifestError(
                f"Instance manifest {path} is missing: {', '.join(missing)}."
            )
        return self.build_instance(
            str(data["name"]),
            ssh_host=str(data["ssh_host"]),
            remote_hermes_path=str(data["remote_hermes_path"]),
            remote_profile=str(data["remote_profile"]),
            display_name=str(data.get("display_name") or ""),
        )

    @staticmethod
    def _assert_no_secrets(payload: object) -> None:
        stack: list[object] = [payload]
        while stack:
            current = stack.pop()
            if isinstance(current, dict):
                for key, value in current.items():
                    if str(key).lower() in _SECRET_KEYS:
                        raise ManifestError(
                            f"Refusing to persist secret field {key!r} in an isolated Desktop file."
                        )
                    stack.append(value)
            elif isinstance(current, list):
                stack.extend(current)

    @staticmethod
    def _unlink_if_present(path: Path) -> None:
        try:
            path.unlink()
        except FileNotFoundError:
            return
        except OSError:
            return


def repair_instances_for_runtime(
    runtime_root: Path, canonical_exe: Path | None
) -> list[str]:
    """Best-effort hardlink refresh after the canonical Desktop exe is replaced."""
    if sys.platform != "win32" or canonical_exe is None:
        return []
    store = DesktopInstanceStore.from_defaults(
        runtime_root=runtime_root,
        canonical_exe=canonical_exe,
    )
    if not store.list():
        return []
    refreshed = []
    for instance, result in store.repair_all():
        state = "retained (running)" if result.retained_running else "refreshed"
        refreshed.append(f"{instance.name} ({state})")
    return refreshed


def cmd_desktop_instance(args, *, runtime_root: Path) -> None:
    """CLI handler for ``hermes desktop instance …``."""
    action = getattr(args, "instance_action", None)
    store = DesktopInstanceStore.from_defaults(
        runtime_root=Path(runtime_root),
        cwd=Path(args.cwd).expanduser().resolve()
        if getattr(args, "cwd", None)
        else None,
    )
    try:
        _dispatch_instance_action(store, args, action)
    except DesktopInstanceError as exc:
        print(f"✗ {exc}")
        sys.exit(1)
    except ValueError as exc:
        print(f"✗ {exc}")
        sys.exit(1)


def _dispatch_instance_action(
    store: DesktopInstanceStore, args, action: str | None
) -> None:
    if not action:
        print(
            "Usage: hermes desktop instance {create,list,show,launch,shortcut,repair,remove}"
        )
        print(
            "Isolated instances are a separate Desktop shell — not Settings → Connections."
        )
        sys.exit(2)

    if action == "list":
        instances = store.list()
        if not instances:
            print("No isolated Desktop instances are registered.")
            print(
                "Create one with: hermes desktop instance create NAME --ssh-host HOST "
                "--remote-hermes-path PATH --remote-profile PROFILE"
            )
            return
        print(
            "Isolated Desktop instances (separate shells; remote state stays remote):\n"
        )
        for instance in instances:
            print(
                f"  {instance.name:16}  {instance.app_name}  "
                f"ssh:{instance.ssh_host}  remote-profile:{instance.remote_profile}"
            )
        return

    if action == "create":
        instance = store.create(
            args.instance_name,
            ssh_host=args.ssh_host,
            remote_hermes_path=args.remote_hermes_path,
            remote_profile=args.remote_profile,
            display_name=getattr(args, "display_name", None),
            skip_ssh_check=bool(getattr(args, "skip_ssh_check", False)),
            install_shortcut=not bool(getattr(args, "no_shortcut", False)),
        )
        print(f"✓ Isolated Desktop instance {instance.name!r} ready")
        print(f"  App name:        {instance.app_name}")
        print(f"  SSH host:        {instance.ssh_host}")
        print(f"  Remote Hermes:   {instance.remote_hermes_path}")
        print(f"  Remote profile:  {instance.remote_profile}")
        print(f"  Local home:      {instance.hermes_home}")
        print(f"  Electron data:   {instance.user_data}")
        print(f"  Shared runtime:  {instance.runtime_root}")
        print(f"  Shortcut:        {instance.shortcut_path}")
        print("  Remote sessions, memory, skills, and credentials were not copied.")
        print(f"Launch with: hermes desktop instance launch {instance.name}")
        return

    if action == "show":
        instance = store.get(args.instance_name)
        print(json.dumps(instance.to_manifest(), indent=2))
        return

    if action == "launch":
        pid = store.launch(args.instance_name)
        instance = store.get(args.instance_name)
        print(f"→ Launched {instance.app_name} (pid {pid})")
        return

    if action == "shortcut":
        spec = store.install_shortcut(args.instance_name)
        print(f"✓ Shortcut installed: {spec.path}")
        return

    if action == "repair":
        if getattr(args, "all_instances", False):
            repaired = store.repair_all()
            if not repaired:
                print("No isolated Desktop instances to repair.")
                return
            for instance, result in repaired:
                note = (
                    "retained running image"
                    if result.retained_running
                    else "hardlink refreshed"
                )
                print(f"✓ {instance.name}: {note}")
            return
        if not getattr(args, "instance_name", None):
            raise DesktopInstanceError("Pass an instance name or --all.")
        result = store.repair(args.instance_name)
        note = (
            "retained running image"
            if result.retained_running
            else "hardlink refreshed"
        )
        print(f"✓ {args.instance_name}: {note}")
        return

    if action == "remove":
        result = store.remove(
            args.instance_name,
            purge_local=bool(getattr(args, "purge_local", False)),
            force=bool(getattr(args, "force", False)),
        )
        print(
            f"✓ Removed launcher/shortcut for {result.name!r}. "
            "Remote Hermes state was not deleted."
        )
        if result.purged_local:
            print("  Local isolated home and Electron userData were deleted.")
        else:
            print(
                "  Local isolated home/userData were kept. Pass --purge-local to delete them."
            )
        return

    raise DesktopInstanceError(f"Unknown instance action {action!r}.")
