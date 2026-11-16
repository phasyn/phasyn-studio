"""systemd user services for the controller and the node (``phasyn-studio service``).

Each installed service is a concrete unit file ``phasyn-studio-<role>@<instance>.service`` in the user's
systemd directory. The ``role@instance`` form keeps several nodes on one host apart and lets
``systemctl --user list-units 'phasyn-studio-*'`` find them all; the file is written per instance (not as a
template) because every instance points at its own config file.

Installing never happens implicitly: the user runs ``service install`` explicitly; ``--start`` and
``--enable`` are separate opt-ins. The unit only supervises the controller/node root process and never
restarts it automatically (component processes are children of the node and stop with its cgroup).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from phasyn_components.fs import atomic_write_bytes

PROJECT = "phasyn-studio"
ROLES = ("controller", "node")
DOCUMENTATION_URL = "https://github.com/phasyn/phasyn-studio"
SYSTEM_PATH = ("/usr/local/bin", "/usr/bin", "/bin")
STOP_TIMEOUT_S = 90
INSTANCE_MAX = 48
_INSTANCE_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
# Characters that make an ExecStart= word ambiguous unless it is quoted.
_NEEDS_QUOTES = frozenset(" \t\"'\\;")

EXIT_USAGE = 2
EXIT_UNSUPPORTED = 3
EXIT_FAILED = 4

SHOW_PROPERTIES = ("LoadState", "ActiveState", "SubState", "MainPID", "InvocationID", "UnitFileState", "FragmentPath")


class ServiceError(Exception):
    """A service command failed; ``exit_code`` is the CLI exit status (2 usage, 3 unsupported, 4 failed)."""

    def __init__(self, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code


@dataclass(frozen=True)
class InstallReport:
    unit: str
    path: Path
    verified: bool
    state: dict[str, str]
    enabled: str
    steps: tuple[str, ...]
    warnings: tuple[str, ...]


# ---------------------------------------------------------------------- naming / rendering
def unit_name(role: str, instance: str) -> str:
    """``phasyn-studio-<role>@<instance>.service``; the instance is a lowercase slug (e.g. ``workstation``)."""
    if role not in ROLES:
        raise ServiceError(f"role 必須是 {'、'.join(ROLES)} 之一：{role!r}", EXIT_USAGE)
    if len(instance) > INSTANCE_MAX or not _INSTANCE_RE.fullmatch(instance):
        raise ServiceError(
            f"實例名稱不合法：{instance!r}（小寫英數字、以字母開頭、以連字號分隔，最多 {INSTANCE_MAX} 字）", EXIT_USAGE
        )
    return f"{PROJECT}-{role}@{instance}.service"


def _plain(value: str, what: str) -> str:
    if not value or any(ch in value for ch in "\n\r\0"):
        raise ServiceError(f"{what} 不能是空字串，也不能包含換行或 NUL：{value!r}", EXIT_USAGE)
    return value


def exec_word(value: str) -> str:
    """One ExecStart= argument: ``%`` and ``$`` are always escaped; quoted when it contains blanks or quotes."""
    text = _plain(value, "ExecStart 參數").replace("%", "%%").replace("$", "$$")
    if not any(ch in _NEEDS_QUOTES for ch in text):
        return text
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def quoted_assignment(value: str) -> str:
    """A whole ``Environment=`` assignment in double quotes (specifiers escaped; ``$`` has no meaning there)."""
    text = _plain(value, "Environment 值").replace("%", "%%")
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def path_value(path: Path) -> str:
    """A path-valued setting (WorkingDirectory=): taken verbatim except for specifiers."""
    return _plain(str(path), "路徑").replace("%", "%%")


def service_path() -> str:
    """PATH for the unit: directories holding ffmpeg/ffprobe at install time, ``~/.local/bin``, system dirs.

    The systemd user manager's PATH usually lacks ``~/.local/bin``; component processes find FFmpeg via PATH.
    Paths are not resolved, so stable entry points such as ``~/.local/bin`` stay as they are.
    """
    dirs: list[str] = []
    for tool in ("ffmpeg", "ffprobe"):
        found = shutil.which(tool)
        if found:
            dirs.append(str(Path(found).parent))
    dirs += [str(Path.home() / ".local" / "bin"), *SYSTEM_PATH]
    return ":".join(dict.fromkeys(d for d in dirs if d and ":" not in d))


def unit_text(role: str, instance: str, config: Path, *, python_bin: Path | None = None) -> str:
    """The unit file. WorkingDirectory is the config file's directory (relative paths in it resolve there)."""
    name = unit_name(role, instance)
    exe = python_bin or Path(sys.executable)
    if not exe.is_absolute() or not config.is_absolute():
        raise ServiceError("python 與設定檔路徑都必須是絕對路徑", EXIT_USAGE)
    title = "Controller" if role == "controller" else "Node"
    command = " ".join(exec_word(arg) for arg in (str(exe), "-m", "phasyn_cli.main", role, "--config", str(config)))
    identifier = name.removesuffix(".service").replace("@", "-")
    return f"""[Unit]
Description=Phasyn Studio {title} ({instance})
Documentation={DOCUMENTATION_URL}
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
WorkingDirectory={path_value(config.parent)}
ExecStart={command}
Environment={quoted_assignment(f"PATH={service_path()}")}
Environment=PYTHONUNBUFFERED=1
SyslogIdentifier={identifier}
StandardOutput=journal
StandardError=journal
# Supervise only the controller/node root process; component processes are node children and stop with the cgroup.
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec={STOP_TIMEOUT_S}s
# Never restart automatically: a failure is inspected in the journal and restarted by the user.
Restart=no
MemoryAccounting=true
TasksAccounting=true
NoNewPrivileges=true
UMask=0077
# GPU work: no PrivateDevices=/ProtectSystem= sandboxing that would hide devices or model paths.

[Install]
WantedBy=default.target
"""


# ---------------------------------------------------------------------- systemd interaction
def user_unit_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "systemd" / "user"


def _run(argv: Sequence[str], *, check: bool) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(list(argv), capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        raise ServiceError(f"找不到 {argv[0]}：此主機不支援 systemd user service", EXIT_UNSUPPORTED) from exc
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise ServiceError(f"{' '.join(argv)} 失敗（exit {result.returncode}）：{detail}", EXIT_FAILED)
    return result


def systemctl(*argv: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return _run(["systemctl", "--user", *argv], check=check)


def require_systemd() -> None:
    if shutil.which("systemctl") is None:
        raise ServiceError(
            "supervisor_unsupported：此主機沒有 systemctl（macOS 請用 launchd，或以前景方式執行）", EXIT_UNSUPPORTED
        )


def verify(name: str, text: str) -> tuple[str, ...]:
    """``systemd-analyze --user verify`` on a staged copy; returns warnings, raises when verification fails."""
    with tempfile.TemporaryDirectory(prefix="phasyn-unit-") as tmp:
        staged = Path(tmp) / name
        staged.write_text(text, encoding="utf-8")
        result = _run(["systemd-analyze", "--user", "verify", "--recursive-errors=no", str(staged)], check=False)
    output = (result.stderr or result.stdout).strip()
    if result.returncode != 0:
        raise ServiceError(f"verification_failed：{output}", EXIT_USAGE)
    return tuple(line for line in output.splitlines() if line.strip())


def write_unit(path: Path, text: str) -> None:
    """Publish the unit atomically inside the target directory (``/tmp`` may be another filesystem)."""
    atomic_write_bytes(path, text.encode("utf-8"))


def show(name: str) -> dict[str, str]:
    argv = ["show", name]
    for prop in SHOW_PROPERTIES:
        argv += ["-p", prop]
    output = systemctl(*argv, check=False).stdout
    return dict(line.split("=", 1) for line in output.splitlines() if "=" in line)


def install(role: str, instance: str, config: Path, *, start: bool, enable: bool) -> InstallReport:
    name = unit_name(role, instance)
    text = unit_text(role, instance, config)
    require_systemd()
    warnings = verify(name, text)
    steps = ["prepared", "validated"]
    path = user_unit_dir() / name
    write_unit(path, text)
    steps.append("installed")
    systemctl("daemon-reload")
    steps.append("daemon_reloaded")
    if start:
        systemctl("start", name)
        steps.append("started")
    if enable:
        systemctl("enable", name)
        steps.append("enabled")
    state = show(name)
    enabled = systemctl("is-enabled", name, check=False).stdout.strip()
    verified = state.get("LoadState") == "loaded" and (not start or state.get("ActiveState") == "active")
    if verified:
        steps.append("verified")
    return InstallReport(name, path, verified, state, enabled, tuple(steps), warnings)


def linger_enabled() -> bool:
    user = os.environ.get("USER", "")
    result = _run(["loginctl", "show-user", user, "--property=Linger"], check=False)
    return result.stdout.strip() == "Linger=yes"


def status(role: str, instance: str) -> tuple[int, str]:
    result = systemctl("status", "--no-pager", unit_name(role, instance), check=False)
    return result.returncode, result.stdout or result.stderr


def uninstall(role: str, instance: str) -> Path:
    """Stop, disable and remove the unit file; returns the removed path (missing units are fine)."""
    name = unit_name(role, instance)
    require_systemd()
    systemctl("disable", "--now", name, check=False)
    path = user_unit_dir() / name
    path.unlink(missing_ok=True)
    systemctl("daemon-reload", check=False)
    return path


def describe(report: InstallReport) -> dict[str, Any]:
    return {
        "unit": report.unit,
        "path": str(report.path),
        "status": "deployed" if report.verified else "partial",
        "state": report.state,
        "enabled": report.enabled,
        "warnings": list(report.warnings),
    }


__all__ = [
    "EXIT_FAILED",
    "EXIT_UNSUPPORTED",
    "EXIT_USAGE",
    "PROJECT",
    "ROLES",
    "InstallReport",
    "ServiceError",
    "describe",
    "exec_word",
    "install",
    "linger_enabled",
    "service_path",
    "status",
    "uninstall",
    "unit_name",
    "unit_text",
    "user_unit_dir",
    "verify",
]
