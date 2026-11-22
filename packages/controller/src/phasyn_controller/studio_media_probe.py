"""Inspect immutable historical media using the configured isolated CPU provider."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, uuid5

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError

from .studio_take_source import step_source


if TYPE_CHECKING:
    from .state import Controller

type Doc = dict[str, Any]
_PIPELINE = "studio-media-inspection-v1"


def _plan(ctl: Controller, ref: Doc) -> Doc:
    audio = ref["media_type"].startswith("audio/")
    port = "audio" if audio else "media"
    type_id = "media.audio.v1" if audio else "media.video.v1"
    targets = [
        (node != ref["node_id"], descriptor["state"] != "ready", node, component)
        for (node, component), descriptor in ctl.catalog.descriptors().items()
        if descriptor["provider_id"] == "media.probe"
        and descriptor["state"] in ("ready", "busy")
        and ctl.catalog.state(node) != "offline"
        and "clip_origin"
        in descriptor["settings"]["parameters_schema"].get("properties", {})
        and any(
            item["name"] == port and item["type_id"] == type_id
            for item in descriptor["inputs"]
        )
    ]
    if not targets:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED",
            "舊素材需由支援來源時間原點的 media.probe 核對；請啟動更新後的 CPU 媒體探測元件",
        )
    _, _, node, component = min(targets)
    return {
        "pipeline": {
            "pipeline_id": _PIPELINE,
            "label": "核對素材音軌與剪輯零點",
            "inputs": [
                {
                    "name": "source",
                    "type_id": type_id,
                    "required": True,
                    "transport": "file",
                    "description": "已發布素材",
                }
            ],
            "steps": [
                {
                    "step_id": "inspect",
                    "node_id": node,
                    "component_id": component,
                    "inputs": {port: {"from_input": "source"}},
                    "parameters": {
                        "clip_origin": True,
                        "frame_clock": False,
                        "scenes": None,
                    },
                }
            ],
            "outputs": {"info": {"from_step": "inspect", "output": "info"}},
        },
        "inputs": {"source": {"type_id": type_id, "file": ref}},
    }


async def _existing(ctl: Controller, rid: str) -> Doc | None:
    active = ctl.runner.snapshot(rid)
    if active is not None:
        return active
    try:
        return await asyncio.to_thread(ctl.runs.read, rid)
    except ComponentError as exc:
        if exc.code != "NOT_FOUND":
            raise
        return None


def _checked_info(run: Doc, ref: Doc) -> Doc:
    request = run["request"]
    step, output = step_source(run, request["pipeline"]["outputs"].get("info", {}))
    info = output.get("value")
    if (
        request["pipeline"]["pipeline_id"] != _PIPELINE
        or request["inputs"].get("source", {}).get("file") != ref
        or list(step["inputs"].values()) != [{"from_input": "source"}]
        or step["parameters"].get("clip_origin") is not True
        or output != run["outputs"].get("info")
        or output.get("type_id") != "media.probe.v1"
        or not isinstance(info, dict)
        or not contracts.is_valid("MediaInfo", info)
        or info["size_bytes"] != ref["size_bytes"]
        or "clip_origin_offset" not in info
    ):
        raise ComponentError("STATE_CONFLICT", "媒體探測結果無法對應原始檔與剪輯零點")
    return info


async def inspect_source(ctl: Controller, ref: Doc, *, dry_run: bool) -> Doc:
    """Reuse an exact publication's measurement across retries, projects and controller restarts."""
    rid = str(uuid5(NAMESPACE_URL, f"{_PIPELINE}:{digest(ref)}"))
    while (run := await _existing(ctl, rid)) and run["state"] in (
        "failed",
        "cancelled",
    ):
        # A confirmed terminal failure permits a fresh read-only measurement.
        rid = str(uuid5(NAMESPACE_URL, rid))
    if run is None:
        if dry_run:
            raise ComponentError(
                "STATE_CONFLICT", "舊素材尚未量測；套用時會執行 CPU 媒體探測"
            )
        try:
            run = await ctl.runner.create(
                await asyncio.to_thread(_plan, ctl, ref), reserved_run_id=rid
            )
        except ComponentError:
            run = await _existing(ctl, rid)
            if run is None:
                raise
    if run["state"] != "succeeded":
        execution = ctl.runner.executions.get(rid)
        if execution and execution.task is not None and not dry_run:
            await asyncio.wait({execution.task}, timeout=30)
        run = await _existing(ctl, rid)
    if run is None or run["state"] != "succeeded":
        raise ComponentError(
            "STATE_CONFLICT",
            "尚無可採用的媒體探測結果，請查看探測工作後再套用",
            details={"run_id": rid, "state": run["state"] if run else "unknown"},
        )
    return _checked_info(run, ref)
