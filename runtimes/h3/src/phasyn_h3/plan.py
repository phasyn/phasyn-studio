"""H3 plan building: ``phasyn_h3.recipe.adapter`` resolves the plan fields the recipe stages need.

The same ``job`` (task, prompt, canvas, frames, material descriptors) yields the same geometry in every
component process; the DiT adds its own sampling (seed / steps / shifts).  Plans never touch a database.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.model_identity import display_path

from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.abi.contracts import schema_default
from phasyn_h3.recipe.abi.errors import ApiError
from phasyn_h3.recipe.abi.resolve import ResolveContext
from phasyn_h3.recipe.abi.values import deep_merge, set_path
from phasyn_h3.recipe.adapter import MODEL_DEFAULTS, H3Adapter, local_manifest
from phasyn_h3.recipe.adapter.loras import pdd_blocks_problems

from . import refimage
from .config import TASK_VARIANT


FPS = 24
DEFAULT_OUTPUT = {
    "fps": FPS,
    "duration_policy": "preserve_generated",
    "container": "mp4",
    "video_codec": "h264",
    "audio_codec": "aac",
    "pixel_format": "yuv420p",
    "quality": 18,
    "encode_provider": "cpu_ffmpeg",
    "audio_bitrate": 192000,
    "frame_delivery": "local_encode",
}
MATERIAL_ROLES = (
    "first_frame",
    "last_frame",
    "reference_image",
    "reference_video",
    "reference_audio",
)
# Extra directories (os.pathsep-separated) searched for LoRA manifests given as relative paths.
LORA_MANIFEST_DIRS_ENV = "PHASYN_H3_LORA_MANIFEST_DIRS"
BUNDLED_LORA_DIR = Path(__file__).resolve().parent / "loras"
DEFAULT_PLAN_SAMPLING = {
    "seed": 42,
    "steps": 8,
    "video_shift": 12.0,
    "audio_shift": 3.0,
}


def material_descriptor(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
    ref: Mapping[str, Any],
    *,
    role: str,
    probe_info: Mapping[str, Any],
    start_seconds: float | None = None,
    end_seconds: float | None = None,
    use_embedded_audio: bool | None = None,
    hold_last_frame: bool | None = None,
) -> dict[str, Any]:
    """Describe the media supplied to the H3 job."""
    if role not in MATERIAL_ROLES:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"素材角色 {role} 不支援；可用：{', '.join(MATERIAL_ROLES)}",
        )
    out: dict[str, Any] = {
        "role": role,
        "file": dict(ref),
        "sha256": str(ref["sha256"]),
        "size_bytes": int(ref["size_bytes"]),
        "media_type": str(ref.get("media_type") or "application/octet-stream"),
        "probe": dict(probe_info),
    }
    if start_seconds is not None:
        out["start_seconds"] = float(start_seconds)
    if end_seconds is not None:
        out["end_seconds"] = float(end_seconds)
    if use_embedded_audio is not None:
        out["use_embedded_audio"] = bool(use_embedded_audio)
    if (
        hold_last_frame is not None
    ):  # kept as given: the adapter rejects a non-boolean or a role other than video
        out["hold_last_frame"] = hold_last_frame
    return out


def make_job(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
    *,
    task: str,
    prompt: str,
    width: int,
    height: int,
    frames: int,
    variant: str,
    materials: Sequence[Mapping[str, Any]],
    shared_from: str | None = None,
) -> dict[str, Any]:
    """Build the H3 job from the declared task and input materials."""
    if task not in TASK_VARIANT:
        raise ComponentError(
            "INVALID_ARGUMENT", f"task 必須是 {', '.join(TASK_VARIANT)}"
        )
    if TASK_VARIANT[task] != variant:
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"task {task} 需要 {TASK_VARIANT[task]} checkpoint，此元件設定為 {variant}",
        )
    if not prompt or not prompt.strip():
        raise ComponentError("INVALID_ARGUMENT", "prompt 不可為空")
    return {
        "schema": "h3.job.v1",
        "task": task,
        "prompt": prompt,
        "width": int(width),
        "height": int(height),
        "frames": int(frames),
        "fps": FPS,
        "variant": variant,
        "shared_from": shared_from,
        "materials": [copy.deepcopy(dict(m)) for m in materials],
    }


def _artifact(m: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "artifact_id": f"sha256:{m['sha256']}",
        "sha256": m["sha256"],
        "size_bytes": int(m["size_bytes"]),
        "media_type": m["media_type"],
    }


def file_digest(path: Path) -> str:
    """Compute the identity used to compare input file references."""
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for block in iter(lambda: fh.read(8 << 20), b""):
            h.update(block)
    return h.hexdigest()


def model_manifest(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
    *,
    variant: str,
    shared_from: str | None,
    transformer_file: str | None,
    model_root: Path,
    cache_dir: Path,
    model_id: str | None = None,
) -> dict[str, Any]:
    """Model manifest of the local snapshot.

    ``model_id`` is for VAE components only: plans of both variants then share one component identity (same directory, same component_id), so a resident VAE is not reloaded because a job's variant differs.
    """
    digest = None
    if transformer_file:
        path = model_root / transformer_file
        st = path.stat()
        key = hashlib.sha256(
            f"{path}:{st.st_size}:{st.st_mtime_ns}".encode()
        ).hexdigest()[:24]
        cache = cache_dir / f"sha256-{key}.txt"
        if cache.is_file():
            digest = cache.read_text().strip()
        else:  # hashed once per file identity (first use or change), not on every call
            digest = file_digest(path)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(digest)
    return local_manifest(
        variant,
        model_id=model_id,
        shared_from=shared_from,
        transformer_file=transformer_file,
        transformer_digest=digest,
    )


def lora_manifest_candidates(
    manifest_path: str, *, model_root: Path, env: Mapping[str, str] | None = None
) -> list[Path]:
    """Where a LoRA manifest is looked up, in order.

    An absolute path is used as is.  A relative one is tried under ``<model_root>``, ``<model_root>/loras``,
    every directory of ``PHASYN_H3_LORA_MANIFEST_DIRS`` and finally the manifests bundled with ``phasyn_h3``.
    """
    path = Path(manifest_path)
    if path.is_absolute():
        return [path]
    extra = (os.environ if env is None else env).get(LORA_MANIFEST_DIRS_ENV, "")
    bases = [
        model_root,
        model_root / "loras",
        *(Path(d) for d in extra.split(os.pathsep) if d),
        BUNDLED_LORA_DIR,
    ]
    return [base / path for base in bases]


def lora_binding(
    manifest_path: str, *, scale: float, model_root: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    """LoRA binding from its manifest; the runtime re-verifies the file's sha256 when the DiT loads."""
    candidates = lora_manifest_candidates(manifest_path, model_root=model_root)
    path = next((c for c in candidates if c.is_file()), None)
    if path is None:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED",
            f"找不到 LoRA manifest {manifest_path}（依序找過 load.model_path、load.model_path/loras、"
            f"{LORA_MANIFEST_DIRS_ENV} 與內建 manifest）",
            details={"manifest_path": manifest_path},
        )
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED",
            f"無法讀取 LoRA manifest {display_path(path, model_root)}：{type(exc).__name__}: {exception_message(exc)}",
        ) from exc
    file = manifest.get("file") or {}
    lora_path = model_root / str(file.get("relative_path", ""))
    if not lora_path.is_file():
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED",
            f"LoRA 檔不存在：{display_path(lora_path, model_root)}",
        )
    if file.get("size_bytes") is not None and lora_path.stat().st_size != int(
        file["size_bytes"]
    ):
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"LoRA 檔大小與 manifest 不同：{display_path(lora_path, model_root)}",
        )

    problems = pdd_blocks_problems(manifest)
    if problems:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED",
            f"LoRA manifest {display_path(path, model_root)} 的 pdd.blocks 不能執行：{'；'.join(problems)}",
            details={"manifest_path": manifest_path, "problems": problems},
        )
    manifest = {**manifest, "status": "verified"}
    binding = {
        "lora_id": manifest["lora_id"],
        "revision": manifest["source_revision"],
        "scale": float(scale),
        "manifest": manifest,
    }
    return binding, manifest


def build_plan(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
    job: Mapping[str, Any],
    profile: Mapping[str, Any],
    *,
    model: Mapping[str, Any],
    sampling: Mapping[str, Any] | None = None,
    lora_bindings: Sequence[Mapping[str, Any]] = (),
    output: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], bytes | None]:
    """回傳 (plan, sigma_payload).

    sigma_payload 的 sha256 等於 plan.schedule.sigmas_digest。
    """
    image_edge = refimage.of_job(job)
    sampling = {**DEFAULT_PLAN_SAMPLING, **dict(sampling or {})}
    materials = list(job.get("materials") or [])
    request = {
        "schema_version": "1.0",
        "model_id": model["model_id"],
        "task": job["task"],
        "prompt": {"text": job["prompt"], "context_mode": "verbatim"},
        "materials": [
            {
                "artifact": _artifact(m),
                "role": m["role"],
                **{
                    k: m[k]
                    for k in (
                        "start_seconds",
                        "end_seconds",
                        "use_embedded_audio",
                        "hold_last_frame",
                    )
                    if k in m
                },
            }
            for m in materials
        ],
        "output": {
            **DEFAULT_OUTPUT,
            "requested_seconds": int(job["frames"]) / FPS,
            "width": int(job["width"]),
            "height": int(job["height"]),
            **dict(output or {}),
        },
        "sampling": {
            "steps": int(sampling["steps"]),
            "video_shift": float(sampling["video_shift"]),
            "audio_shift": float(sampling["audio_shift"]),
            "seed": str(int(sampling["seed"])),
            "scheduler": "h3_euler",
        },
        "profile_id": profile["profile_id"],
        "profile_revision": int(profile["revision"]),
        "priority": 5,
        "allow_experimental": profile.get("mode") == "experimental",
        "allow_external_processing": False,
    }
    request["client_request_id"] = request_id(
        request, reference_image_short_edge=image_edge
    )
    full_profile = deep_merge(
        schema_default("runtime-profile.schema.json"), dict(profile)
    )
    defaults: dict[str, Any] = {}
    for key, value in MODEL_DEFAULTS.items():
        set_path(defaults, key, value)
    effective_request = deep_merge(
        deep_merge(schema_default("job-request.schema.json"), defaults), request
    )
    metadata = {f"sha256:{m['sha256']}": dict(m.get("probe") or {}) for m in materials}
    try:
        resolved = H3Adapter().resolve(
            ResolveContext(
                request=effective_request,
                model=dict(model),
                profile=full_profile,
                config={refimage.PARAM: image_edge} if image_edge is not None else {},
                material_metadata=metadata,
                model_facts={},
                lora_bindings=list(lora_bindings),
            )
        )
    except ApiError as exc:
        # a SemanticError's details are the adapter diagnostics: put the first reasons into the message
        reasons = _error_reasons(exc.details)
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"H3 參數不合法：{exc.message}"
            + (f"（{'；'.join(reasons)}）" if reasons else ""),
            details={"field_path": exc.field_path, "details": exc.details},
        ) from exc
    # anything else is a bug, not a rejected combination: it propagates (the component reports RUNTIME_ERROR)
    plan: dict[str, Any] = {
        "requested": request,
        "effective_profile": full_profile,
        "geometry": resolved.geometry,
        "schedule": resolved.schedule,
        "model": dict(model),
        "model_digest": canonical_digest(dict(model)),
    }
    if lora_bindings:
        plan["loras"] = [dict(b) for b in lora_bindings]
    return plan, resolved.sigma_payload


def request_id(
    request: Mapping[str, Any], *, reference_image_short_edge: int | None = None
) -> str:
    """The plan's ``client_request_id``, derived from the rest of the request (canonical digest → UUIDv5).

    No random input goes into a plan: the same request always gives the same plan digest.
    """
    body = {key: value for key, value in request.items() if key != "client_request_id"}
    if reference_image_short_edge is not None:
        body["experimental_preprocessing"] = {
            "reference_image_short_edge": reference_image_short_edge
        }
    return str(
        uuid.uuid5(
            uuid.NAMESPACE_URL, "urn:phasyn:h3:job-request:" + canonical_digest(body)
        )
    )


def geometry_digest(plan: Mapping[str, Any]) -> str:
    """Identify the geometry used to pack the job."""
    return str(canonical_digest(dict(plan["geometry"])))


# recipe/runtime/quantized_cache.py reads the cache directory from here (absent: the cache is off)
QUANTIZED_CACHE_ENV = "PHASYN_H3_QUANTIZED_CACHE_DIR"

# The caching allocator's settings: the current name first, then its backward-compatible alias (torch 2.14).
ALLOCATOR_CONF_ENV = ("PYTORCH_ALLOC_CONF", "PYTORCH_CUDA_ALLOC_CONF")
DIT_ALLOCATOR_CONF = "expandable_segments:True"


def streams_decoder_weights(role: str, options: Mapping[str, Any]) -> bool:
    """Whether a video_decode component has ``provider_options.weight_streaming.enabled`` (config.py)."""
    raw = options.get("weight_streaming")
    return (
        role == "video_decode"
        and isinstance(raw, Mapping)
        and raw.get("enabled") is True
    )


def streams_encoder_frames(role: str, options: Mapping[str, Any]) -> bool:
    """Whether a video_encode component has ``provider_options.frame_streaming.enabled`` (config.py)."""
    raw = options.get("frame_streaming")
    return (
        role == "video_encode"
        and isinstance(raw, Mapping)
        and raw.get("enabled") is True
    )


def apply_runtime_env(
    *, model_root: Path, options: Mapping[str, Any], role: str
) -> dict[str, str]:
    """Environment the recipe reads (must be set before torch / sglang are imported)."""
    env = {"PHASYN_MODEL_ROOT": str(model_root), "PHASYN_ACTOR_CUDA_NARROWED": "1"}
    expandable = (
        role == "dit"
        or streams_decoder_weights(role, options)
        or streams_encoder_frames(role, options)
    )
    if expandable and not any(os.environ.get(name) for name in ALLOCATOR_CONF_ENV):
        # The caching allocator grows one segment per stream instead of one per allocation, so the memory a call
        # frees between its stages can serve a larger block later. Without it a 16 GB card ran its first 720P ref2va
        # call and failed the second with the same shapes: 3.2 GiB reserved but unallocated, 1.9 GiB requested.
        # The weight-streaming video decode runs near a ~2 GB budget: without it the first clip already
        # reserved 1,988 MiB and the second clip's 302 MiB output failed; with it reserved stays ~60 MiB above
        # allocated. The frame-streaming encode allocates pass-sized tensors of many sizes on a small shared GPU;
        # there it keeps reserved close to allocated. The allocator reads it at its first CUDA allocation; an
        # operator's own setting is left alone.
        env[ALLOCATOR_CONF_ENV[0]] = DIT_ALLOCATOR_CONF
    if options.get("adaln_cache_root"):
        env["PHASYN_ADALN_CACHE_ROOT"] = str(options["adaln_cache_root"])
    if options.get("jit_cache_dir"):
        env["PHASYN_JIT_CACHE_DIR"] = str(options["jit_cache_dir"])
    env["PHASYN_H3_BOUNDED_FP8_LOAD"] = (
        "1" if (role == "dit" and options.get("bounded_fp8_load")) else "0"
    )
    cache = options.get("quantized_cache")
    if (
        role == "dit"
        and isinstance(cache, Mapping)
        and cache.get("enabled") is True
        and cache.get("dir")
    ):
        env[QUANTIZED_CACHE_ENV] = str(cache["dir"])
    if role == "dit" and options.get("bounded_fp8_load"):
        # On a unified-memory GPU, where the device shares host memory, the pinned loader hands the checkpoint
        # load a HostSpill, and the bounded loader refuses a load it cannot replace. It stages every leaf itself,
        # so the spill has nothing to hold: switch it off through SGLang's own per-process flag.
        env["SGLANG_DIFFUSION_DISABLE_HOST_SPILL"] = "1"
    os.environ.update(env)
    return env


__all__ = [
    "ALLOCATOR_CONF_ENV",
    "BUNDLED_LORA_DIR",
    "DEFAULT_OUTPUT",
    "DIT_ALLOCATOR_CONF",
    "FPS",
    "LORA_MANIFEST_DIRS_ENV",
    "MATERIAL_ROLES",
    "QUANTIZED_CACHE_ENV",
    "apply_runtime_env",
    "build_plan",
    "file_digest",
    "geometry_digest",
    "lora_binding",
    "lora_manifest_candidates",
    "make_job",
    "material_descriptor",
    "model_manifest",
    "request_id",
    "streams_decoder_weights",
    "streams_encoder_frames",
]


def _error_reasons(details: object) -> list[str]:
    return [
        str(d.get("message"))
        for d in (details if isinstance(details, list) else [])
        if isinstance(d, Mapping)
        and d.get("severity", "error") == "error"
        and d.get("message")
    ][:3]
