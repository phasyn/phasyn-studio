"""Plan a new refinement from a selected, verified draft without changing the edit."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from phasyn_components.canonical import digest

from ..studio_take_source import load_manifest, published_video
from .engine import conflict, sign
from .plan import Doc, checked, descriptors, output_step, parents_of, rejected, request


if TYPE_CHECKING:
    from ..state import Controller


def _destination(pipe: Doc, desc: dict[tuple[str, str], Doc]) -> set[str]:
    """Restrict automatic binding to inputs on the selected deliverable's ancestry."""
    keys = []
    for key, edge in pipe["outputs"].items():
        step = next(
            (s for s in pipe["steps"] if s["step_id"] == edge["from_step"]), None
        )
        if step is None:
            raise rejected("branch_output_has_no_producer")
        producer = desc[step["node_id"].lower(), step["component_id"]]
        if any(
            p["name"] == edge["output"] and p["type_id"] == "media.asset.v1"
            for p in producer["outputs"]
        ):
            keys.append(key)
    if "final" not in keys and len(keys) != 1:
        raise rejected("branch_needs_one_final_media_asset")
    step, _ = output_step(
        pipe, "final" if "final" in keys else keys[0], desc, "media.asset.v1"
    )
    return parents_of(step, pipe)


def _typed_input(port: Doc, available: list[tuple[str, Doc]]) -> Doc | None:
    matches = [
        (name, val) for name, val in available if val["type_id"] == port["type_id"]
    ]
    named = [v for name, v in matches if name == port["name"]]
    values = {digest(v): v for v in (named or [v for _, v in matches])}
    if len(values) == 1:
        return next(iter(values.values()))
    if port["required"]:
        raise rejected("missing_or_ambiguous_draft_input:" + port["name"])
    return None


def _source_outputs(run: Doc, output: str) -> list[tuple[str, Doc]]:
    """Keep only frozen products actually used by the chosen candidate."""
    outputs: list[tuple[str, Doc]] = []
    source_pipe = run["request"]["pipeline"]
    final_step = next(
        s
        for s in source_pipe["steps"]
        if s["step_id"] == source_pipe["outputs"][output]["from_step"]
    )
    for sid in parents_of(final_step, source_pipe):
        record = run["steps"][sid]
        if record["state"] != "succeeded":
            raise conflict("unconfirmed_draft_step")
        outputs.extend(record["outputs"].items())
    return outputs


async def _bindings(
    ctl: Controller,
    pipe: Doc,
    desc: dict[tuple[str, str], Doc],
    run: Doc,
    output: str,
) -> tuple[Doc, str]:
    asset = published_video(run, output)
    targets = _destination(pipe, desc)
    public = {p["name"]: p for p in pipe["inputs"]}
    connections = [
        (s, name, edge["from_input"])
        for s in pipe["steps"]
        if s["step_id"] in targets
        for name, edge in s["inputs"].items()
        if "from_input" in edge
    ]
    latent = []
    for step, local, name in connections:
        provider = desc[step["node_id"].lower(), step["component_id"]]
        rule = (provider.get("facts") or {}).get("draft_refinement") or {}
        if rule.get("version") == 1 and local == rule.get("latent_input"):
            latent.append((name, rule))
    inputs: Doc = {}
    frozen = list(run["request"]["inputs"].items())
    if latent:
        if len(latent) != 1 or not asset.get("source_latent"):
            raise rejected("draft_has_no_compatible_latent")
        name, rule = latent[0]
        manifest = await load_manifest(ctl, asset)
        if (
            manifest["schema_version"] != rule.get("manifest_version")
            or manifest["latent_space_id"] != rule.get("latent_space_id")
            or manifest["generation_run_id"] != run["run_id"]
        ):
            raise rejected("draft_latent_space_or_version_mismatch")
        frozen.extend(_source_outputs(run, output))
        inputs[name] = {
            "type_id": public[name]["type_id"],
            "file": asset["source_latent"]["manifest_file"],
        }
        mode = "latent"
    else:
        media = {
            name
            for _, _, name in connections
            if public[name]["type_id"] in {"media.video.v1", "media.asset.v1"}
        }
        if len(media) != 1:
            raise rejected("branch_needs_one_source_video")
        name = media.pop()
        tag = public[name]["type_id"]
        inputs[name] = {
            "type_id": tag,
            **(
                {"file": asset["file"]} if tag == "media.video.v1" else {"value": asset}
            ),
        }
        mode = "media"
    for name, port in public.items():
        if name not in inputs and (value := _typed_input(port, frozen)) is not None:
            inputs[name] = value
    return inputs, mode


async def branch_plan(ctl: Controller, pid: str, plan_id: str, spec: Doc) -> Doc:
    """Return one frozen RunRequest. Each explicit submission is a separate candidate."""
    doc = await ctl.drafts.get(pid, plan_id)
    sign(doc, spec["digest"])
    candidate = next(
        (
            c
            for c in doc["plan"]["candidates"]
            if c["candidate_id"] == spec["candidate_id"]
        ),
        None,
    )
    if (
        candidate is None
        or doc["selected"].get(candidate["shot_id"]) != candidate["candidate_id"]
    ):
        raise conflict("draft_candidate_not_selected")
    result = next(
        r for r in doc["results"] if r["candidate_id"] == candidate["candidate_id"]
    )
    receipt = result["runs"].get("draft")
    if not receipt or result["state"] not in {"ready", "review"}:
        raise conflict("draft_candidate_not_ready")
    with ctl.purge.hold_for_attach(receipt["run_id"]):
        run = await asyncio.to_thread(ctl.runs.read, receipt["run_id"])
        output = doc["plan"]["draft_output"]
        asset = published_video(run, output)
        if (
            run["state"] != "succeeded"
            or digest(run["request"]) != receipt["request_digest"]
            or digest(candidate["draft"]) != receipt["request_digest"]
            or asset != result["asset"]
        ):
            raise conflict("draft_receipt_mismatch")
        project = await asyncio.to_thread(ctl.studio.get, pid)
        shot = next(
            (s for s in project["shots"] if s["shot_id"] == candidate["shot_id"]), None
        )
        if shot is None:
            raise conflict("draft_shot_removed")
        parent = next(
            (
                t["take_id"]
                for t in shot["takes"]
                if t["run_id"] == run["run_id"] and t["output_key"] == output
            ),
            None,
        )
        pipe = await asyncio.to_thread(ctl.pipelines.get, spec["pipeline_id"])
        desc = descriptors(ctl, pipe)
        inputs, mode = await _bindings(ctl, pipe, desc, run, output)
        body = request(pipe, inputs)
        body["origin"] = {
            "studio_work": {
                "project_id": pid,
                "shot_id": shot["shot_id"],
                "operation_kind": "draft_branch",
                "source_digest": asset["file"]["sha256"],
                "recipe_digest": receipt["request_digest"],
            },
            "note": json.dumps(
                {
                    "draft_branch": {
                        "project_id": pid,
                        "plan_id": plan_id,
                        "plan_digest": doc["digest"],
                        "candidate_id": spec["candidate_id"],
                        "shot_id": shot["shot_id"],
                        "source_run_id": run["run_id"],
                        "source_output": output,
                        "source_sha256": asset["file"]["sha256"],
                        "recipe_digest": receipt["request_digest"],
                        "parent_take_id": parent,
                        "mode": mode,
                    }
                },
                separators=(",", ":"),
            ),
        }
        checked(body, desc)
        return body
