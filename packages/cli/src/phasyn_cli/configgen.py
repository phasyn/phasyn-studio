"""Configuration files and pipelines generated from an install plan (:mod:`.planner`).

Everything is built from the repository's templates: the controller and Node settings of
``deploy/config/*.example.json``, the component definitions of ``examples/components/`` (or of
``examples/generate_dit_components.py`` for a BF16 DiT) and the pipelines of ``examples/pipelines/``. The generator
only fills in what the templates leave to the installer (ids, ports, directories, GPU UUIDs and resource groups) and
the placement choices the plan states; it never changes a model setting otherwise.

Files are written into the user's data directory, never into the repository. An existing file is kept unless the
caller asks to reconfigure; then the old file is kept next to the new one as ``<name>.bak``.
"""

from __future__ import annotations

import copy
import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from phasyn_components.fs import atomic_write_bytes

from .planner import TEMPLATE_MODELS, TEMPLATE_NODE_ID, Templates

CONTROLLER_LABEL = "Phasyn Studio controller"
NODE_LABEL = "Phasyn Studio node"


@dataclass(frozen=True)
class Ids:
    controller: str
    node: str


def existing_ids(config_dir: Path) -> tuple[str | None, str | None]:
    """The controller and Node ids of an earlier installation in ``config_dir`` (kept on every re-run)."""

    def read(name: str, key: str) -> str | None:
        try:
            doc = json.loads((config_dir / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        value = doc.get(key) if isinstance(doc, dict) else None
        return str(value) if isinstance(value, str) and value else None

    return read("controller.json", "instance_id"), read("node.json", "node_id")


def make_ids(controller: str | None, node: str | None) -> Ids:
    return Ids(controller or str(uuid.uuid4()), node or str(uuid.uuid4()))


def _resource_group(plan: Mapping[str, Any], gpu_uuid: str) -> str:
    for gpu in plan["gpus"]:
        if gpu["uuid"] == gpu_uuid and gpu.get("resource_group"):
            return str(gpu["resource_group"])
    raise ValueError(f"GPU {gpu_uuid} is not part of the plan")


def _model_path(value: Any, models_dir: str) -> Any:
    if isinstance(value, str) and value.startswith(TEMPLATE_MODELS):
        return models_dir + value[len(TEMPLATE_MODELS) :]
    return value


def render_component(plan: Mapping[str, Any], templates: Templates, entry: Mapping[str, Any]) -> dict[str, Any]:
    """One GPU component definition: the template, placed on the plan's GPU."""
    choices = entry.get("choices") or {}
    gpu_uuid = entry["gpu_uuid"]
    group = _resource_group(plan, gpu_uuid)
    models = plan["models_dir"]
    if choices.get("generated"):
        variant = "fl2va" if "fl2va" in entry["component_id"] else "ref2va"
        doc = templates.dit_generator(
            variant, str(choices["precision"]), "pai8", model_path=models, device_id=gpu_uuid, resource_group=group
        )
    else:
        doc = copy.deepcopy(templates.component(entry.get("source") or entry["component_id"]))
    doc["component_id"] = entry["component_id"]
    if entry.get("runtime_id"):
        doc["runtime_id"] = entry["runtime_id"]
    load = doc["settings"]["load"]
    if "model_path" in load:
        load["model_path"] = _model_path(load["model_path"], models)
    load["device"] = {**load["device"], "id": gpu_uuid, "resource_group": group}
    if "pin_memory" in choices:
        load["offload"] = {**load.get("offload", {}), "pin_memory": choices["pin_memory"]}
    return doc


def render_controller(plan: Mapping[str, Any], templates: Templates, ids: Ids) -> dict[str, Any]:
    doc = copy.deepcopy(templates.controller())
    service = plan["services"]["controller"]
    doc.update(
        {
            "instance_id": ids.controller,
            "label": CONTROLLER_LABEL,
            "bind_host": "127.0.0.1",
            "port": service["port"],
            "advertise_url": service["url"],
            "data_dir": str(Path(plan["data_dir"]) / "controller"),
            "static_dir": str(Path(plan["repo_dir"]) / "apps" / "frontend" / "dist"),
        }
    )
    return doc


def render_node(plan: Mapping[str, Any], templates: Templates, ids: Ids) -> dict[str, Any]:
    template = templates.node()
    doc = {k: copy.deepcopy(v) for k, v in template.items() if k not in ("runtimes", "components")}
    service = plan["services"]["node"]
    doc.update(
        {
            "node_id": ids.node,
            "label": NODE_LABEL,
            "bind_host": "127.0.0.1",
            "port": service["port"],
            "advertise_url": service["url"],
            "controller_url": plan["services"]["controller"]["url"],
            "data_dir": str(Path(plan["data_dir"]) / "node"),
            "model_dirs": [plan["models_dir"]],
        }
    )
    cpu_python = str(Path(plan["repo_dir"]) / ".venv" / "bin" / "python")
    runtimes = [{"runtime_id": "cpu", "python": cpu_python, "module": "phasyn_components.runtime_host", "env": {}}]
    runtimes += [
        {"runtime_id": r["runtime_id"], "python": r["python"], "module": "phasyn_components.runtime_host", "env": {}}
        for r in plan["runtimes"]
    ]
    components = [copy.deepcopy(c) for c in template["components"] if c["runtime_id"] == "cpu"]
    for entry in plan["cpu_components"]:
        comp = copy.deepcopy(templates.component(entry["component_id"]))
        if entry.get("runtime_id"):
            comp["runtime_id"] = entry["runtime_id"]
        components.append(comp)
    components += [render_component(plan, templates, entry) for entry in plan["components"]]
    doc["runtimes"] = runtimes
    doc["components"] = components
    return doc


def render_pipeline(
    plan: Mapping[str, Any], templates: Templates, entry: Mapping[str, Any], node_id: str
) -> dict[str, Any]:
    doc = copy.deepcopy(templates.pipeline(entry["pipeline_id"]))
    renames: Mapping[str, str] = entry.get("component_map") or {}
    for step in doc["steps"]:
        if step.get("node_id") == TEMPLATE_NODE_ID:
            step["node_id"] = node_id
        step["component_id"] = renames.get(step["component_id"], step["component_id"])
    return doc


def render_all(plan: Mapping[str, Any], templates: Templates, ids: Ids) -> dict[str, Any]:
    """{"controller.json": …, "node.json": …, "pipelines": {id: …}}"""
    return {
        "controller.json": render_controller(plan, templates, ids),
        "node.json": render_node(plan, templates, ids),
        "pipelines": {p["pipeline_id"]: render_pipeline(plan, templates, p, ids.node) for p in plan["pipelines"]},
    }


def validate(rendered: Mapping[str, Any], config_dir: Path) -> list[str]:
    """Check the generated files with the services' own loaders (contracts included); [] when valid."""
    from phasyn_components import contracts
    from phasyn_components.errors import ComponentError
    from phasyn_controller.config import ConfigError as ControllerConfigError
    from phasyn_controller.config import ControllerConfig
    from phasyn_node.config import ConfigError as NodeConfigError
    from phasyn_node.config import config_from_dict

    problems: list[str] = []
    try:
        ControllerConfig.from_dict(copy.deepcopy(rendered["controller.json"]), base_dir=config_dir)
    except (ControllerConfigError, ComponentError, ValueError, KeyError, TypeError) as exc:
        problems.append(f"controller.json: {exc}")
    try:
        config_from_dict(copy.deepcopy(rendered["node.json"]), base_dir=config_dir)
    except (NodeConfigError, ComponentError, ValueError, KeyError, TypeError) as exc:
        problems.append(f"node.json: {exc}")
    for pid, doc in rendered["pipelines"].items():
        try:
            contracts.validate("Pipeline", doc, what=f"pipeline {pid}")
        except ComponentError as exc:
            problems.append(f"pipeline {pid}: {exc.message}")
    return problems


def write_json(path: Path, doc: Any, *, reconfigure: bool, backup: bool = True) -> str:
    """created | unchanged | kept (differs; not replaced without reconfigure) | updated (old copy in .bak)."""
    text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    try:
        current = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        current = None
    if current == text:
        return "unchanged"
    if current is not None and not reconfigure:
        return "kept"
    path.parent.mkdir(parents=True, exist_ok=True)
    if current is not None and backup:
        atomic_write_bytes(path.with_name(path.name + ".bak"), current.encode("utf-8"))
    atomic_write_bytes(path, text.encode("utf-8"))
    return "created" if current is None else "updated"


__all__ = [
    "Ids",
    "existing_ids",
    "make_ids",
    "render_all",
    "render_component",
    "render_controller",
    "render_node",
    "render_pipeline",
    "validate",
    "write_json",
]
