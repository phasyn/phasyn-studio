"""Controller configuration (contract ``ControllerConfig``).

The config file is bootstrap configuration: ``instance_id`` is the controller's persistent UUID (it is also
the ``node_id`` of files uploaded to the controller). Relative paths resolve against the config file's
directory. There are no identity or permission fields.
"""

from __future__ import annotations

import copy
import json
import os
import socket
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_components import contracts
from phasyn_components.plugin_manifest import LIMITS
from phasyn_components.settings import normalize_recording
from phasyn_server.http import DEFAULT_JSON_BODY_BYTES, DEFAULT_UPLOAD_BYTES

DEFAULT_PORT = 8080
DEFAULT_BIND_HOST = "127.0.0.1"
DEFAULT_NODE_STALE_SECONDS = 15
MAX_ACTIVE_RUNS = 1
_WILDCARD_HOSTS = {"0.0.0.0", "::", "[::]", ""}  # noqa: S104 - only to decide whether advertise_url is required


class ConfigError(Exception):
    """The config file is missing, not JSON, or violates ControllerConfig (message in zh-Hant)."""


@dataclass(frozen=True)
class PluginsConfig:
    """Contract ``ControllerPluginsConfig``: the plugin switches that only the config file can change.

    ``install`` = ``api`` lets any client that reaches the Controller install and remove plugin packages (like the
    rest of the API, without authentication); ``disabled`` refuses both. ``dev_dirs`` are unpacked packages under
    development, validated like an installed package.
    """

    install: str = "api"
    dev_dirs: tuple[Path, ...] = ()
    max_package_bytes: int = LIMITS.package_bytes

    @classmethod
    def from_dict(cls, doc: Mapping[str, Any], base: Path) -> PluginsConfig:
        values = {**contracts.defaults_of("ControllerPluginsConfig"), **doc}
        return cls(
            install=str(values["install"]),
            dev_dirs=tuple(_resolve(str(path), base) for path in values["dev_dirs"]),
            max_package_bytes=int(values["max_package_bytes"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "install": self.install,
            "dev_dirs": [str(path) for path in self.dev_dirs],
            "max_package_bytes": self.max_package_bytes,
        }


@dataclass(frozen=True)
class ControllerConfig:
    instance_id: str
    label: str
    bind_host: str
    port: int
    advertise_url: str
    data_dir: Path
    static_dir: Path | None
    node_stale_seconds: int
    recording: dict[str, Any] = field(default_factory=dict)
    max_active_runs: int = MAX_ACTIVE_RUNS
    max_json_body_bytes: int = DEFAULT_JSON_BODY_BYTES
    max_upload_bytes: int = DEFAULT_UPLOAD_BYTES
    allowed_hosts: tuple[str, ...] | None = None  # None = the local default (phasyn_server.HostPolicy.local)
    plugins: PluginsConfig = field(default_factory=PluginsConfig)

    @classmethod
    def from_dict(cls, doc: Any, *, base_dir: Path | None = None) -> ControllerConfig:
        if not isinstance(doc, dict):
            raise ConfigError("主控設定必須是 JSON object")
        data = copy.deepcopy(doc)
        data.setdefault("label", socket.gethostname() or "controller")
        data.setdefault("bind_host", DEFAULT_BIND_HOST)
        data.setdefault("port", DEFAULT_PORT)
        data.setdefault("max_active_runs", MAX_ACTIVE_RUNS)
        data.setdefault("node_stale_seconds", DEFAULT_NODE_STALE_SECONDS)
        data.setdefault("static_dir", "")
        data.setdefault("max_json_body_bytes", DEFAULT_JSON_BODY_BYTES)
        data.setdefault("max_upload_bytes", DEFAULT_UPLOAD_BYTES)
        if isinstance(data.get("recording"), dict) or data.get("recording") is None:
            data["recording"] = normalize_recording(data.get("recording"))
        if "advertise_url" not in data and str(data.get("bind_host")) not in _WILDCARD_HOSTS:
            data["advertise_url"] = f"http://{data['bind_host']}:{data['port']}"
        if isinstance(data.get("advertise_url"), str):
            data["advertise_url"] = data["advertise_url"].strip().rstrip("/")
        problems = contracts.errors("ControllerConfig", data)
        if problems:
            raise ConfigError("主控設定不符合 ControllerConfig 契約：" + "；".join(problems[:5]))
        if not str(data["data_dir"]).strip():
            raise ConfigError("data_dir 不可為空")
        base = base_dir or Path.cwd()
        return cls(
            instance_id=str(data["instance_id"]).lower(),
            label=str(data["label"]),
            bind_host=str(data["bind_host"]),
            port=int(data["port"]),
            advertise_url=str(data["advertise_url"]).rstrip("/"),
            data_dir=_resolve(str(data["data_dir"]), base),
            static_dir=_resolve(str(data["static_dir"]), base) if str(data["static_dir"] or "").strip() else None,
            node_stale_seconds=int(data["node_stale_seconds"]),
            recording=dict(data["recording"]),
            max_active_runs=int(data["max_active_runs"]),
            max_json_body_bytes=int(data["max_json_body_bytes"]),
            max_upload_bytes=int(data["max_upload_bytes"]),
            allowed_hosts=_hosts(data.get("allowed_hosts")),
            plugins=PluginsConfig.from_dict(data.get("plugins") or {}, base),
        )

    def to_dict(self) -> dict[str, Any]:
        """Contract form (ControllerConfig)."""
        return {
            "instance_id": self.instance_id,
            "label": self.label,
            "bind_host": self.bind_host,
            "port": self.port,
            "advertise_url": self.advertise_url,
            "data_dir": str(self.data_dir),
            "static_dir": str(self.static_dir) if self.static_dir is not None else "",
            "max_active_runs": self.max_active_runs,
            "node_stale_seconds": self.node_stale_seconds,
            "recording": copy.deepcopy(self.recording),
            "max_json_body_bytes": self.max_json_body_bytes,
            "max_upload_bytes": self.max_upload_bytes,
            **({"allowed_hosts": list(self.allowed_hosts)} if self.allowed_hosts is not None else {}),
            "plugins": self.plugins.to_dict(),
        }


def _hosts(value: Any) -> tuple[str, ...] | None:
    return None if value is None else tuple(str(host) for host in value)


def _resolve(value: str, base: Path) -> Path:
    path = Path(os.path.expanduser(value.strip()))
    return (path if path.is_absolute() else base / path).resolve()


def load_config(path: str | os.PathLike[str]) -> ControllerConfig:
    config_path = Path(path).expanduser()
    try:
        text = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"無法讀取主控設定檔 {config_path}：{exc.strerror or exc}") from exc
    try:
        doc = json.loads(text)
    except ValueError as exc:
        raise ConfigError(f"主控設定檔 {config_path} 不是有效 JSON：{exc}") from exc
    return ControllerConfig.from_dict(doc, base_dir=config_path.resolve().parent)


__all__ = [
    "DEFAULT_NODE_STALE_SECONDS",
    "DEFAULT_PORT",
    "MAX_ACTIVE_RUNS",
    "ConfigError",
    "ControllerConfig",
    "PluginsConfig",
    "load_config",
]
