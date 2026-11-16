"""NodeConfig 載入（contracts ``NodeConfig``）。

設定檔是使用者給這台主機的 bootstrap 配置：node_id 持久、bind_host/port 給 uvicorn、
advertise_url 是其他主機連到這個 Node 的位址。``components`` 只是 seed（InstanceDefinition，可帶
``folder``／``autostart``）：只有在 ``data_dir/config/components/<id>.json`` 不存在、且沒有刪除記錄
``data_dir/config/deleted-components/<id>.json`` 時寫入，之後以保存的定義（含 stored_revision）為準；
改設定檔的 seed 不會改到已保存的定義（改顯示資訊用 PATCH /api/components/{id}/meta）。
``admission``（選用）是這台主機的主機保護（:mod:`phasyn_node.admission`）；不設＝不取樣、不等待。
"""

from __future__ import annotations

import copy
import dataclasses
import json
import os
import platform
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_uuid
from phasyn_components.settings import normalize_recording
from phasyn_server.http import DEFAULT_JSON_BODY_BYTES, DEFAULT_UPLOAD_BYTES

DEFAULTS: dict[str, Any] = {
    "bind_host": "127.0.0.1",
    "port": 8090,
    "catalog_interval_seconds": 5,
    "load_timeout_seconds": 1800,
    "cancel_grace_seconds": 10,
    "file_buffer_bytes": 8 * 1024 * 1024,
    "file_transfer_concurrency": 2,
    "max_json_body_bytes": DEFAULT_JSON_BODY_BYTES,
    "max_upload_bytes": DEFAULT_UPLOAD_BYTES,
    "runtimes": [],
    "components": [],
}


class ConfigError(Exception):
    """設定檔無法使用（訊息為繁中，可直接顯示給使用者）。"""


@dataclass(frozen=True)
class RuntimeEntry:
    """Node 本機的 runtime：python 直譯器與 provider 入口模組（不由 invoke 傳入）。"""

    runtime_id: str
    python: str
    module: str
    env: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"runtime_id": self.runtime_id, "python": self.python, "module": self.module, "env": dict(self.env)}


DEFAULT_CHIP_ZONE_GLOB = "/sys/class/thermal/thermal_zone*/temp"


@dataclass(frozen=True)
class GatedCalls:
    """The calls the host protection holds back and watches: components whose exclusive_group or provider_id is listed."""

    exclusive_groups: tuple[str, ...] = ()
    provider_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class ThermalLimits:
    """Chip temperature pause / resume / cancel thresholds and the GPU cancel threshold (°C); sampling intervals (s)."""

    pause_at_c: float
    resume_below_c: float
    cancel_chip_at_c: float
    cancel_gpu_at_c: float
    chip_zone_glob: str = DEFAULT_CHIP_ZONE_GLOB
    sample_seconds: float = 20.0
    hot_sample_seconds: float = 5.0


@dataclass(frozen=True)
class MemoryLimits:
    """``MemAvailable`` a gated call needs to start, and the floor that cancels a running one (bytes)."""

    start_min_available_bytes: int
    cancel_below_available_bytes: int
    sample_seconds: float = 5.0


@dataclass(frozen=True)
class AdmissionConfig:
    """``NodeConfig.admission``: the opt-in host protection of heavy calls; a missing section is switched off."""

    gated: GatedCalls
    thermal: ThermalLimits | None = None
    memory: MemoryLimits | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "gated": {
                "exclusive_groups": list(self.gated.exclusive_groups),
                "provider_ids": list(self.gated.provider_ids),
            }
        }
        if self.thermal is not None:
            out["thermal"] = dataclasses.asdict(self.thermal)
        if self.memory is not None:
            out["memory"] = dataclasses.asdict(self.memory)
        return out


@dataclass
class NodeConfig:
    node_id: str
    label: str
    bind_host: str
    port: int
    advertise_url: str
    controller_url: str
    data_dir: Path
    catalog_interval_seconds: int
    load_timeout_seconds: int
    cancel_grace_seconds: int
    file_buffer_bytes: int
    file_transfer_concurrency: int
    runtimes: dict[str, RuntimeEntry]
    components: list[dict[str, Any]]
    recording: dict[str, Any]
    max_json_body_bytes: int = DEFAULT_JSON_BODY_BYTES
    max_upload_bytes: int = DEFAULT_UPLOAD_BYTES
    allowed_hosts: tuple[str, ...] | None = None  # None = the local default (phasyn_server.HostPolicy.local)
    model_dirs: tuple[Path, ...] = ()  # extra directories weights may be downloaded into (see download_roots)
    admission: AdmissionConfig | None = None  # None = no host protection (no sampling, no waits)

    def download_roots(self) -> tuple[Path, ...]:
        """權重下載可以寫入的目錄：``model_dirs`` 加上設定檔內每個元件的 ``load.model_path``（都是這台主機的
        設定檔寫的，不是經由 API 改的）。symlink 已展開；相對的 ``load.model_path`` 不算。"""
        roots = {Path(os.path.realpath(path)) for path in self.model_dirs}
        for comp in self.components:
            load = (comp.get("settings") or {}).get("load") or {}
            model_path = load.get("model_path") if isinstance(load, dict) else None
            if isinstance(model_path, str) and model_path.strip():
                candidate = Path(model_path.strip()).expanduser()
                if candidate.is_absolute():
                    roots.add(Path(os.path.realpath(candidate)))
        return tuple(sorted(roots))

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "label": self.label,
            "bind_host": self.bind_host,
            "port": self.port,
            "advertise_url": self.advertise_url,
            "controller_url": self.controller_url,
            "data_dir": str(self.data_dir),
            "catalog_interval_seconds": self.catalog_interval_seconds,
            "load_timeout_seconds": self.load_timeout_seconds,
            "cancel_grace_seconds": self.cancel_grace_seconds,
            "file_buffer_bytes": self.file_buffer_bytes,
            "file_transfer_concurrency": self.file_transfer_concurrency,
            "runtimes": [r.to_dict() for r in self.runtimes.values()],
            "components": copy.deepcopy(self.components),
            "recording": copy.deepcopy(self.recording),
            "max_json_body_bytes": self.max_json_body_bytes,
            "max_upload_bytes": self.max_upload_bytes,
            **({"allowed_hosts": list(self.allowed_hosts)} if self.allowed_hosts is not None else {}),
            **({"model_dirs": [str(path) for path in self.model_dirs]} if self.model_dirs else {}),
            **({"admission": self.admission.to_dict()} if self.admission is not None else {}),
        }


def _thermal_limits(doc: Mapping[str, Any] | None) -> ThermalLimits | None:
    if doc is None:
        return None
    limits = ThermalLimits(
        pause_at_c=float(doc["pause_at_c"]),
        resume_below_c=float(doc["resume_below_c"]),
        cancel_chip_at_c=float(doc["cancel_chip_at_c"]),
        cancel_gpu_at_c=float(doc["cancel_gpu_at_c"]),
        chip_zone_glob=str(doc.get("chip_zone_glob", DEFAULT_CHIP_ZONE_GLOB)),
        sample_seconds=float(doc.get("sample_seconds", ThermalLimits.sample_seconds)),
        hot_sample_seconds=float(doc.get("hot_sample_seconds", ThermalLimits.hot_sample_seconds)),
    )
    if not limits.resume_below_c < limits.pause_at_c < limits.cancel_chip_at_c:
        raise ConfigError(
            "admission.thermal 的門檻必須是 resume_below_c < pause_at_c < cancel_chip_at_c"
            f"（目前是 {limits.resume_below_c:g} / {limits.pause_at_c:g} / {limits.cancel_chip_at_c:g}°C）"
        )
    if limits.hot_sample_seconds > limits.sample_seconds:
        raise ConfigError(
            f"admission.thermal.hot_sample_seconds（{limits.hot_sample_seconds:g}）不能大於 "
            f"sample_seconds（{limits.sample_seconds:g}）：溫度高時取樣只會更密"
        )
    if not os.path.isabs(limits.chip_zone_glob):
        raise ConfigError(f"admission.thermal.chip_zone_glob 必須是絕對路徑（目前是 {limits.chip_zone_glob}）")
    return limits


def _memory_limits(doc: Mapping[str, Any] | None) -> MemoryLimits | None:
    if doc is None:
        return None
    limits = MemoryLimits(
        start_min_available_bytes=int(doc["start_min_available_bytes"]),
        cancel_below_available_bytes=int(doc["cancel_below_available_bytes"]),
        sample_seconds=float(doc.get("sample_seconds", MemoryLimits.sample_seconds)),
    )
    if limits.start_min_available_bytes < limits.cancel_below_available_bytes:
        raise ConfigError(
            f"admission.memory.start_min_available_bytes（{limits.start_min_available_bytes}）不能小於 "
            f"cancel_below_available_bytes（{limits.cancel_below_available_bytes}）：放行的呼叫會在第一次取樣就被取消"
        )
    return limits


def _admission_config(doc: Mapping[str, Any] | None) -> AdmissionConfig | None:
    """``admission`` after the contract check (types, ranges, keys): the relations between its values."""
    if doc is None:
        return None
    gated_doc = doc["gated"]
    gated = GatedCalls(
        exclusive_groups=tuple(str(item) for item in gated_doc.get("exclusive_groups") or ()),
        provider_ids=tuple(str(item) for item in gated_doc.get("provider_ids") or ()),
    )
    if not gated.exclusive_groups and not gated.provider_ids:
        raise ConfigError(
            f"admission.gated（{json.dumps(gated_doc, ensure_ascii=False)}）沒有列出任何 exclusive_groups 或 "
            "provider_ids：沒有呼叫會受到保護"
        )
    admission = AdmissionConfig(
        gated=gated, thermal=_thermal_limits(doc.get("thermal")), memory=_memory_limits(doc.get("memory"))
    )
    if admission.thermal is None and admission.memory is None:
        raise ConfigError(
            f"admission（{', '.join(sorted(doc))}）至少要有 thermal 或 memory 其中一段；不需要主機保護時請刪掉整個 admission"
        )
    return admission


def _resolve_path(value: str, base_dir: Path | None) -> Path:
    """相對路徑以設定檔目錄為基準；不展開 symlink（venv 的 bin/python 是 symlink，展開會失去 venv）。"""
    path = Path(value).expanduser()
    if not path.is_absolute() and base_dir is not None:
        path = base_dir / path
    return Path(os.path.abspath(path))


def _resolve_python(value: str, base_dir: Path | None) -> str:
    """含路徑分隔的相對路徑以設定檔目錄為基準；單純指令名（如 python3）保留給 PATH 解析。"""
    if "/" not in value:
        return value
    return str(_resolve_path(value, base_dir))


def config_from_dict(doc: dict[str, Any], *, base_dir: Path | None = None) -> NodeConfig:
    if not isinstance(doc, dict):
        raise ConfigError("Node 設定必須是 JSON object")
    merged: dict[str, Any] = {**copy.deepcopy(DEFAULTS), **copy.deepcopy(doc)}
    merged.setdefault("label", platform.node() or "node")
    merged["recording"] = normalize_recording(merged.get("recording"))
    try:
        contracts.validate("NodeConfig", merged, what="Node 設定")
    except ComponentError as exc:
        problems = (exc.details or {}).get("errors") or [exc.message]
        raise ConfigError("Node 設定不符合契約：" + "；".join(str(p) for p in problems[:5])) from exc
    runtimes: dict[str, RuntimeEntry] = {}
    for entry in merged["runtimes"]:
        rid = entry["runtime_id"]
        if rid in runtimes:
            raise ConfigError(f"runtime_id 重複：{rid}")
        runtimes[rid] = RuntimeEntry(
            runtime_id=rid,
            python=_resolve_python(entry["python"], base_dir),
            module=entry["module"],
            env={str(k): str(v) for k, v in (entry.get("env") or {}).items()},
        )
    seen: set[str] = set()
    for comp in merged["components"]:
        cid = comp["component_id"]
        if cid in seen:
            raise ConfigError(f"components 內 component_id 重複：{cid}")
        seen.add(cid)
    return NodeConfig(
        node_id=require_uuid(merged["node_id"], "node_id"),
        label=str(merged["label"]),
        bind_host=str(merged["bind_host"]),
        port=int(merged["port"]),
        advertise_url=str(merged["advertise_url"]),
        controller_url=str(merged["controller_url"]),
        data_dir=_resolve_path(str(merged["data_dir"]), base_dir),
        catalog_interval_seconds=int(merged["catalog_interval_seconds"]),
        load_timeout_seconds=int(merged["load_timeout_seconds"]),
        cancel_grace_seconds=int(merged["cancel_grace_seconds"]),
        file_buffer_bytes=int(merged["file_buffer_bytes"]),
        file_transfer_concurrency=int(merged["file_transfer_concurrency"]),
        runtimes=runtimes,
        components=copy.deepcopy(list(merged["components"])),
        recording=dict(merged["recording"]),
        max_json_body_bytes=int(merged["max_json_body_bytes"]),
        max_upload_bytes=int(merged["max_upload_bytes"]),
        allowed_hosts=None if merged.get("allowed_hosts") is None else tuple(map(str, merged["allowed_hosts"])),
        model_dirs=tuple(_resolve_path(str(item), base_dir) for item in merged.get("model_dirs") or ()),
        admission=_admission_config(merged.get("admission")),
    )


def load_config(path: str | Path) -> NodeConfig:
    config_path = Path(path).expanduser()
    try:
        text = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"無法讀取 Node 設定檔 {config_path}：{exc.strerror or exc}") from exc
    try:
        doc = json.loads(text)
    except ValueError as exc:
        raise ConfigError(f"Node 設定檔 {config_path} 不是有效 JSON：{exc}") from exc
    return config_from_dict(doc, base_dir=config_path.resolve().parent)


__all__ = [
    "DEFAULTS",
    "DEFAULT_CHIP_ZONE_GLOB",
    "AdmissionConfig",
    "ConfigError",
    "GatedCalls",
    "MemoryLimits",
    "NodeConfig",
    "RuntimeEntry",
    "ThermalLimits",
    "config_from_dict",
    "load_config",
]
