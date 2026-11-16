"""``phasyn-studio doctor``: a read-only environment check (FFmpeg, NVML GPUs, the providers of each runtime).

``ok`` and ``problems`` summarise the report: a missing FFmpeg, a runtime that cannot list its providers and template
placeholders left in the configuration (placeholder UUIDs, ``GPU-REPLACE-n``, ``/path/to/models``) are problems. Model
files are not checked here: a component whose files are missing shows ``COMPONENT_NOT_CONFIGURED`` on the Components
page."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .common import EXIT_OK, EXIT_USAGE, config_path, print_json

DOCTOR_TIMEOUT_S = 120
# the template values of deploy/config/*.example.json that every installation replaces
PLACEHOLDERS = (
    ("00000000-0000-4000-8000-", "範本的佔位 UUID（用 uuidgen 產生新的 node_id／instance_id）"),
    ("GPU-REPLACE-", "範本的 GPU 佔位值（換成 nvidia-smi -L 的 GPU UUID）"),
    ("/path/to/models", "範本的模型目錄佔位值（換成你的模型根目錄）"),
)


def placeholder_problems(config: Path) -> list[str]:
    """Template placeholders still in the configuration file (read as text, so every field is covered)."""
    try:
        text = config.read_text(encoding="utf-8")
    except OSError:
        return []
    return [f"{config.name}：{why}（{value}）" for value, why in PLACEHOLDERS if value in text]


def add_parser(sub: Any) -> None:
    doc = sub.add_parser("doctor", help="唯讀環境檢查")
    doc.add_argument("--config", help="Node 設定檔：列出每個 runtime 的 provider")
    doc.set_defaults(func=run)


def gpus() -> dict[str, Any]:
    try:
        import pynvml
    except ImportError:
        return {"gpus": [], "nvml_error": "nvidia-ml-py 未安裝（GPU 取樣需要 phasyn-node 的 gpu extra）"}
    try:
        pynvml.nvmlInit()
        try:
            found = []
            for index in range(pynvml.nvmlDeviceGetCount()):
                handle = pynvml.nvmlDeviceGetHandleByIndex(index)
                try:
                    total: int | None = int(pynvml.nvmlDeviceGetMemoryInfo(handle).total)
                except pynvml.NVMLError:
                    total = None
                found.append(
                    {
                        "index": index,
                        "name": pynvml.nvmlDeviceGetName(handle),
                        "uuid": pynvml.nvmlDeviceGetUUID(handle),
                        "memory_total_bytes": total,
                    }
                )
            return {"gpus": found, "driver": pynvml.nvmlSystemGetDriverVersion()}
        finally:
            pynvml.nvmlShutdown()
    except pynvml.NVMLError as exc:
        return {"gpus": [], "nvml_error": f"{type(exc).__name__}: {exc}"}


def runtime_providers(config: Path) -> list[dict[str, Any]]:
    """Ask every configured runtime for its providers, with the same minimal environment the Node uses."""
    from phasyn_node.config import load_config
    from phasyn_node.sysinfo import runtime_env, source_revision

    node = load_config(config)
    revision = source_revision()
    out: list[dict[str, Any]] = []
    for runtime in node.runtimes.values():
        entry: dict[str, Any] = {"runtime_id": runtime.runtime_id, "python": runtime.python}
        try:
            result = subprocess.run(
                [runtime.python, "-m", runtime.module, "--list"],
                capture_output=True,
                text=True,
                timeout=DOCTOR_TIMEOUT_S,
                env=runtime_env(runtime, device=None, source_rev=revision),
                check=False,
            )
            doc = json.loads(result.stdout.strip().splitlines()[-1] if result.stdout.strip() else "{}")
            items = doc.get("items", []) if isinstance(doc, dict) else None
            if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
                raise ValueError("the runtime's --list output is not {items: [...]} JSON")
            entry["providers"] = [(i["provider_id"], i["available"], i.get("reason")) for i in items]
        except (OSError, subprocess.SubprocessError, ValueError, KeyError) as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
        out.append(entry)
    return out


def run(args: argparse.Namespace) -> int:
    from phasyn_node.config import ConfigError

    report: dict[str, Any] = {
        "python": sys.version.split()[0],
        "ffmpeg": shutil.which("ffmpeg"),
        "ffprobe": shutil.which("ffprobe"),
        **gpus(),
    }
    problems: list[str] = []
    if report["ffmpeg"] is None or report["ffprobe"] is None:
        problems.append("PATH 上找不到 ffmpeg 或 ffprobe")
    if args.config:
        path = config_path(args.config)
        try:
            report["runtimes"] = runtime_providers(path)
        except ConfigError as exc:
            print(f"錯誤：{exc}", file=sys.stderr)
            return EXIT_USAGE
        problems += [
            f"runtime {r['runtime_id']} 無法列出 provider：{r['error']}" for r in report["runtimes"] if "error" in r
        ]
        problems += placeholder_problems(path)
    report["ok"] = not problems
    report["problems"] = problems
    print_json(report)
    return EXIT_OK


__all__ = ["DOCTOR_TIMEOUT_S", "add_parser", "gpus", "placeholder_problems", "run", "runtime_providers"]
