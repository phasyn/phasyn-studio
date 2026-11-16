#!/usr/bin/env python3
"""Generate MiniMax H3 DiT component definitions (InstanceDefinition JSON) for one GPU.

``examples/components/`` ships a few representative DiT templates; this script writes the whole
variant x precision x acceleration grid with the same rules, for your model path and GPU::

    python3 examples/generate_dit_components.py --out my-dits \\
        --model-path /path/to/models --device-id GPU-<uuid from nvidia-smi -L> --resource-group gpu-0

Each file can be registered with the Node API or pasted into a node config's ``components`` list.
Standard library only.  The sampling contract of an accelerated variant (steps, shifts) and whether its
LoRA touches the AdaLN projections are read from the LoRA manifests bundled with ``phasyn_h3``.

Rules encoded here (the provider and runtime re-check every one of them):

* precision ``bf16`` keeps the native checkpoint; ``fp8`` / ``int8`` quantize the DiT online
  (``fp8_e4m3`` / ``int8_convrot``) and always keep ``adaln_proj`` in BF16;
* acceleration ``base`` is the official 50-step schedule; ``pai8`` (alibaba-pai PDD) touches
  ``adaln_proj`` and therefore needs a fixed AdaLN sidecar built with that LoRA
  (the ``phasyn-h3-adaln-sidecar`` command); ``lx8`` / ``lx4`` (lightx2v
  Turbo) share the base AdaLN and use the online AdaLN cache;
* anything quantized, accelerated or using an approximate attention kernel runs in ``approximate``
  mode; only native BF16 at 50 steps with exact attention is ``exact``;
* the bounded FP8 cold load applies to FP8 + block offload + fixed AdaLN only.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
LORA_DIR = REPO / "runtimes" / "h3" / "src" / "phasyn_h3" / "loras"

VARIANTS = ("fl2va", "ref2va")
PRECISIONS = ("bf16", "fp8", "int8")
ACCELERATIONS = ("base", "pai8", "lx8", "lx4")
EXACT_ATTENTION = ("auto_exact", "pytorch_sdpa")
# fp8_fa_sm120 is an approximate FP8 attention kernel for compute capability 12.0 GPUs only
ATTENTION_PROVIDERS = (*EXACT_ATTENTION, "fp8_fa_sm120")

VARIANT_LABEL = {"fl2va": "FL2VA", "ref2va": "Ref2VA"}
PRECISION_LABEL = {"bf16": "BF16 原生", "fp8": "FP8", "int8": "INT8 convrot"}
PRECISION_SCHEME = {"bf16": "none", "fp8": "fp8_e4m3", "int8": "int8_convrot"}
ACCEL_FOLDER = {
    "base": "原版",
    "pai8": "PAI 8 步",
    "lx8": "Turbo 8 步",
    "lx4": "Turbo 4 步",
}
ACCEL_LABEL = {
    "base": "原版 50 步",
    "pai8": "PAI Acc 8 步（預設）",
    "lx8": "Turbo 8 步",
    "lx4": "Turbo 4 步（草稿）",
}
LORA_MANIFESTS = {
    ("fl2va", "pai8"): "pai-h3-fl2va-acc8.json",
    ("ref2va", "pai8"): "pai-h3-ref2va-acc8.json",
    ("fl2va", "lx8"): "lx-h3-fl2v-turbo8-v1.0-768p.json",
    ("ref2va", "lx8"): "lx-h3-ref2v-turbo8-v1.0-768p.json",
    ("fl2va", "lx4"): "lx-h3-fl2v-turbo4-v1.2-768p.json",
    ("ref2va", "lx4"): "lx-h3-ref2v-turbo4-v0.1.json",
}
# accelerations that only exist with a LoRA manifest (a variant without one is not offered)
LORA_ACCELERATIONS = ("pai8", "lx8", "lx4")
# default AdaLN sidecar names of the PDD accelerations (fixed AdaLN); --adaln-cache-ref overrides them
ADALN_CACHE_REFS = {"pai8": "h3-{variant}-pdd8"}
BASE_SAMPLING = {"steps": 50, "video_shift": 12.0, "audio_shift": 3.0}
GIB = 1024**3
PINNED_HOST_BYTES = 24 * GIB  # host pinned-memory budget for the layer-streamed DiT
ADALN_HOST_CACHE_BYTES = 8 * GIB


def component_id(variant: str, precision: str, accel: str) -> str:
    return f"dit-{variant}-{precision}-{accel}"


def supported(variant: str, accel: str) -> bool:
    """Whether the grid offers this combination (an accelerating LoRA must exist for the variant)."""
    return accel not in LORA_ACCELERATIONS or (variant, accel) in LORA_MANIFESTS


def lora_manifest(variant: str, accel: str, lora_dir: Path = LORA_DIR) -> Mapping[str, Any] | None:
    name = LORA_MANIFESTS.get((variant, accel))
    if name is None:
        return None
    manifest = json.loads((lora_dir / name).read_text(encoding="utf-8"))
    if variant not in manifest.get("variants", []):
        raise ValueError(f"{name} does not declare variant {variant}")
    return manifest


def definition(
    variant: str,
    precision: str,
    accel: str,
    *,
    model_path: str = "/path/to/models",
    device_id: str = "GPU-REPLACE-0",
    resource_group: str = "gpu-0",
    runtime_id: str = "x86_64",
    attention: str = "auto_exact",
    adaln_cache_ref: str | None = None,
    lora_dir: Path = LORA_DIR,
) -> dict[str, Any]:
    """One DiT InstanceDefinition (``adaln_cache_ref`` None: the acceleration's default sidecar name)."""
    if variant not in VARIANTS or precision not in PRECISIONS or accel not in ACCELERATIONS:
        raise ValueError(f"unknown combination {variant}/{precision}/{accel}")
    if not supported(variant, accel):
        raise ValueError(f"no {accel} LoRA manifest for {variant}")
    if attention not in ATTENTION_PROVIDERS:
        raise ValueError(f"unknown attention provider {attention}")
    manifest = lora_manifest(variant, accel, lora_dir)
    contract = manifest["sampling_contract"] if manifest else BASE_SAMPLING
    steps = contract["steps"][0] if isinstance(contract["steps"], list) else contract["steps"]
    fixed_adaln = bool(manifest and manifest.get("touches_adaln"))
    scheme = PRECISION_SCHEME[precision]
    quantization: dict[str, Any] = {"scheme": scheme}
    if scheme != "none":
        quantization["excluded_modules"] = ["adaln_proj"]
    adaln: dict[str, Any] = {"mode": "fixed" if fixed_adaln else "online", "host_cache_bytes": ADALN_HOST_CACHE_BYTES}
    if fixed_adaln:
        pattern = adaln_cache_ref or ADALN_CACHE_REFS.get(accel, ADALN_CACHE_REFS["pai8"])
        adaln["cache_ref"] = pattern.format(variant=variant)
    exact = scheme == "none" and manifest is None and attention in EXACT_ATTENTION
    adaln_label = f"AdaLN fixed {adaln['cache_ref']}" if fixed_adaln else "AdaLN online"
    attention_label = "" if attention in EXACT_ATTENTION else f"・attention {attention}"
    return {
        "component_id": component_id(variant, precision, accel),
        "label": (
            f"H3 DiT {VARIANT_LABEL[variant]}・{PRECISION_LABEL[precision]}・{ACCEL_LABEL[accel]}・"
            f"{adaln_label}{attention_label}（逐層串流）"
        ),
        "provider_id": "h3.dit",
        "runtime_id": runtime_id,
        "autostart": False,
        "folder": f"生成/H3 DiT/{VARIANT_LABEL[variant]}/{ACCEL_FOLDER[accel]}",
        "exclusive_group": "dit",
        "settings": {
            "load": {
                "model_path": model_path,
                "device": {"kind": "cuda", "id": device_id, "resource_group": resource_group},
                "part_overrides": [],
                "precision": {"compute_dtype": "native", "quantization": quantization},
                "offload": {
                    "mode": "block",
                    "prefetch_depth": 1,
                    "resident_layers": 0,
                    "max_pinned_bytes": PINNED_HOST_BYTES,
                    "after_use": "host",
                },
                "provider_options": {
                    "variant": variant,
                    "shared_from": None,
                    "mode": "exact" if exact else "approximate",
                    "attention": {"provider": attention, "reject_quadratic_materialization": True},
                    "adaln": adaln,
                    "lora": None
                    if manifest is None
                    else {"manifest_path": LORA_MANIFESTS[(variant, accel)], "scale": 1.0},
                    "bounded_fp8_load": scheme == "fp8_e4m3" and fixed_adaln,
                },
            },
            "invoke": {
                "seed": 42,
                "steps": int(steps),
                "video_shift": float(contract["video_shift"]),
                "audio_shift": float(contract["audio_shift"]),
            },
            "recording": {"mode": "detailed"},
        },
    }


def grid(
    variants: Iterable[str] = VARIANTS,
    precisions: Iterable[str] = PRECISIONS,
    accelerations: Iterable[str] = ACCELERATIONS,
    **options: Any,
) -> list[dict[str, Any]]:
    return [
        definition(variant, precision, accel, **options)
        for variant in variants
        for precision in precisions
        for accel in accelerations
        if supported(variant, accel)
    ]


def dumps(doc: Mapping[str, Any]) -> str:
    """The on-disk form of a definition (2-space indent, UTF-8, trailing newline)."""
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, required=True, help="directory for the generated JSON files")
    parser.add_argument("--model-path", default="/path/to/models", help="load.model_path (the models root)")
    parser.add_argument("--device-id", default="GPU-REPLACE-0", help="GPU UUID (nvidia-smi -L)")
    parser.add_argument("--resource-group", default="gpu-0")
    parser.add_argument("--runtime-id", default="x86_64", help="node config runtimes[].runtime_id")
    parser.add_argument("--attention", choices=ATTENTION_PROVIDERS, default="auto_exact")
    parser.add_argument(
        "--adaln-cache-ref",
        default=None,
        help="AdaLN sidecar name pattern for every PAI DiT (default: h3-{variant}-pdd8)",
    )
    parser.add_argument("--variant", nargs="+", choices=VARIANTS, default=list(VARIANTS))
    parser.add_argument("--precision", nargs="+", choices=PRECISIONS, default=list(PRECISIONS))
    parser.add_argument("--acceleration", nargs="+", choices=ACCELERATIONS, default=list(ACCELERATIONS))
    args = parser.parse_args(argv)
    docs = grid(
        args.variant,
        args.precision,
        args.acceleration,
        model_path=args.model_path,
        device_id=args.device_id,
        resource_group=args.resource_group,
        runtime_id=args.runtime_id,
        attention=args.attention,
        adaln_cache_ref=args.adaln_cache_ref,
    )
    args.out.mkdir(parents=True, exist_ok=True)
    for doc in docs:
        (args.out / f"{doc['component_id']}.json").write_text(dumps(doc), encoding="utf-8")
    print(f"wrote {len(docs)} definitions to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
