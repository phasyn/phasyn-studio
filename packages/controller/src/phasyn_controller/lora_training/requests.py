"""Run requests of a training job and the components they use (pure functions over catalog descriptors).

Every phase is an ordinary run: clip cutting, the clip review, text and reference encoding, each training
chunk, LoRA registration and the comparison renders. Inputs are literals frozen into the request, so a run
never depends on a job document that changes later.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.lora_training import constants as c


type Doc = dict[str, Any]
type Key = tuple[str, str]
TRAIN_TIMEOUT_S = 6 * 3600
CLIPS_TIMEOUT_S = 6 * 3600
REVIEW_TIMEOUT_S = 4 * 3600
ENCODE_BATCH = 12
CONDITIONING_FRAMES = 107
_STATE_RANK = {"busy": 0, "ready": 1, "loading": 2, "stopped": 3, "stopping": 4}
_TE_KEEP = ("reference_image_short_edge",)


def _literal(
    type_id: str, value: Any = None, *, file: Mapping[str, Any] | None = None
) -> Doc:
    return (
        {"literal": {"type_id": type_id, "file": dict(file)}}
        if file is not None
        else {"literal": {"type_id": type_id, "value": value}}
    )


def _dit_groups(descriptors: Mapping[Key, Doc]) -> set[tuple[str, str]]:
    """(node, resource group) of every loaded DiT: a helper component there competes with renders."""
    return {
        (key[0], str((d.get("device") or {}).get("resource_group") or ""))
        for key, d in descriptors.items()
        if d.get("provider_id") == c.PROVIDER_DIT
        and d.get("state") in ("ready", "busy", "loading")
    }


def find_component(
    descriptors: Mapping[Key, Doc],
    provider_id: str,
    *,
    prefer_node: str | None = None,
    node: str | None = None,
) -> Key | None:
    """The best component of a provider (``node`` only, else ``prefer_node`` first).

    Healthy components come first, and ones off a GPU that holds a loaded DiT when there is a choice.
    """
    crowded = _dit_groups(descriptors)
    found = [
        (key, d)
        for key, d in descriptors.items()
        if d.get("provider_id") == provider_id
        and d.get("state") != "error"
        and (node is None or key[0] == node)
    ]
    if not found:
        return None

    def rank(kd: tuple[Key, Doc]) -> tuple[bool, bool, int, str]:
        key, d = kd
        group = (key[0], str((d.get("device") or {}).get("resource_group") or ""))
        return (
            key[0] != prefer_node,
            group in crowded,
            _STATE_RANK.get(str(d.get("state")), 9),
            key[1],
        )

    return min(found, key=rank)[0]


def all_components(descriptors: Mapping[Key, Doc], provider_id: str) -> list[Key]:
    """Every healthy component of a provider, one per Node (the best of each)."""
    best: dict[str, Key] = {}
    for key, d in sorted(descriptors.items()):
        if d.get("provider_id") == provider_id and d.get("state") != "error":
            best.setdefault(key[0], key)
    return sorted(best.values())


def _step(
    sid: str, key: Key, inputs: Doc, parameters: Doc, *, timeout: int | None = None
) -> Doc:
    step: Doc = {
        "step_id": sid,
        "node_id": key[0],
        "component_id": key[1],
        "inputs": inputs,
        "parameters": parameters,
    }
    if timeout is not None:
        step["timeout_seconds"] = timeout
    return step


def _request(
    pipeline_id: str, label: str, steps: list[Doc], *, recovery: bool = False
) -> Doc:
    body: Doc = {
        "pipeline": {
            "pipeline_id": pipeline_id,
            "label": label,
            "inputs": [],
            "steps": steps,
            "outputs": {},
        },
        "inputs": {},
        "label": label,
    }
    if recovery:
        body["recovery_policy"] = "retry_verified"
    return body


def clips_request(job: Doc, key: Key) -> Doc:
    """Cut every source into clips."""
    videos = [
        {
            "file": s["file"],
            "source_id": s["source_id"],
            "label": s["label"],
            "role": s["role"],
        }
        for s in job["sources"]
    ]
    params = {"seed": int(job["options"]["seed"]) % (2**31)}
    step = _step(
        "clips",
        key,
        {"videos": _literal(c.SOURCES_TYPE, videos)},
        params,
        timeout=CLIPS_TIMEOUT_S,
    )
    return _request(
        "lora-training-clips", f"LoRA 訓練「{job['name']}」：切割片段", [step]
    )


def review_request(job: Doc, key: Key) -> Doc:
    """Review and caption every clip."""
    inputs = {
        "dataset": _literal(c.DATASET_TYPE, file=job["artifacts"]["dataset"]),
        "direction": _literal(c.DIRECTION_TYPE, job["direction"]),
    }
    step = _step("review", key, inputs, {}, timeout=REVIEW_TIMEOUT_S)
    return _request(
        "lora-training-review", f"LoRA 訓練「{job['name']}」：自動反推", [step]
    )


def _te_parameters(job: Doc, extra: Mapping[str, Any]) -> Doc:
    keep = {k: v for k, v in (job.get("te_parameters") or {}).items() if k in _TE_KEEP}
    return {
        "task": "ref2va",
        "width": c.CLIP_WIDTH,
        "height": c.CLIP_HEIGHT,
        "frames": CONDITIONING_FRAMES,
        **keep,
        **extra,
    }


def encode_request(
    job: Doc, clips: Sequence[Doc], keys: Mapping[str, Key], batch: int
) -> Doc:
    """Text conditioning and reference encoding of a batch of training clips (two steps per clip)."""
    steps = []
    for i, clip in enumerate(clips):
        materials = [
            {"file": ref, "role": "reference_image"} for ref in clip["references"]
        ]
        steps.append(
            _step(
                f"c{i}",
                keys["conditioning"],
                {
                    "prompt": _literal("text.prompt.v1", clip["caption"]),
                    "materials": _literal("h3.materials.v1", materials),
                },
                _te_parameters(job, {}),
            )
        )
        refs = {
            "prepared": {"from_step": f"c{i}", "output": "prepared"},
            "job": {"from_step": f"c{i}", "output": "job"},
        }
        steps.append(_step(f"v{i}", keys["video_encode"], refs, {}))
    return _request(
        "lora-training-encode",
        f"LoRA 訓練「{job['name']}」：編碼第 {batch + 1} 批",
        steps,
    )


def silence_request(job: Doc, keys: Mapping[str, Key], image: Mapping[str, Any]) -> Doc:
    """The encoded silence every training clip uses as its audio target."""
    materials = [
        {"file": dict(image), "role": "reference_image"},
        {"file": job["artifacts"]["silence"], "role": "reference_audio"},
    ]
    steps = [
        _step(
            "prep",
            keys["conditioning"],
            {
                "prompt": _literal("text.prompt.v1", "silence"),
                "materials": _literal("h3.materials.v1", materials),
            },
            _te_parameters(job, {"phase": "prepare"}),
        ),
        _step(
            "audio",
            keys["audio_encode"],
            {
                "prepared": {"from_step": "prep", "output": "prepared"},
                "job": {"from_step": "prep", "output": "job"},
            },
            {},
        ),
    ]
    return _request(
        "lora-training-silence", f"LoRA 訓練「{job['name']}」：靜音參考", steps
    )


def train_request(job: Doc, key: Key, until: int) -> Doc:
    """One training chunk; a verified stopped attempt may be replaced once (the trainer resumes)."""
    t = job["training"]
    params = {
        "job_key": job["job_key"],
        "steps": int(t["steps"]),
        "until_step": int(until),
    }
    params.update(
        {
            k: t["parameters"][k]
            for k in t["parameters"]
            if k not in ("steps", "chunk_steps")
        }
    )
    step = _step(
        "train",
        key,
        {"encodings": _literal(c.ENCODINGS_TYPE, file=job["artifacts"]["encodings"])},
        params,
        timeout=TRAIN_TIMEOUT_S,
    )
    return _request(
        "lora-training-train",
        f"LoRA 訓練「{job['name']}」：訓練到第 {until} 步",
        [step],
        recovery=True,
    )


def register_request(
    job: Doc,
    keys: Sequence[Key],
    lora: Mapping[str, Any],
    manifest: Doc,
    *,
    candidate: bool,
) -> Doc:
    """Place the LoRA and its manifest on every listed Node."""
    params: Doc = {"lora_id": manifest["lora_id"]}
    if candidate:
        params["candidate_of"] = job["job_key"]
    steps = [
        _step(
            f"r{i}",
            key,
            {
                "lora": _literal(c.LORA_FILE_TYPE, file=lora),
                "manifest": _literal(c.MANIFEST_TYPE, manifest),
            },
            params,
        )
        for i, key in enumerate(keys)
    ]
    what = "比較用登錄" if candidate else "登錄"
    return _request(
        "lora-training-register", f"LoRA 訓練「{job['name']}」：{what}", steps
    )


# ------------------------------------------------------------------------------------------------ comparison
def dit_step_of(template: Doc) -> Doc:
    """The template's single h3.dit step (the one a strength replaces)."""
    steps = [
        s for s in template["pipeline"]["steps"] if s.get("_provider") == c.PROVIDER_DIT
    ]
    if len(steps) != 1:
        raise ComponentError(
            "INVALID_ARGUMENT", "比較用的流程必須剛好有一個 H3 DiT 步驟"
        )
    return steps[0]


def annotate(template: Mapping[str, Any], descriptors: Mapping[Key, Doc]) -> Doc:
    """A copy of a saved pipeline whose steps carry their provider (for the DiT, TE and output lookups)."""
    pipe = copy.deepcopy(dict(template))
    for s in pipe["steps"]:
        d = descriptors.get((str(s["node_id"]).lower(), str(s["component_id"])))
        if d is None:
            raise ComponentError(
                "COMPONENT_NOT_READY",
                f"比較用流程的元件 {s['component_id']} 不在目錄中",
            )
        s["_provider"] = d.get("provider_id")
    return {"pipeline": pipe}


def asset_output(template: Doc) -> tuple[str, str]:
    """(step, output) of the template's final video asset."""
    outputs = template["pipeline"].get("outputs") or {}
    ref = outputs.get("asset") or next(
        (v for k, v in outputs.items() if "asset" in k), None
    )
    if ref is None:
        raise ComponentError("INVALID_ARGUMENT", "比較用流程沒有成品影片輸出（asset）")
    return str(ref["from_step"]), str(ref["output"])


def _clean(step: Doc) -> Doc:
    return {k: v for k, v in step.items() if not k.startswith("_")}


def render_request(  # noqa: PLR0913 - one comparison cell
    job: Doc,
    template: Doc,
    *,
    items: Sequence[Doc],
    dit: Key,
    route: Doc,
    label: str,
) -> Doc:
    """Every evaluation item rendered once with the template, its DiT step on ``dit`` (same prompt and seed)."""
    pipe = template["pipeline"]
    dit_sid = dit_step_of(template)["step_id"]
    opts = job["options"]
    steps = []
    for j, item in enumerate(items):
        prefix = f"e{j}_"
        for s in pipe["steps"]:
            step = copy.deepcopy(_clean(s))
            step["step_id"] = prefix + s["step_id"]
            inputs = {}
            for port, binding in (s.get("inputs") or {}).items():
                if "from_step" in binding:
                    inputs[port] = {
                        "from_step": prefix + binding["from_step"],
                        "output": binding["output"],
                    }
                elif binding.get("from_input") == "prompt":
                    inputs[port] = _literal("text.prompt.v1", item["prompt"])
                elif binding.get("from_input") == "materials":
                    inputs[port] = _literal(
                        "h3.materials.v1",
                        [
                            {"file": r, "role": "reference_image"}
                            for r in item["references"]
                        ],
                    )
                elif "literal" in binding:
                    inputs[port] = binding
                else:
                    raise ComponentError(
                        "INVALID_ARGUMENT",
                        f"比較用流程的輸入 {binding.get('from_input')} 無法自動填入",
                    )
            step["inputs"] = inputs
            if s.get("_provider") == c.PROVIDER_CONDITIONING:
                step["parameters"] = {
                    **step.get("parameters", {}),
                    "task": "ref2va",
                    "width": int(opts["eval_width"]),
                    "height": int(opts["eval_height"]),
                    "frames": int(opts["eval_frames"]),
                }
            if s["step_id"] == dit_sid:
                step["node_id"], step["component_id"] = dit
                step["parameters"] = {
                    **step.get("parameters", {}),
                    **dict(route.get("dit_parameters") or {}),
                    "seed": int(opts["seed"]),
                }
            steps.append(step)
    return _request(f"lora-training-compare-{route['route_id']}", label, steps)


def eval_definition(
    base: Doc, *, component_id: str, manifest_path: str | None, strength: float
) -> Doc:
    """The comparison DiT: the route's DiT definition with this job's LoRA at ``strength`` (none at 0)."""
    stored = copy.deepcopy(base["settings"]["stored"])
    po = stored.setdefault("load", {}).setdefault("provider_options", {})
    has_base_lora = bool(po.get("lora")) or bool(po.get("loras"))
    ours = (
        None
        if strength <= 0 or manifest_path is None
        else {"manifest_path": manifest_path, "scale": float(strength)}
    )
    if has_base_lora and ours is not None:
        props = (
            (base["settings"].get("settings_schema") or {}).get("properties") or {}
        ).get("load", {})
        options = ((props.get("properties") or {}).get("provider_options") or {}).get(
            "properties"
        ) or {}
        if "loras" not in options:
            raise ComponentError(
                "UNSUPPORTED_SETTING",
                "這條比較路線的 DiT 已經套用一個 LoRA；這個版本的 DiT 不能同時疊加第二個 LoRA",
                status=422,
            )
        stacked = list(po.pop("loras", None) or [po.get("lora")])
        po["lora"] = None
        po["loras"] = [*stacked, ours]
    elif ours is not None:
        po["lora"] = ours
    return {
        "component_id": component_id,
        "label": f"LoRA 比較用 DiT（自動建立，來源 {base['component_id']}）",
        "provider_id": base["provider_id"],
        "runtime_id": base["runtime_id"],
        "settings": stored,
        "folder": "訓練/比較",
        "load_policy": "on_demand",
        "idle_unload_seconds": 300,
        **(
            {"exclusive_group": base["exclusive_group"]}
            if base.get("exclusive_group")
            else {}
        ),
    }


__all__ = [
    "ENCODE_BATCH",
    "all_components",
    "annotate",
    "asset_output",
    "clips_request",
    "dit_step_of",
    "encode_request",
    "eval_definition",
    "find_component",
    "register_request",
    "render_request",
    "review_request",
    "silence_request",
    "train_request",
]
