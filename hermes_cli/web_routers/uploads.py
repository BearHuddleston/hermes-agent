"""Authenticated browser-to-host attachment staging for Hermes Webapp."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import re
import secrets
import stat
import time

from fastapi import APIRouter, File, HTTPException, UploadFile

from hermes_constants import WEBAPP_ATTACHMENT_MAX_BYTES
from hermes_cli.web_deps import late


router = APIRouter()
_profile_scope = late("_profile_scope")
_MAX_UPLOAD_BYTES = WEBAPP_ATTACHMENT_MAX_BYTES
_CHUNK_BYTES = 1024 * 1024
_UPLOAD_RETENTION_SECONDS = 7 * 24 * 60 * 60
_SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename(value: str | None) -> str:
    name = Path(str(value or "attachment")).name
    clean = _SAFE_FILENAME.sub("-", name).strip(".-")
    return (clean or "attachment")[-120:]


def _prune_stale_uploads(root: Path, *, now: float | None = None) -> None:
    """Bound abandoned browser-picker staging without following symlinks."""
    cutoff = (time.time() if now is None else now) - _UPLOAD_RETENTION_SECONDS
    try:
        entries = list(root.iterdir())
    except OSError:
        return
    for entry in entries:
        if not entry.name.startswith("web-"):
            continue
        try:
            metadata = entry.stat(follow_symlinks=False)
            if stat.S_ISREG(metadata.st_mode) and metadata.st_mtime < cutoff:
                entry.unlink()
        except OSError:
            continue


@router.post("/api/chat/file-upload")
async def upload_chat_file(
    file: UploadFile = File(...),
    profile: str | None = None,
):
    """Stage one user-selected browser file under the active Hermes profile.

    The client never chooses a server path. A unique 0600 file under
    ``$HERMES_HOME/uploads`` is returned for the existing ``file.attach`` flow.
    """
    from hermes_constants import get_hermes_home, named_profile_home_is_unavailable

    def _upload_root() -> Path:
        # Resolve and create the child while holding the shared profile scope.
        # ``parents=False`` is load-bearing: if profile DELETE wins after
        # resolution, this operation fails instead of recreating the named home.
        # The lock is released before any await/file streaming.
        with _profile_scope(profile) as scoped_home:
            home = Path(scoped_home or get_hermes_home())
            if named_profile_home_is_unavailable(home):
                raise HTTPException(status_code=404, detail="Profile home is unavailable")
            root = home / "uploads"
            try:
                root.mkdir(parents=False, exist_ok=True, mode=0o700)
                root.chmod(0o700)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail="Profile home is unavailable") from exc
            except PermissionError as exc:
                raise HTTPException(status_code=403, detail="Upload directory is not writable") from exc
            except OSError as exc:
                raise HTTPException(status_code=500, detail=f"Could not create upload directory: {exc}") from exc
            if named_profile_home_is_unavailable(home):
                raise HTTPException(status_code=404, detail="Profile home is unavailable")
            _prune_stale_uploads(root)
            return root

    upload_root = await asyncio.to_thread(_upload_root)
    target = upload_root / f"web-{secrets.token_hex(8)}-{_safe_filename(file.filename)}"
    fd = -1
    total = 0
    completed = False
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            fd = -1
            while True:
                chunk = await file.read(_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > _MAX_UPLOAD_BYTES:
                    cap_mib = _MAX_UPLOAD_BYTES // (1024 * 1024)
                    raise HTTPException(
                        status_code=413,
                        detail=f"File is too large; cap is {cap_mib} MiB",
                    )
                await asyncio.to_thread(handle.write, chunk)
            await asyncio.to_thread(handle.flush)
            await asyncio.to_thread(os.fsync, handle.fileno())
        profile_home = upload_root.parent
        if (
            named_profile_home_is_unavailable(profile_home)
            or not target.is_file()
        ):
            raise HTTPException(status_code=404, detail="Profile was deleted during upload")
        completed = True
    except HTTPException:
        raise
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Profile upload directory disappeared") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not stage file: {exc}") from exc
    finally:
        if fd >= 0:
            os.close(fd)
        if not completed:
            target.unlink(missing_ok=True)
        await file.close()

    return {"ok": True, "path": str(target), "size": total}
