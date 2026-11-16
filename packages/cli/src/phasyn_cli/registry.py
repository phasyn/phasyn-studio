"""Opt-in deployment registry for ``service install --registry-dir DIR``.

Some operators keep a host-wide registry of long-running services. When ``--registry-dir`` is given, the
install writes ``DIR/services/<service_id>.json`` (one manifest per unit, the service id is reused for the same
unit name) and ``DIR/receipts/<deployment_id>.json`` (one receipt per install). Without the flag nothing is
written outside the systemd unit directory. Uninstall never touches the registry: it is history.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import os
import platform
import sys
import uuid
from pathlib import Path
from typing import Any

from phasyn_components.canonical import read_json
from phasyn_components.fs import atomic_write_json

from .service import STOP_TIMEOUT_S, InstallReport, systemctl

log = logging.getLogger("phasyn_cli.registry")

SCHEMA_VERSION = 1
ENVIRONMENT = "prod"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def existing_service_id(services: Path, unit: str) -> str | None:
    """The service id of an earlier manifest for this unit; unreadable manifests are skipped with a warning."""
    if not services.is_dir():
        return None
    for path in sorted(services.glob("*.json")):
        try:
            doc = read_json(path)
        except (OSError, ValueError) as exc:
            log.warning("略過無法讀取的 manifest %s：%s", path, exc)
            continue
        if isinstance(doc, dict) and (doc.get("manager") or {}).get("native_name") == unit:
            service_id = doc.get("service_id")
            if isinstance(service_id, str) and service_id:
                return service_id
    return None


def manifest(role: str, instance: str, report: InstallReport, config: Path, service_id: str) -> dict[str, Any]:
    title = "主控" if role == "controller" else "Node"
    return {
        "schema_version": SCHEMA_VERSION,
        "service_id": service_id,
        "project": "phasyn-studio",
        "component": role,
        "environment": ENVIRONMENT,
        "instance": instance,
        "display_name": f"Phasyn Studio {title}（{instance}）",
        "workload_kind": "daemon",
        "manager": {
            "provider": "systemd",
            "scope": "user",
            "owner_uid": os.getuid(),
            "native_name": report.unit,
            "definition_path": str(report.path),
        },
        "origin": {"repository_url": None, "revision": None, "source_dirty": None},
        "execution": {
            "run_as_user": os.environ.get("USER"),
            "working_directory": str(config.parent),
            "executable_path": sys.executable,
            "config_ref": str(config),
            "artifact_directory": None,
        },
        "lifecycle": {
            "restart_policy": "no",
            "startup_intent": "boot",
            "stop_timeout_sec": STOP_TIMEOUT_S,
            "stop_semantics": "terminate",
            "checkpoint_protocol": None,
            "resume_verified": False,
            "completion_protocol": None,
        },
        "observability": {
            "logs": "journal",
            "log_paths": [],
            "log_rotation_owner": "journald",
            "metric_scope": "unit_cgroup",
            "health_probe_ref": f"http GET /api/{'controller' if role == 'controller' else 'node'}",
        },
        "management": {
            "registration_mode": "pending_host_grant",
            "requested_actions": ["status", "logs", "start", "stop"],
        },
    }


def _boot_id() -> str | None:
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    except OSError:
        return None


def receipt(report: InstallReport, *, service_id: str, manifest_path: Path) -> dict[str, Any]:
    version = systemctl("--version", check=False).stdout.splitlines()
    definition = json.dumps(
        [{"path": str(report.path), "sha256": _sha256(report.path)}], separators=(",", ":"), ensure_ascii=False
    )
    uname = platform.uname()
    return {
        "schema_version": SCHEMA_VERSION,
        "deployment_id": str(uuid.uuid4()),
        "service_id": service_id,
        "manifest_sha256": _sha256(manifest_path),
        "host_observation": {
            "display_name": uname.node,
            "host_key_fingerprint": None,
            "os": uname.system,
            "architecture": uname.machine,
            "supervisor_version": version[0] if version else None,
            "boot_id": _boot_id(),
        },
        "manager": {
            "provider": "systemd",
            "scope": "user",
            "owner_uid": os.getuid(),
            "native_name": report.unit,
            "definition_path": str(report.path),
        },
        "completed_steps": list(report.steps),
        "status": "deployed" if report.verified else "partial",
        "definition_sha256": hashlib.sha256((definition + "\n").encode("utf-8")).hexdigest(),
        "observed_at": datetime.datetime.now(datetime.UTC).isoformat(),
        "runtime_state": dict(report.state),
        "native_enable_state": report.enabled,
        "boot_verified": False,
        "application_health": "unknown",
        "rollback_record_ref": None,
        "limitations": [],
        "observation_status": "observed",
        "observation_reason": None,
    }


def record(registry_dir: Path, *, role: str, instance: str, config: Path, report: InstallReport) -> Path:
    """Write the manifest and a receipt; returns the manifest path."""
    services = registry_dir / "services"
    service_id = existing_service_id(services, report.unit) or str(uuid.uuid4())
    manifest_path = services / f"{service_id}.json"
    atomic_write_json(manifest_path, manifest(role, instance, report, config, service_id))
    doc = receipt(report, service_id=service_id, manifest_path=manifest_path)
    atomic_write_json(registry_dir / "receipts" / f"{doc['deployment_id']}.json", doc)
    return manifest_path


__all__ = ["existing_service_id", "manifest", "receipt", "record"]
