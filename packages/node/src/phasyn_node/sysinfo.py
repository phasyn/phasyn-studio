"""主機事實：platform 標籤、程式來源 revision、元件程序的最小環境變數."""

from __future__ import annotations

import hashlib
import importlib.util
import os
import platform
import shutil
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components.runtime_env import (
    OFFLINE_ENV,
    PASSTHROUGH_ENV,
    RUNTIME_ID_ENV,
    SOURCE_REVISION_ENV,
)

from .config import RuntimeEntry


SOURCE_PACKAGES = ("phasyn_components", "phasyn_node", "phasyn_media")


def platform_tag() -> str:
    """例如 ``linux-x86_64``、``linux-aarch64``、``darwin-arm64``."""
    machine = platform.machine().lower() or "unknown"
    if machine == "amd64":
        machine = "x86_64"
    if machine == "arm64" and sys.platform.startswith("linux"):
        machine = "aarch64"
    system = "linux" if sys.platform.startswith("linux") else sys.platform
    return f"{system}-{machine}"


def _git_revision(start: Path) -> str | None:
    root = None
    for parent in [start, *start.parents]:
        if (parent / ".git").exists():
            root = parent
            break
    if root is None:
        return None
    search_path = os.pathsep.join(
        entry for entry in os.get_exec_path() if Path(entry).is_absolute()
    )
    git = shutil.which("git", path=search_path)
    if git is None:
        return None
    try:
        head = subprocess.run(  # noqa: S603 — absolute executable from the service PATH, fixed read-only arguments.
            [git, "--no-optional-locks", "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if head.returncode != 0:
            return None
        status = subprocess.run(  # noqa: S603 — fixed status arguments and repository helpers disabled.
            [
                git,
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                "status",
                "--porcelain",
                "--untracked-files=no",
            ],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    sha = head.stdout.strip()
    if not sha:
        return None
    dirty = status.returncode != 0 or bool(status.stdout.strip())
    return f"git-{sha}{'+dirty' if dirty else ''}"


def _package_dir(name: str) -> Path | None:
    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, ValueError):
        return None
    if spec is None or not spec.submodule_search_locations:
        return None
    return Path(next(iter(spec.submodule_search_locations)))


def _source_digest() -> str:
    hasher = hashlib.sha256()
    for name in SOURCE_PACKAGES:
        directory = _package_dir(name)
        if directory is None:
            continue
        for path in sorted(directory.rglob("*.py")):
            try:
                data = path.read_bytes()
            except OSError:
                continue
            hasher.update(f"{name}/{path.relative_to(directory).as_posix()}\0".encode())
            hasher.update(hashlib.sha256(data).digest())
    return "src-" + hasher.hexdigest()[:16]


def source_revision() -> str:
    """程式來源識別：repo 的 git HEAD（+dirty）；無 git/無 commit 時改用 phasyn_* 套件 .py 的 SHA-256."""
    here = Path(__file__).resolve().parent
    return _git_revision(here) or _source_digest()


def runtime_env(
    runtime: RuntimeEntry, *, device: Mapping[str, Any] | None, source_rev: str
) -> dict[str, str]:
    """元件程序環境：最小白名單 + 離線設定 + runtime.env + 只看見自己的裝置。不繼承 token/proxy 等其他變數."""
    env = {k: os.environ[k] for k in PASSTHROUGH_ENV if k in os.environ}
    env.setdefault("PATH", os.defpath)
    env["PYTHONUNBUFFERED"] = "1"
    env.update(
        OFFLINE_ENV
    )  # a component reads local files only; the runtime's own env may still override
    env.update(runtime.env)
    kind = str((device or {}).get("kind") or "cpu")
    if kind == "cuda":
        env["CUDA_VISIBLE_DEVICES"] = str((device or {}).get("id") or "")
        env.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
    else:
        env["CUDA_VISIBLE_DEVICES"] = ""
    env[RUNTIME_ID_ENV] = runtime.runtime_id
    env[SOURCE_REVISION_ENV] = source_rev
    return env


__all__ = ["platform_tag", "runtime_env", "source_revision"]
