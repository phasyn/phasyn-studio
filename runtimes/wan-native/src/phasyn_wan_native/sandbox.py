"""Run a single offline native CUDA call with only its input media and pinned checkpoint mounted."""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from phasyn_components.errors import ComponentError
from phasyn_media.tools import find_ffmpeg, find_ffprobe, run_tool


if TYPE_CHECKING:
    from phasyn_components.provider import RunContext

    from .sources import Installation


# Both paths are empty tmpfs mounts inside the private child namespace.
_CHILD_TMP = "/tmp"  # noqa: S108
_CHILD_SHM = "/dev/shm"  # noqa: S108


def _gpu_device(identifier: str) -> Path:
    if re.fullmatch(r"[0-9]+", identifier):
        path = Path("/dev") / f"nvidia{identifier}"
        if path.is_char_device():
            return path
    elif identifier.startswith("GPU-"):
        for info in Path("/proc/driver/nvidia/gpus").glob("*/information"):
            fields = dict(
                line.split(":", 1)
                for line in info.read_text().splitlines()
                if ":" in line
            )
            minor = fields.get("Device Minor", "").strip()
            if fields.get("GPU UUID", "").strip() == identifier and minor.isdecimal():
                return Path("/dev") / f"nvidia{minor}"
    raise ComponentError("INVALID_ARGUMENT", "未能辨認指派給 Wan 的單張 NVIDIA GPU")


def _system() -> list[str]:
    args: list[str] = []
    for name in (
        "/usr",
        "/lib",
        "/lib64",
        "/bin",
        "/etc/ld.so.cache",
        "/sys",
        sys.base_prefix,
        sys.prefix,
    ):
        path = Path(name)
        if path.exists() and name not in args:
            if path.is_symlink():
                args.extend(["--symlink", str(path.readlink()), name])
            elif name == "/usr" or name not in {"/", "/usr/local"}:
                args.extend(["--ro-bind", name, name])
    return args


def _command(
    gpu: str,
    engine: Path,
    workspace: Path,
    mounts: dict[str, Path],
    *,
    prepared_controls: bool = False,
) -> list[str]:
    bwrap = shutil.which("bwrap")
    if not bwrap or gpu != os.environ.get("CUDA_VISIBLE_DEVICES"):
        raise ComponentError(
            "COMPONENT_NOT_READY", "Wan 需要 bubblewrap 與 Node 指派的獨占可見 GPU"
        )
    command = [
        bwrap,
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        _CHILD_TMP,
        "--tmpfs",
        _CHILD_SHM,
        *_system(),
        "--ro-bind-try",
        "/proc/driver/nvidia",
        "/proc/driver/nvidia",
        "--dir",
        "/input",
        "--dir",
        "/weights",
        "--dir",
        "/tools",
        "--ro-bind",
        find_ffmpeg(),
        "/tools/ffmpeg",
        "--ro-bind",
        find_ffprobe(),
        "/tools/ffprobe",
        "--ro-bind",
        str(engine),
        "/engine",
        "--ro-bind",
        str(Path(__file__).with_name("driver.py")),
        "/driver.py",
        "--ro-bind",
        str(Path(__file__).with_name("offload.py")),
        "/offload.py",
        "--bind",
        str(workspace),
        "/job",
        "--chdir",
        "/job",
    ]
    devices = [
        _gpu_device(gpu),
        Path("/dev/nvidiactl"),
        Path("/dev/nvidia-modeset"),
        Path("/dev/nvidia-uvm"),
        Path("/dev/nvidia-uvm-tools"),
    ]
    for device in devices:
        if device.is_char_device():
            command.extend(["--dev-bind", str(device), str(device)])
    for target, source in mounts.items():
        command.extend(["--ro-bind", str(source), target])
    environment = {
        "PATH": f"/tools:{sys.prefix}/bin:/usr/bin:/bin",
        "HOME": "/job",
        "TMPDIR": _CHILD_TMP,
        "XDG_CACHE_HOME": "/job/cache",
        "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
        "CUDA_VISIBLE_DEVICES": gpu,
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "TORCH_FORCE_WEIGHTS_ONLY_LOAD": "1",
        "IMAGEIO_FFMPEG_EXE": "/tools/ffmpeg",
        "MPLCONFIGDIR": "/job/mpl",
        "NUMBA_CACHE_DIR": "/job/cache/numba",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    for key, value in environment.items():
        command.extend(["--setenv", key, value])
    entrypoint = ["/driver.py"]
    if prepared_controls:
        # On a cache miss the official preprocessor imports OpenCV before Wan imports Decord.
        # Preserve that order on reuse: Decord's zlib otherwise breaks OpenCV's PNG reader.
        entrypoint = [
            "-c",
            "import cv2\nimport runpy\nrunpy.run_path('/driver.py', run_name='__main__')",
        ]
    return [*command, sys.executable, "-I", "-B", *entrypoint]


def _run(
    command: list[str], *, timeout: float, cancel: object | None, preflight: bool
) -> None:
    result = run_tool(
        command,
        timeout=timeout,
        cancel=cancel,
        what="Wan2.2",
        max_stdout_bytes=512 * 1024,
        max_stderr_bytes=64 * 1024,
        stdout_sink=lambda _data: None,
    )
    if result.returncode == 0:
        return
    # Do not return private paths, prompts or arbitrary text from dependencies.
    tags = re.findall(
        r"^PHASYN_WAN_ERROR ([A-Za-z]+) ([A-Za-z]+) ([A-Za-z0-9_.-]+) ([A-Za-z0-9_.-]+)$",
        result.stderr,
        re.MULTILINE,
    )
    details: dict[str, Any] = {"returncode": result.returncode}
    if tags:
        phase, failure, dependency, site = tags[-1]
        details.update(phase=phase, failure=failure, source_location=site)
        if dependency != "-":
            details["package"] = dependency
    else:
        details["phase"] = "launcher"
    if details.get("phase") == "integrity":
        raise ComponentError(
            "INTEGRITY_MISMATCH",
            "已驗證的 Wan 權重發生變更，請還原官方版本並重新載入元件",
            details=details,
        )
    if details.get("failure") == "OutOfMemoryError":
        raise ComponentError(
            "RESOURCE_EXHAUSTED",
            "Wan 的 GPU 記憶體不足。可使用 disk_blocks、較短的 chunk_frames 或較小的畫面再產生候選。",
            details=details,
        )
    if preflight:
        raise ComponentError(
            "COMPONENT_NOT_READY",
            "Wan 啟動檢查失敗，請檢查隔離環境、套件版本與 CUDA 裝置",
            details=details,
        )
    raise ComponentError("RUNTIME_ERROR", "Wan 原生執行失敗", details=details)


def preflight(gpu: str, engine: Path, workspace: Path, role: str) -> dict[str, Any]:
    """Import the pinned model and run a tiny native FA2 operation with no model mounts."""
    (workspace / "options.json").write_text(
        json.dumps({"preflight": True, "role": role}), encoding="utf-8"
    )
    _run(
        _command(gpu, engine, workspace, {}), timeout=180.0, cancel=None, preflight=True
    )
    report: dict[str, Any] = json.loads((workspace / "preflight.json").read_bytes())
    if report.get("role") != role or report.get("native_fa2") is not True:
        raise ComponentError("COMPONENT_NOT_READY", "Wan 啟動檢查回報不完整")
    return report


def run_native(
    ctx: RunContext,
    install: Installation,
    workspace: Path,
    inputs: dict[str, Path],
    options: dict[str, object],
) -> dict[str, int]:
    """Execute the official process in a private PID, IPC, mount and network namespace."""
    (workspace / "options.json").write_text(
        json.dumps(options, ensure_ascii=False), encoding="utf-8"
    )
    (workspace / "files.json").write_text(json.dumps(install.files), encoding="utf-8")
    mounts = {f"/input/{name}": source for name, source in inputs.items()}
    mounts.update(
        {f"/weights/{name}": install.weights / name for name in install.files}
    )
    command = _command(
        str(ctx.device["id"]),
        install.engine,
        workspace,
        mounts,
        prepared_controls=options.get("prepared_controls") is True,
    )
    _run(
        command,
        timeout=ctx.remaining_seconds(),
        cancel=ctx.cancel_token,
        preflight=False,
    )
    report: dict[str, int] = json.loads((workspace / "geometry.json").read_bytes())
    fields = ("frames", "fps", "cuda_peak_allocated_bytes", "cuda_peak_reserved_bytes")
    if any(type(report.get(key)) is not int or report[key] <= 0 for key in fields):
        raise ComponentError("INTEGRITY_MISMATCH", "Wan 生成資訊不完整")
    return report
