"""The main/desktop composition keeps credential and incarnation exclusions."""
import tarfile
from pathlib import Path

import pytest


@pytest.mark.parametrize("name", ["default", "alpha"])
def test_export_excludes_nested_credentials_and_incarnation(monkeypatch, tmp_path, name):
    from hermes_cli.profile_incarnation import PROFILE_INCARNATION_FILENAME
    from hermes_cli.profiles import export_profile

    root = tmp_path / ".hermes"
    home = root if name == "default" else root / "profiles" / name
    home.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(root))
    (home / "config.yaml").write_text("{}\n")
    (home / PROFILE_INCARNATION_FILENAME).write_text("0" * 32 + "\n")
    secret = home / "skills/demo/.config/gh/hosts.yml"
    safe = home / "skills/demo/.config/other/settings.json"
    for path in [secret, safe]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("disposable-test-sentinel")
    archive = export_profile(name, str(tmp_path / f"{name}.tar.gz"))
    with tarfile.open(archive) as bundle:
        names = bundle.getnames()
        assert not any(n.endswith(".config/gh/hosts.yml") for n in names)
        assert not any(n.endswith(PROFILE_INCARNATION_FILENAME) for n in names)
        kept = next(n for n in names if n.endswith(".config/other/settings.json"))
        assert bundle.extractfile(kept).read() == safe.read_bytes()
    assert secret.read_text() == "disposable-test-sentinel"
