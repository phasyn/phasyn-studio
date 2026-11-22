"""Build the concrete run on the Controller so UI, CLI and MCP plan the same frozen inputs."""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from typing import Any

from phasyn_components.canonical import digest
from phasyn_components.contracts import validate, validate_with_schema
from phasyn_components.pipeline import validate_pipeline, validate_run_inputs

from .compiler import Doc, invalid


def build_plan(
    version: Doc,
    pipeline: Doc,
    descriptors: Mapping[tuple[str, str], Mapping[str, Any]],
) -> Doc:
    """Validate the pipeline and bind its ports to a frozen shot revision."""
    wiring = copy.deepcopy(pipeline)
    validate_pipeline(wiring, descriptors, require_descriptors=True)
    family, task = version["model"].split(".")
    settings = version["reference_settings"]
    roles: dict[str, set[str]] = {}
    if family == "portable":
        roles = _declared_ports(version, wiring, descriptors)
    else:
        for step in wiring["steps"]:
            descriptor = descriptors[(step["node_id"].lower(), step["component_id"])]
            provider = descriptor["provider_id"]
            model = provider.split(".")[0]
            if model in {"qimg", "h3"} and model != family:
                raise invalid(
                    "元件模型與鏡頭綁定不相容",
                    provider_id=provider,
                    model=version["model"],
                )
            for port, source in step.get("inputs", {}).items():
                if "from_input" in source:
                    roles.setdefault(source["from_input"], set()).add(port)
            stored = descriptor.get("settings") or {}
            params = step.get("parameters") or {}
            effective = ((stored.get("stored") or {}).get("invoke") or {}) | params
            if provider == "h3.conditioning" and effective.get("task") != task:
                raise invalid(
                    "文字編碼器的 H3 任務與綁定版本不相容",
                    step_id=step["step_id"],
                    task=task,
                )
            _check_cfg(provider, effective, settings, step)
            if provider == "qimg.conditioning":
                step["parameters"] = {**params, "cfg": settings["cfg"]}
            if provider == "qimg.prepare":
                step["parameters"] = {
                    **params,
                    **{
                        k: settings[k]
                        for k in ("base_index", "mask_invert", "reference_resolution")
                    },
                }
            if stored.get("parameters_schema"):
                validate_with_schema(
                    stored["parameters_schema"],
                    step.get("parameters") or {},
                    what=step["step_id"],
                    code="INVALID_ARGUMENT",
                )
    frozen = _bind_ports(version, wiring, roles)
    validate_run_inputs(wiring, frozen)
    origin = {
        k: version[k]
        for k in ("project_id", "medium", "shot_id", "revision", "digest", "model")
    }
    label = f"{version['project_id']}/{version['shot_id']} · {version['model']} · r{version['revision']}"
    request = {
        "pipeline": wiring,
        "inputs": frozen,
        "label": label,
        "origin": {
            "note": json.dumps(
                {"creative_binding": origin}, ensure_ascii=False, separators=(",", ":")
            )
        },
    }
    validate("RunRequest", request, what="創作綁定執行計畫")
    return {
        "request": request,
        "creative_binding": origin,
        "request_digest": digest(request),
    }


def _declared_ports(
    version: Doc, wiring: Doc, descriptors: Mapping[tuple[str, str], Mapping[str, Any]]
) -> dict[str, set[str]]:
    """Map creative roles through the plugin that publishes the chosen media."""
    candidates = []
    for step in wiring["steps"]:
        descriptor = descriptors[(step["node_id"].lower(), step["component_id"])]
        declaration = (descriptor.get("facts") or {}).get("studio_creative")
        if (
            not isinstance(declaration, dict)
            or type(declaration.get("version")) is not int
            or declaration["version"] != 1
            or declaration.get("medium") != version["medium"]
        ):
            continue
        port = declaration.get("output")
        asset_type = (
            "media.asset.v1" if version["medium"] == "video" else "image.asset.v1"
        )
        inputs = declaration.get("inputs")
        if (
            isinstance(inputs, dict)
            and any(
                out["name"] == port and out["type_id"] == asset_type
                for out in descriptor["outputs"]
            )
            and {"from_step": step["step_id"], "output": port}
            in wiring["outputs"].values()
        ):
            candidates.append((step, inputs))
    if len(candidates) != 1:
        raise invalid("請選擇可接受此鏡頭綁定並公開成品的插件")
    step, ports = candidates[0]
    roles: dict[str, set[str]] = {}
    for role in version["inputs"]:
        name = ports.get(role)
        edge = step["inputs"].get(name) if isinstance(name, str) else None
        external = edge.get("from_input") if isinstance(edge, dict) else None
        if not isinstance(external, str) or external in roles:
            raise invalid("插件未接上獨立的創作輸入", role=role)
        roles[external] = {role}
    return roles


def _check_cfg(provider: str, effective: Doc, settings: Doc, step: Doc) -> None:
    if provider == "qimg.dit":
        guidance = effective.get("guidance")
        if (
            not isinstance(guidance, (float, int))
            or isinstance(guidance, bool)
            or (guidance > 1) != settings["cfg"]
        ):
            raise invalid(
                "Qwen 採樣 guidance 與綁定版本的 CFG 設定不相容",
                step_id=step["step_id"],
            )


def _bind_ports(version: Doc, wiring: Doc, roles: dict[str, set[str]]) -> Doc:
    frozen: Doc = {}
    for role, value in version["inputs"].items():
        transport = "file" if "file" in value else "inline"
        matches = [
            p["name"]
            for p in wiring["inputs"]
            if roles.get(p["name"]) == {role}
            and p["type_id"] == value["type_id"]
            and p["transport"] in {transport, "either"}
        ]
        if len(matches) != 1:
            raise invalid(
                "選定的接線缺少可唯一對應的創作輸入",
                role=role,
                type_id=value["type_id"],
            )
        frozen[matches[0]] = value
    return frozen
