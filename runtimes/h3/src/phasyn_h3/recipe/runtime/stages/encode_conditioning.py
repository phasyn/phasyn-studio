"""encode_conditioning: Qwen3-VL layer-50 tap → ``h3_conditioning`` bundle.

Faithful to the pinned encoder (``runtime/models/encoders/minimax_h3_qwen3vl.py:328-392``):
blocks 0..49, final norm Identity, ``use_cache=False``, ``hidden_states[50]`` width 5120, bf16.
The presentation (ids, tags, ``text_video_token_mask``, the vision inputs) is *not* built here:
``prepare_media`` froze it with the H3 snapshot's tokenizer/processor into the prepared payload
(``stages/presentation.py``; same upstream producer ``S/presentation.py``), so this stage — on the
encoder node, which needs neither tokenizer nor processor files — only verifies it against the
prepared document and runs the encoder forward.  ``tokenizer_digest`` / ``processor_digest`` come
from the node that tokenized.  The bundle is self-verified with ``verify_conditioning_bundle``.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.abi.stage import StageResult

from .. import SGLANG_SOURCE_REVISION
from ..bundles import TensorDecl, finalize_conditioning_bundle, write_payload
from ..errors import InvalidStageInput
from ..measure import text_encoder_flop
from .common import StageRun, task_of
from .presentation import TOKEN_TENSORS, load_presentation
from .tensor_io import load_tensors, tensor_bytes, verified_payload

_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")


def _frozen_digest(section: dict[str, Any], key: str) -> str:
    value = section.get(key)
    if not isinstance(value, str) or not _DIGEST_RE.match(value):
        raise InvalidStageInput("PRESENTATION_IDENTITY", f"prepared presentation 缺少有效的 {key}")
    return value


def run(run: StageRun) -> StageResult:
    import torch
    from sglang.multimodal_gen.runtime.managers.forward_context import set_forward_context

    prepared = run.read_json_input("prepared")
    assert prepared is not None
    task = task_of(run.plan)
    section = prepared.get("presentation") or {}
    if prepared.get("task") not in (None, task):
        raise InvalidStageInput("PREPARED_TASK", f"prepared task {prepared.get('task')} ≠ plan {task}")
    if not prepared.get("payload"):
        raise InvalidStageInput("PRESENTATION_MISSING", "prepared 沒有 payload（presentation tensors 在其中）")
    names = [*TOKEN_TENSORS, *sorted((section.get("vision") or {}).values())]
    # only the presentation tensors: the frozen media (RGB / PCM) belong to encode_references
    tensors = load_tensors(verified_payload(prepared, run.ctx.attachments), names) if section else {}
    ids, tags, mask, vision = load_presentation(prepared, tensors)
    seq = int(ids.shape[0])
    max_tokens = int(run.policy.limits.get("encoder_max_tokens", 32768))
    if seq > max_tokens:
        raise InvalidStageInput(
            "ENCODER_MAX_TOKENS",
            f"presentation S={seq} 超過 limits.encoder_max_tokens={max_tokens}；不默默截斷",
            field_path="limits.encoder_max_tokens",
            expected=f"<= {max_tokens}",
            actual=str(seq),
        )
    provider = run.provider
    run.check_cancel()
    # ETA work before the forward, so an out-of-memory failure still reports its size
    run.cost("encode", work=text_encoder_flop(seq).total, unit="flop", tokens=seq)
    run.progress("encode_conditioning", "items", 0, 1)
    with (
        provider.use_component(run, "text_encoder") as encoder,
        torch.inference_mode(),
        set_forward_context(current_timestep=0, attn_metadata=None),
    ):
        provider.backend.synchronize()
        started = time.perf_counter()
        hidden = encoder.encode_ids(ids, **vision)  # bf16 [S,5120], minimax_h3_qwen3vl.py:328-392
        provider.backend.synchronize()
        compute_seconds = time.perf_counter() - started
    run.cost_seconds("encode", compute_seconds)
    if hidden.dtype != torch.bfloat16 or list(hidden.shape) != [seq, 5120]:
        raise InvalidStageInput("ENCODER_OUTPUT_SHAPE", f"encoder 輸出 {hidden.dtype} {list(hidden.shape)}")
    if not bool(torch.isfinite(hidden.float()).all()):
        raise InvalidStageInput("ENCODER_OUTPUT_NONFINITE", "hidden_states 含 NaN/Inf")
    decls = [
        TensorDecl("hidden_states", "BF16", (seq, 5120), "S,H"),
        TensorDecl("text_token_tags", "I64", (seq,), "S"),
        TensorDecl("text_video_token_mask", "BOOL", (seq,), "S"),
    ]
    payload_path = run.output_dir / "conditioning.payload.safetensors"
    write_payload(
        payload_path,
        [
            (decls[0], tensor_bytes(hidden)),
            (decls[1], tensor_bytes(tags.to(torch.long))),
            (decls[2], tensor_bytes(mask.to(torch.bool))),
        ],
        metadata={"tap": "hidden_states[50]", "sglang": SGLANG_SOURCE_REVISION},
    )
    model = run.plan.get("model") or {}
    text_profile = (run.policy.effective_profile.get("components") or {}).get("text_encoder") or {}
    identity = {
        "encoder_revision": str(model.get("source_revision")),
        # hashed where the tokenizer/processor ran (prepare_media); verified there against the files
        "tokenizer_digest": _frozen_digest(section, "tokenizer_digest"),
        "processor_digest": _frozen_digest(section, "processor_digest"),
        "prepared_inputs_digest": canonical_digest({"prepared": prepared}),
        "presentation_digest": _frozen_digest(section, "digest"),  # re-derived from the tensors above
        "geometry_digest": canonical_digest(dict(run.geometry)),
        "quant_profile_digest": canonical_digest(
            {"compute_dtype": text_profile.get("compute_dtype"), "quantization": text_profile.get("quantization")}
        ),
        "runtime_fingerprint": canonical_digest(provider.environment()),
    }
    outputs, _manifest = finalize_conditioning_bundle(
        run.output_dir,
        "conditioning",
        payload_path,
        decls,
        text_len=seq,
        identity_fields=identity,
        max_tokens=max_tokens,
    )
    run.outputs.extend(outputs)
    facts = section.get("facts") or {}
    run.measure(compute_seconds=compute_seconds, flop=text_encoder_flop(seq), vision_inputs=sorted(vision))
    run.fact(
        "CONDITIONING",
        {
            "text_len": seq,
            "presentation": json.dumps(facts, default=str)[:400],
            "presentation_source": "prepare_media",
            "vision_inputs": sorted(vision),
        },
    )
    run.progress("encode_conditioning", "items", 1, 1)
    return run.result()


__all__ = ["run"]
