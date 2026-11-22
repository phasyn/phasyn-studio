"""Freeze the owner's saved pipelines, shot prompts, input files and the complete candidate budget."""

from __future__ import annotations

import copy
from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.canonical import canonical_json, digest
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id

from ..purge import referenced_files
from ..revisions import require_revision
from ..runner.plan import DEFAULT_TIMEOUT_SECONDS, plan_run
from .budget import fingerprint_fields, pin_budget_revisions, reservations


if TYPE_CHECKING:
    from ..state import Controller

type Doc = dict[str, Any]
_MAX_CANDIDATES = 32
_MAX_PLAN_BYTES = 1_000_000


def rejected(reason: str) -> ComponentError:
    """Build a draft validation error containing the failed requirement."""
    return ComponentError(
        "INVALID_ARGUMENT", "草稿計畫未通過檢查", details={"reason": reason}
    )


def descriptors(ctl: Controller, pipeline: Doc) -> dict[tuple[str, str], Doc]:
    """Read the descriptors named by the proposed pipeline."""
    return ctl.catalog.descriptors(
        {(s["node_id"].lower(), s["component_id"]) for s in pipeline["steps"]}
    )


def settings_fingerprint(
    desc: dict[tuple[str, str], Doc], budget: Doc | None = None
) -> dict[str, str]:
    # Runtime utilization and progress vary between calls. Keep provider identity, load revision,
    # and actual configured load/invoke settings, which determine what the approved pipeline runs.
    """Fingerprint the settings that must stay fixed after approval."""
    return {
        node + "/" + component: digest(
            {
                "provider_id": data["provider_id"],
                "stored": (data.get("settings") or {}).get("stored"),
                "loaded_revision": (data.get("settings") or {}).get("loaded_revision"),
                **fingerprint_fields(data, budget),
            }
        )
        for (node, component), data in desc.items()
    }


def checked(body: Doc, desc: dict[tuple[str, str], Doc]) -> None:
    """Validate the proposed run against the selected components."""
    contracts.validate("RunRequest", body)
    plan_run(body, desc)


def output_step(
    pipeline: Doc, key: str, desc: dict[tuple[str, str], Doc], out_type: str
) -> tuple[Doc, Doc]:
    """Find the step that publishes an output with the requested type."""
    edge = pipeline["outputs"].get(key) or {}
    for step in pipeline["steps"]:
        if step["step_id"] == edge.get("from_step"):
            descriptor = desc[(step["node_id"].lower(), step["component_id"])]
            if any(
                p["name"] == edge["output"] and p["type_id"] == out_type
                for p in descriptor["outputs"]
            ):
                return step, descriptor
    raise rejected("output_type_or_key_mismatch")


def parents_of(step: Doc, pipe: Doc) -> set[str]:
    """Collect the upstream steps needed to produce the candidate."""
    steps = {s["step_id"]: s for s in pipe["steps"]}
    pending = [step["step_id"]]
    seen = set()
    while pending:
        sid = pending.pop()
        if sid not in seen:
            seen.add(sid)
            pending.extend(
                i["from_step"]
                for i in steps[sid]["inputs"].values()
                if "from_step" in i
            )
    return seen


def request(pipe: Doc, inputs: Doc) -> Doc:
    """Build an observe-only run request from frozen inputs."""
    return {"pipeline": pipe, "inputs": inputs, "recovery_policy": "observe_only"}


def _seed_parameter(descriptor: Doc) -> str:
    schema = (descriptor.get("settings") or {}).get("parameters_schema") or {}
    fields = schema.get("properties") or {}
    facts = descriptor.get("facts") or {}
    if "studio_generation" not in facts:
        if "seed" in fields:
            return "seed"
        raise rejected("seed_step_has_no_declared_seed")
    declaration = facts["studio_generation"]
    if (
        not isinstance(declaration, dict)
        or type(declaration.get("version")) is not int
        or declaration["version"] != 1
    ):
        raise rejected("invalid_seed_binding")
    names = declaration.get("parameters")
    alias = names.get("seed") if isinstance(names, dict) else None
    if (
        not isinstance(alias, str)
        or not isinstance(fields.get(alias), dict)
        or fields[alias].get("type") != "integer"
    ):
        raise rejected("invalid_seed_binding")
    return alias


def _validate_draft_bindings(
    source: Doc, spec: Doc, gen_desc: dict[tuple[str, str], Doc]
) -> None:
    final, _ = output_step(source, spec["output_key"], gen_desc, "media.asset.v1")
    parents = parents_of(final, source)
    seed_step = spec["seed_step"]
    prompt = spec["prompt_input"]
    if seed_step not in parents or not any(
        s["step_id"] in parents
        and any(i.get("from_input") == prompt for i in s["inputs"].values())
        for s in source["steps"]
    ):
        raise rejected("prompt_and_seed_must_drive_the_selected_output")
    for s in source["steps"]:
        if s["step_id"] == seed_step:
            descriptor = gen_desc[(s["node_id"].lower(), s["component_id"])]
            _seed_parameter(descriptor)


def _review_capability(descriptor: Doc) -> tuple[str, str] | None:
    declaration = (descriptor.get("facts") or {}).get("studio_review")
    if declaration is None:
        return {
            "media.probe": ("probe", "media"),
            "media.frame": ("frame", "video_file"),
        }.get(descriptor["provider_id"])
    if not isinstance(declaration, dict) or set(declaration) != {
        "version",
        "operation",
        "input",
    }:
        return None
    kind, port = declaration["operation"], declaration["input"]
    if (
        type(declaration["version"]) is not int
        or declaration["version"] != 1
        or kind not in ("probe", "frame")
        or not isinstance(port, str)
    ):
        return None
    if not any(
        p["name"] == port
        and p["type_id"] == "media.video.v1"
        and p["transport"] in ("file", "either")
        for p in descriptor["inputs"]
    ):
        return None
    return kind, port


def _validate_qc(qc: Doc, spec: Doc, qc_desc: dict[tuple[str, str], Doc]) -> None:
    probe, probe_desc = output_step(qc, spec["qc_output"], qc_desc, "media.probe.v1")
    declaration = _review_capability(probe_desc)
    if (
        declaration is None
        or declaration[0] != "probe"
        or probe["inputs"].get(declaration[1]) != {"from_input": spec["qc_input"]}
        or any(_review_capability(d) is None for d in qc_desc.values())
    ):
        raise rejected("qc_requires_a_direct_media_probe")
    dummy = {
        "type_id": "media.video.v1",
        "file": {
            "node_id": new_id(),
            "file_id": new_id(),
            "sha256": "0" * 64,
            "size_bytes": 1,
            "media_type": "video/mp4",
            "metadata": {},
        },
    }
    checked(request(qc, {spec["qc_input"]: dummy}), qc_desc)


def _shot_inputs(
    shot: Doc | None, entry: Doc, prompt: str, ports: Doc, items: Doc
) -> Doc:
    if (
        not shot
        or not shot.get("prompt", "").strip()
        or shot.get("references")
        or (shot.get("continuity") or {}).get("mode", "none") != "none"
    ):
        raise rejected("shot_missing_or_requires_model_specific_conditioning")
    inputs = {prompt: {"type_id": "text.prompt.v1", "value": shot["prompt"]}}
    for port, iid in entry.get("library_inputs", {}).items():
        item = items.get(iid)
        p = ports.get(port)
        if (
            not p
            or not item
            or p["type_id"] != "media." + item["kind"] + ".v1"
            or port == prompt
        ):
            raise rejected("unbound_or_cross_project_library_input")
        inputs[port] = {"type_id": p["type_id"], "file": item["file"]}
    return inputs


def _candidates(
    project: Doc,
    source: Doc,
    spec: Doc,
    items: Doc,
    gen_desc: dict[tuple[str, str], Doc],
) -> list[Doc]:
    prompt, seed_step = spec["prompt_input"], spec["seed_step"]
    shots = {s["shot_id"]: s for s in project["shots"]}
    ports = {p["name"]: p for p in source["inputs"]}
    if (ports.get(prompt) or {}).get("type_id") != "text.prompt.v1" or project.get(
        "prompt_plugins"
    ):
        raise rejected("explicit_prompt_binding_required")
    candidates: list[Doc] = []
    for entry in spec["shots"]:
        shot = shots.get(entry["shot_id"])
        inputs = _shot_inputs(shot, entry, prompt, ports, items)
        for index in range(spec["variants"]):
            seed = spec["seed"] + len(candidates)
            pipe = copy.deepcopy(source)
            for s in pipe["steps"]:
                if s["step_id"] == seed_step:
                    desc = gen_desc[(s["node_id"].lower(), s["component_id"])]
                    s["parameters"] = {
                        **s.get("parameters", {}),
                        _seed_parameter(desc): seed,
                    }
            candidate = {
                "candidate_id": f"c{len(candidates) + 1}",
                "shot_id": entry["shot_id"],
                "variant": index + 1,
                "seed": seed,
                "draft": request(pipe, inputs),
            }
            candidate["draft"]["origin"] = {
                "studio_work": {
                    "project_id": project["project_id"],
                    "shot_id": entry["shot_id"],
                    "operation_kind": "draft",
                }
            }
            checked(candidate["draft"], gen_desc)
            candidates.append(candidate)
    return candidates


def planned(ctl: Controller, pid: str, plan_id: str, spec: Doc) -> Doc:
    """Validate the project, candidate matrix, pipeline and total budget."""
    contracts.validate("StudioDraftPlanRequest", spec)
    project = ctl.studio.get(pid)
    require_revision(
        project["revision"],
        spec["project_revision"],
        what="專案",
        suffix="請重新讀取專案",
    )
    cfg = spec["budget"]
    n = spec["variants"] * len(spec["shots"])
    source = ctl.pipelines.get(spec["pipeline_id"])
    qc = ctl.pipelines.get(spec["qc_pipeline_id"])
    if (
        n > _MAX_CANDIDATES
        or 2 * n > cfg["max_runs"]
        or n * (len(source["steps"]) + len(qc["steps"])) > cfg["max_step_attempts"]
    ):
        raise rejected("budget_exceeded")
    if (
        len({s["shot_id"] for s in spec["shots"]}) != len(spec["shots"])
        or spec["seed"] + n - 1 > 2**53 - 1
    ):
        raise rejected("duplicate_shot_or_invalid_seed_range")
    source, qc = copy.deepcopy(source), copy.deepcopy(qc)
    for pipe in (source, qc):
        for s in pipe["steps"]:
            s["node_id"] = s["node_id"].lower()
            s["timeout_seconds"] = min(
                cfg["timeout_seconds"],
                s.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS),
            )
    gen_desc, qc_desc = descriptors(ctl, source), descriptors(ctl, qc)
    pin_budget_revisions(source, gen_desc, cfg)
    pin_budget_revisions(qc, qc_desc, cfg)
    _validate_draft_bindings(source, spec, gen_desc)
    _validate_qc(qc, spec, qc_desc)
    items = {i["item_id"]: i for i in project.get("library", [])}
    available = [i["file"] for i in items.values()]
    if any(
        ref not in available for pipe in (source, qc) for ref in referenced_files(pipe)
    ):
        raise rejected("saved_pipeline_contains_other_files")
    candidates = _candidates(project, source, spec, items, gen_desc)
    summary = {
        "project_id": pid,
        "plan_id": plan_id,
        "project_revision": spec["project_revision"],
        "budget": cfg,
        "planned_runs": 2 * n,
        "planned_step_attempts": n * (len(source["steps"]) + len(qc["steps"])),
        **reservations(candidates, gen_desc, qc, qc_desc, cfg),
        "project_created_at": project["created_at"],
        "components": {
            "draft": settings_fingerprint(gen_desc, cfg),
            "qc": settings_fingerprint(qc_desc, cfg),
        },
        "draft_output": spec["output_key"],
        "qc_pipeline": qc,
        "qc_input": spec["qc_input"],
        "qc_output": spec["qc_output"],
        "candidates": candidates,
    }
    if len(canonical_json(summary)) > _MAX_PLAN_BYTES:
        raise rejected("plan_exceeds_size_limit")
    return summary
