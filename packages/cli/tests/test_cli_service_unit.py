"""``phasyn-studio service``: unit naming and rendering, opt-in registry, and exit codes.

Never touches the real systemd: HOME / XDG_CONFIG_HOME point into tmp_path and every subprocess goes
through a fake ``service._run``.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest
from phasyn_cli import main as cli
from phasyn_cli import service

SHOW = "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n"

Responder = Callable[[list[str]], subprocess.CompletedProcess[str] | None]


def test_unit_name_and_text(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    assert service.unit_name("node", "workstation") == "phasyn-studio-node@workstation.service"
    for bad in ("Bad_Name", "-x", "1gpu", "a" * 49):
        with pytest.raises(service.ServiceError) as info:
            service.unit_name("node", bad)
        assert info.value.exit_code == service.EXIT_USAGE
    tools = tmp_path / "tools-bin"
    monkeypatch.setattr(
        service.shutil, "which", lambda name: str(tools / name) if name in ("ffmpeg", "ffprobe") else None
    )
    config = tmp_path / "my configs" / "node 100%.json"
    text = service.unit_text("node", "gpu-1", config, python_bin=Path("/venv/bin/python"))
    lines = text.splitlines()
    path_line = next(line for line in lines if line.startswith('Environment="PATH='))
    entries = path_line.removeprefix('Environment="PATH=').removesuffix('"').split(":")
    assert entries[0] == str(tools) and entries.count(str(tools)) == 1
    assert str(Path.home() / ".local" / "bin") in entries and "/usr/bin" in entries
    # Paths with blanks are quoted, and specifiers (%) are escaped so systemd passes them verbatim.
    assert (
        f'ExecStart=/venv/bin/python -m phasyn_cli.main node --config "{tmp_path}/my configs/node 100%%.json"' in lines
    )
    assert f"WorkingDirectory={tmp_path}/my configs" in lines
    assert "SyslogIdentifier=phasyn-studio-node-gpu-1" in lines
    assert "Restart=no" in lines and "KillMode=control-group" in lines
    assert str(Path(__file__).resolve().parents[3]) not in text  # nothing points into a source checkout


def test_exec_word_quoting() -> None:
    assert service.exec_word("/a/b") == "/a/b"
    assert service.exec_word("/a b") == '"/a b"'
    assert service.exec_word('/a"b') == '"/a\\"b"'
    assert service.exec_word("/x$HOME") == "/x$$HOME"
    with pytest.raises(service.ServiceError):
        service.exec_word("/a\nb")


class FakeSystem:
    """Records every command; ``respond`` may override the default (success) result per command."""

    def __init__(self, respond: Responder | None = None) -> None:
        self.calls: list[list[str]] = []
        self.respond = respond

    def __call__(self, argv: Sequence[str], *, check: bool) -> subprocess.CompletedProcess[str]:
        args = list(argv)
        self.calls.append(args)
        result = self.respond(args) if self.respond is not None else None
        if result is None:
            stdout = SHOW if "show" in args else ("enabled\n" if "is-enabled" in args else "")
            if "--version" in args:
                stdout = "systemd 257 (257.9)\n"
            result = subprocess.CompletedProcess(args, 0, stdout, "")
        if check and result.returncode != 0:
            raise service.ServiceError(f"{' '.join(args)} 失敗", service.EXIT_FAILED)
        return result

    def ran(self, *words: str) -> bool:
        return any(all(word in call for word in words) for call in self.calls)


@pytest.fixture
def home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    monkeypatch.setattr(service.shutil, "which", lambda name: f"/usr/bin/{name}")
    return home


def _install(system: FakeSystem, monkeypatch: pytest.MonkeyPatch, config: Path, *extra: str) -> int:
    monkeypatch.setattr(service, "_run", system)
    argv = ["service", "install", "--role", "node", "--instance", "workstation", "--config", str(config), *extra]
    return cli.main(argv)


def test_install_writes_only_the_unit_unless_a_registry_is_requested(
    home: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config = tmp_path / "node.json"
    config.write_text("{}", encoding="utf-8")
    system = FakeSystem()
    assert _install(system, monkeypatch, config, "--start", "--enable") == 0
    unit = home / ".config" / "systemd" / "user" / "phasyn-studio-node@workstation.service"
    assert unit.is_file() and f"--config {config}" in unit.read_text(encoding="utf-8")
    assert system.ran("systemd-analyze", "verify") and system.ran("daemon-reload") and system.ran("start")
    summary = json.loads(capsys.readouterr().out.split("\n提醒")[0])
    assert summary["unit"] == unit.name and summary["status"] == "deployed" and "manifest" not in summary
    written = {p.relative_to(home).as_posix() for p in home.rglob("*") if p.is_file()}
    assert written == {f".config/systemd/user/{unit.name}"}  # no registry files by default

    registry = tmp_path / "registry"
    assert _install(FakeSystem(), monkeypatch, config, "--registry-dir", str(registry)) == 0
    manifests = list((registry / "services").glob("*.json"))
    assert len(manifests) == 1 and len(list((registry / "receipts").glob("*.json"))) == 1
    manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
    assert manifest["manager"]["native_name"] == unit.name and manifest["execution"]["config_ref"] == str(config)
    assert _install(FakeSystem(), monkeypatch, config, "--registry-dir", str(registry)) == 0
    assert list((registry / "services").glob("*.json")) == manifests  # same unit → same service id
    assert len(list((registry / "receipts").glob("*.json"))) == 2


def test_verification_and_service_manager_failures_map_to_exit_codes(
    home: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config = tmp_path / "node.json"
    config.write_text("{}", encoding="utf-8")
    unit = home / ".config" / "systemd" / "user" / "phasyn-studio-node@workstation.service"

    def warn(args: list[str]) -> subprocess.CompletedProcess[str] | None:
        return subprocess.CompletedProcess(args, 0, "", "note: harmless") if "verify" in args else None

    assert _install(FakeSystem(warn), monkeypatch, config) == 0
    out, err = capsys.readouterr()
    assert json.loads(out)["warnings"] == ["note: harmless"] and "verification_failed" not in err
    unit.unlink()

    def invalid(args: list[str]) -> subprocess.CompletedProcess[str] | None:
        return subprocess.CompletedProcess(args, 1, "", "bad unit") if "verify" in args else None

    assert _install(FakeSystem(invalid), monkeypatch, config) == service.EXIT_USAGE
    assert "verification_failed：bad unit" in capsys.readouterr().err and not unit.exists()

    def reload_fails(args: list[str]) -> subprocess.CompletedProcess[str] | None:
        return subprocess.CompletedProcess(args, 1, "", "no bus") if "daemon-reload" in args else None

    assert _install(FakeSystem(reload_fails), monkeypatch, config) == service.EXIT_FAILED
    assert "daemon-reload" in capsys.readouterr().err

    monkeypatch.setattr(service.shutil, "which", lambda name: None)
    assert _install(FakeSystem(), monkeypatch, config) == service.EXIT_UNSUPPORTED


def test_status_and_uninstall(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    unit_dir = home / ".config" / "systemd" / "user"
    unit_dir.mkdir(parents=True)
    unit = unit_dir / "phasyn-studio-controller@workstation.service"
    unit.write_text("[Unit]\n", encoding="utf-8")
    system = FakeSystem()
    monkeypatch.setattr(service, "_run", system)
    assert cli.main(["service", "status", "--role", "controller", "--instance", "workstation"]) == 0
    assert cli.main(["service", "uninstall", "--role", "controller", "--instance", "workstation"]) == 0
    assert system.ran("disable", "--now", unit.name) and not unit.exists()
    assert cli.main(["service", "status", "--role", "node", "--instance", "Bad_Name"]) == service.EXIT_USAGE
