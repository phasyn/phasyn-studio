"""prepare_media: freeze crop/resize/frame-sampling/audio decisions once.

Uses the pinned SGLang preparation functions so Qwen and the VAEs later read the
*same* pixels/samples (§3, §11):

* keyframes — ``S/canvas.py:84-97`` (first semantic keyframe stretched onto the
  frozen canvas) and ``:57-81`` (second cover-cropped, upscale allowed), after
  ``ImageOps.exif_transpose`` (``:212-213``);
* reference images — ``S/reference_encoding.py:125-205`` (2048 short edge);
* reference videos — ``S/prequeue.py:290-302`` shape +
  ``S/reference_encoding.py:368-438`` single ffmpeg pass;
* reference audio — ``S/reference_encoding.py:207-284`` material chain
  (resample to 32 kHz happens in ``encode_references`` exactly like upstream).

Media probing uses the upstream model-facing probe
(``S/material_io.py:356-534``).

The Qwen3-VL presentation is built here too (``stages/presentation.py``): the H3 snapshot's
tokenizer + processor turn the prompt and the frozen keyframes / reference images / sampled
reference-video frames into ``input_ids``, ``text_token_tags``, ``text_video_token_mask`` and the
encoder's vision inputs, so the encoder node (``encode_conditioning``) only runs the forward and
needs no tokenizer/processor files.  ``limits.encoder_max_tokens`` is enforced here already.

Output: ``prepared`` (metadata, deterministic: its digest is the conditioning bundle's
``prepared_inputs_digest``) plus one safetensors payload (``prepared.payload``) holding RGB U8 /
PCM F32 media tensors and the presentation tensors.

Experimental stage option (off by default, not validated upstream; the only numeric knob):
``reference_video_short_edge`` = the ``base_short_edge`` handed to the pinned
``minimax_h3_resolve_spatial_shape`` for ``reference_video`` materials (upstream always passes
``MINIMAX_H3_BASE_SHORT_EDGE`` = 768, ``S/prequeue.py:290-302``).  Absent / ``None`` / 768 is the
pinned path, byte for byte.  Another multiple of 32 in 256..768 resolves the same way (nearest-32,
768x1344 soft pixel cap) from a smaller short edge — 1280x720 -> 800x448 at 448 — and the pinned
resolver logs its ``warn_unverified_short_edge`` caveat (kept; also surfaced as a stage warning).
Reference images, keyframes and audio never read the option.  The prepared document then records
``reference_video_short_edge`` and each video's ``resolved_shape.base_short_edge``.

Transparency (a deliberate difference from upstream): the pinned image preparation starts with
``image.convert("RGB")`` (``S/reference_encoding.py:201``, ``S/canvas.py:70,94``), which drops the alpha
channel and shows whatever colour the file stores under its transparent pixels.  A reference image or
keyframe that has transparent pixels is therefore composited onto white first (:func:`matte_transparency`),
and its material entry records ``alpha_matte``.  An image without transparent pixels takes the pinned path
byte for byte and its entry keeps exactly its old keys.

Held reference videos (``hold_last_frame``; another deliberate difference: upstream only caps a reference at
the generated length and never extends it): the window ``[start_seconds, end_seconds)`` is decoded exactly as
above, then :func:`hold_frames` repeats its last frame up to the generated frame count and :func:`hold_audio`
pads its soundtrack with digital silence to ``generated_frames / 24`` s (rounded down to a whole sample at the
soundtrack's rate).  Qwen and the video/audio VAEs read the held arrays, and the material entry records ``hold``
(policy, decoded and held frame counts, decoded and held audio seconds).  A reference without the flag takes the
path above byte for byte and its entry keeps exactly its old keys.

Dropped soundtracks (``use_embedded_audio: false`` on a reference video; a third deliberate difference: the pinned
text encoding always conditions on a probed soundtrack, so the generated voice and mouth would follow the original
actors): a file with an audio track is prepared exactly like a video without one — no waveform, no ``ref_audio_NN``
tensor, no ``<Audio j>`` — and its entry records ``input_has_audio`` (the file's truth) plus ``soundtrack_dropped``.
``true`` or unset takes the pinned path byte for byte and the entry keeps exactly its old keys.
"""

from __future__ import annotations

import contextlib
import logging
import time
from collections.abc import Iterator, Mapping
from importlib import import_module
from pathlib import Path
from typing import TYPE_CHECKING, Any, NamedTuple, cast, override

from phasyn_h3.recipe.abi.canonical import canonical_digest, sha256_hex
from phasyn_h3.recipe.abi.stage import OutputFile, StageResult
from phasyn_h3.recipe.abi.tensors import file_sha256
from phasyn_h3.recipe.adapter.geometry import (
    reference_image_short_edge,
    resolve_reference_image_shape,
)

from .. import SGLANG_SOURCE_REVISION
from ..bundles import TensorDecl, write_metadata_output, write_payload
from ..errors import IntegrityMismatch, InvalidStageInput, UnsupportedCombination
from .common import (
    SOUNDTRACK_DROPPED_KEY,
    StageRun,
    contributes_audio,
    requested,
    task_of,
)
from .presentation import (
    PRESENTATION_KIND,
    TOKEN_TENSORS,
    build_presentation,
    component_digest,
    json_facts,
    payload_tensors,
    presentation_digest,
)


if TYPE_CHECKING:  # pragma: no cover
    import numpy as np

_ROLE_CHAIN = {
    "first_frame": ("image", "image.target_canvas"),
    "last_frame": ("image", "image.target_canvas"),
    "reference_image": ("image", "image.reference_preserve"),
    "reference_video": ("video", "video.reference_preserve"),
    "reference_audio": ("audio", "audio"),
}
H3_FPS = 24
REFERENCE_VIDEO_SHORT_EDGE_KEY = "reference_video_short_edge"
_PINNED_REFERENCE_VIDEO_SHORT_EDGE = (
    768  # S/resolved_plan.py:43 MINIMAX_H3_BASE_SHORT_EDGE (re-checked in run)
)
_EXPERIMENT_SHORT_EDGE_RANGE = (256, _PINNED_REFERENCE_VIDEO_SHORT_EDGE)
_CANVAS_MULTIPLE = 32  # S/resolved_plan.py:45
ALPHA_MATTE_POLICY = "white_matte_v1"
_ALPHA_MATTE_RGB = (255, 255, 255)
HOLD_POLICY = "repeat_last_frame_silence_v1"


def matte_transparency(image: Any) -> tuple[Any, dict[str, Any] | None]:
    """An image with transparent pixels composited onto white; any other image unchanged, with ``None``.

    ``convert("RGB")`` does not composite: it drops the alpha channel, so the model would read the colour stored
    under the transparent pixels (black in most files, a blurred halo of the subject in others) as the picture's
    backdrop, and a prompt that names no setting gets that backdrop painted into every frame.  On white the
    model reads what a person sees on a white page.  The result equals
    ``Image.alpha_composite(white, image.convert("RGBA")).convert("RGB")`` done by hand before the upload.
    """
    from PIL import Image

    if "A" not in image.getbands() and "transparency" not in image.info:
        return image, None
    rgba = image.convert("RGBA")
    histogram = rgba.getchannel("A").histogram()
    transparent, translucent = int(histogram[0]), int(sum(histogram[1:255]))
    if not transparent and not translucent:
        return image, None
    white = Image.new("RGBA", rgba.size, (*_ALPHA_MATTE_RGB, 255))
    return Image.alpha_composite(white, rgba).convert("RGB"), {
        "policy": ALPHA_MATTE_POLICY,
        "background_rgb": list(_ALPHA_MATTE_RGB),
        "source_mode": str(image.mode),
        "transparent_pixels": transparent,
        "translucent_pixels": translucent,
    }


# Float slack when seconds are turned back into whole frames (see reference_window)
FRAME_SLACK = 1e-3


def reference_window(
    start: float, end: Any, generated_frames: int
) -> tuple[int, float]:
    """(frame cap, seconds cap) of a reference clip: the generated length, narrowed to ``end_seconds``.

    The plan takes a reference clip as ``[start_seconds, end_seconds)`` (``window.end_applied_by =
    prepare_media`` in the adapter).  The pinned decoders take a start and a cap only, so the end is
    applied as the cap: ``(end - start) * 24`` frames rounded down — the adapter's own count — and
    ``end - start`` seconds of audio.  Without an end the caps are the generated length, as upstream.
    Frame-aligned windows come as seconds (frames / 24), whose product with 24 can land just under the
    whole number (944/24 → 1018/24 gives 73.99999999999989), and Studio writes seconds with 6 decimals
    (107/24 → 4.458333 gives 106.999992), so a 1e-3 frame slack keeps the last frame; it stays far below one frame.
    """
    frames, seconds = int(generated_frames), int(generated_frames) / H3_FPS
    if end is not None:
        window = max(0.0, float(end) - float(start))
        frames = max(1, min(frames, int(window * H3_FPS + FRAME_SLACK)))
        seconds = min(seconds, window)
    return frames, seconds


def hold_frames(frames: np.ndarray, total: int) -> np.ndarray:
    """``frames`` ([F, H, W, C]) continued with copies of its last frame up to ``total`` frames.

    Never truncates: ``total`` frames or more come back unchanged.  A decode without frames has no last frame
    to hold and is an error.
    """
    numeric = import_module("numpy")

    count = int(frames.shape[0])
    if count == 0:
        raise InvalidStageInput(
            "REFERENCE_VIDEO_HOLD_EMPTY",
            "參考影片的視窗沒有解出任何影格，沒有最後一格可以凍結",
        )
    if count >= int(total):
        return frames
    return cast(
        "np.ndarray",
        numeric.concatenate(
            [frames, numeric.repeat(frames[-1:], int(total) - count, axis=0)]
        ),
    )


def hold_audio(wave: np.ndarray, samples: int) -> np.ndarray:
    """``wave`` ([C, N]) followed by digital silence (zeros) up to ``samples`` per channel.

    Never truncates: ``samples`` or more come back unchanged.  An empty waveform is an error.
    """
    numeric = import_module("numpy")

    count = int(wave.shape[-1])
    if count == 0:
        raise InvalidStageInput(
            "REFERENCE_AUDIO_HOLD_EMPTY",
            "參考影片的原聲在視窗內沒有任何取樣，無法補靜音",
        )
    if count >= int(samples):
        return wave
    silence = numeric.zeros((*wave.shape[:-1], int(samples) - count), dtype=wave.dtype)
    return cast("np.ndarray", numeric.concatenate([wave, silence], axis=-1))


def stage_reference_video_short_edge(stage: Mapping[str, Any]) -> int | None:
    """The stage's experimental ``reference_video_short_edge``; ``None`` = the pinned 768 path."""
    value = stage.get(REFERENCE_VIDEO_SHORT_EDGE_KEY)
    if value is None or (
        not isinstance(value, bool) and value == _PINNED_REFERENCE_VIDEO_SHORT_EDGE
    ):
        return None
    lo, hi = _EXPERIMENT_SHORT_EDGE_RANGE
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not lo <= value <= hi
        or value % _CANVAS_MULTIPLE
    ):
        raise InvalidStageInput(
            "REFERENCE_VIDEO_SHORT_EDGE",
            f"{REFERENCE_VIDEO_SHORT_EDGE_KEY}={value!r} 不合法：需為 {lo}\N{EN DASH}{hi} 的 {_CANVAS_MULTIPLE} 倍數整數",
            field_path=REFERENCE_VIDEO_SHORT_EDGE_KEY,
            expected=f"int, multiple of {_CANVAS_MULTIPLE}, {lo}..{hi}",
            actual=repr(value),
        )
    return int(value)


@contextlib.contextmanager
def _upstream_warnings(sink: list[str]) -> Iterator[None]:
    """Also collect what the pinned ``minimax_h3`` constants logger warns during the call.

    The pinned ``warn_unverified_short_edge`` keeps logging exactly as before (nothing is removed
    or silenced); it is ``lru_cache``-d, so it logs once per value per process.
    """
    logger: Any = None
    with contextlib.suppress(Exception):
        from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3 import (  # type: ignore[import-untyped]
            constants as upstream_constants,
        )

        logger = getattr(upstream_constants, "logger", None)
    if not isinstance(logger, logging.Logger):
        yield
        return

    class _Collect(logging.Handler):
        @override
        def emit(self, record: logging.LogRecord) -> None:
            with contextlib.suppress(Exception):
                sink.append(record.getMessage())

    handler = _Collect(level=logging.WARNING)
    logger.addHandler(handler)
    try:
        yield
    finally:
        logger.removeHandler(handler)


def _dims(width: Any, height: Any) -> str:
    return f"{float(width):g}×{float(height):g}"


def _short_edge_message(
    short_edge: int, official: int, items: list[dict[str, Any]], upstream: list[str]
) -> str:
    shapes = "；".join(
        f"materials[{i['material_index']}] {_dims(*i['source'])} → {_dims(*i['resolved'])}"
        f"（官方 {official} 時 {_dims(*i['official'])}）"
        for i in items
    )
    if upstream:
        pinned = "釘版 SGLang 警告原文：" + " / ".join(upstream)
    else:
        pinned = "本次沒有攔到釘版 log（warn_unverified_short_edge 以 lru_cache 每個程序每個值只記一次，原文在元件 stderr log）"
    return (
        f"參考影片以實驗短邊 {short_edge} 前處理（官方只驗證 {official}；品質與 prompt 遵循未經 MiniMax／SGLang 量測）："
        f"{shapes}。{pinned}"
    )


def prompt_text(run: StageRun) -> tuple[str, str]:
    """The prompt the conditioning encoder must see, and where it came from (verbatim prompts only)."""
    prompt = requested(run.plan).get("prompt") or {}
    if prompt.get("context_mode", "verbatim") == "verbatim" and prompt.get("text"):
        return str(prompt["text"]), "requested.prompt.text(verbatim)"
    raise InvalidStageInput(
        "PROMPT_UNRESOLVED",
        "只支援 verbatim prompt（context_mode=verbatim 且有 prompt 文字）；不猜測",
        field_path="prompt",
    )


def _material_path(run: StageRun, index: int, material: dict[str, Any]) -> Path:
    item = run.material_inputs().get(index)
    if item is None or item.path is None:
        raise InvalidStageInput(
            "MATERIAL_INPUT_MISSING",
            f"materials[{index}] 沒有對應的 material_{index:02d} 輸入",
        )
    path = Path(item.path)
    expected = (material.get("artifact") or {}).get("sha256")
    if expected:
        digest, _ = file_sha256(path)
        if digest != expected:
            raise IntegrityMismatch(
                "MATERIAL_HASH_MISMATCH",
                f"materials[{index}] 內容與 artifact sha256 不符",
                expected=expected,
                actual=digest,
            )
    return path


def _keyframe_order(materials: list[dict[str, Any]]) -> list[int]:
    first = [i for i, m in enumerate(materials) if m.get("role") == "first_frame"]
    last = [i for i, m in enumerate(materials) if m.get("role") == "last_frame"]
    if len(first) > 1 or len(last) > 1:
        raise InvalidStageInput(
            "KEYFRAME_DUPLICATE", "first_frame/last_frame 各最多一個"
        )
    return first + last  # semantic order [0, -1] (S/task_profiles keyframe signatures)


def run(run: StageRun) -> StageResult:
    """Prepare media inputs with the requested geometry and timebase."""
    numeric = import_module("numpy")
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.resolved_plan import (  # type: ignore[import-untyped]
        MINIMAX_H3_BASE_SHORT_EDGE,
    )

    image_edge, short_edge = _resolve_reference_edges(run, MINIMAX_H3_BASE_SHORT_EDGE)
    task = task_of(run.plan)
    geometry = run.geometry
    width, height = int(geometry["width"]), int(geometry["height"])
    generated_frames = int(geometry["generated_frames"])
    materials = list(requested(run.plan).get("materials") or [])
    if image_edge is not None and (
        task != "ref2va"
        or not any(m.get("role") == "reference_image" for m in materials)
    ):
        raise InvalidStageInput(
            "INVALID_ARGUMENT", "image edge experiment requires Ref2VA reference_image"
        )
    text, text_source = prompt_text(run)
    if task == "t2va" and materials:
        raise InvalidStageInput("T2VA_WITH_MATERIALS", "t2va 不接受素材")

    experiment: list[
        dict[str, Any]
    ] = []  # reference videos resolved at the experimental short edge
    upstream_warnings: list[str] = []
    entries: list[dict[str, Any]] = []
    tensors: list[tuple[TensorDecl, bytes]] = []
    arrays: dict[
        str, Any
    ] = {}  # frozen media by tensor name: the presentation reads the same pixels
    order = (
        _keyframe_order(materials) if task == "fl2va" else list(range(len(materials)))
    )
    if task == "fl2va" and (
        not order
        or any(m.get("role") not in ("first_frame", "last_frame") for m in materials)
    ):
        raise InvalidStageInput(
            "FL2VA_MATERIALS", "fl2va 只接受 first_frame/last_frame"
        )
    total = len(order)
    _prepare_materials(
        _PrepareMaterialsInputs(
            order,
            run,
            materials,
            generated_frames,
            entries,
            width,
            height,
            numeric,
            image_edge,
            task,
            short_edge,
            upstream_warnings,
            experiment,
            tensors,
            arrays,
            total,
        )
    )

    _record_video_experiment(
        short_edge, experiment, run, MINIMAX_H3_BASE_SHORT_EDGE, upstream_warnings
    )

    presentation, presentation_tensors, seconds = _presentation(
        run, task, text, entries, arrays
    )
    tensors.extend(presentation_tensors)

    document: dict[str, Any] = {
        "schema_version": "1.0",
        "kind": "h3_prepared_media",
        "task": task,
        "variant": str((run.plan.get("model") or {}).get("variant", "")),
        "prompt": {
            "text": text,
            "source": text_source,
            "sha256": sha256_hex(text.encode("utf-8")),
        },
        "canvas": {"width": width, "height": height},
        "generated_frames": generated_frames,
        "fps": H3_FPS,
        "materials": entries,
        "geometry_digest": canonical_digest(dict(geometry)),
        "upstream": {
            "sglang": SGLANG_SOURCE_REVISION,
            "probe": "S/material_io.py:_validate_localized_media",
        },
        "presentation": presentation,
        "payload": None,
    }
    if image_edge is not None:
        document["reference_image_short_edge"] = image_edge
    if (
        experiment
    ):  # only when applied: the pinned path's document keeps exactly its old keys
        document[REFERENCE_VIDEO_SHORT_EDGE_KEY] = short_edge
    _write_material_tensors(tensors, run, document)
    run.outputs.append(write_metadata_output(run.output_dir, "prepared", document))
    run.measure(compute_seconds=seconds, presentation="tokenizer+processor (CPU)")
    run.fact(
        "PREPARED_MEDIA",
        {
            "task": task,
            "materials": len(entries),
            "payload": bool(tensors),
            "text_len": presentation["text_len"],
            "vision_inputs": sorted(presentation["vision"]),
            "presentation_seconds": round(seconds, 6),
        },
    )
    return run.result()


def _drop_soundtrack(run: StageRun, index: int, entry: dict[str, Any]) -> None:
    """Leave a reference video's soundtrack out (``use_embedded_audio: false``; a deviation).

    The pinned path always conditions on a probed soundtrack.  Here no waveform is decoded and no
    ``ref_audio_NN`` tensor is written; ``input_has_audio`` keeps the file's truth and ``soundtrack_dropped``
    says why it contributes nothing, so the presentation gets no ``<Audio j>`` for it and the audio encode
    has no source in it (:func:`~.common.contributes_audio`), exactly like a video without an audio track.
    """
    entry[SOUNDTRACK_DROPPED_KEY] = True
    run.info(
        "REFERENCE_VIDEO_SOUNDTRACK_DROPPED",
        f"materials[{index}]（reference_video）的原聲依要求不使用（use_embedded_audio=false）："
        "不解碼聲音、不佔 <Audio n> 標籤、不送 Audio VAE；人聲與口型只依 prompt",
        field_paths=[f"materials[{index}].use_embedded_audio"],
    )


def _presentation(
    run: StageRun,
    task: str,
    text: str,
    entries: list[dict[str, Any]],
    arrays: dict[str, Any],
) -> tuple[dict[str, Any], list[tuple[TensorDecl, bytes]], float]:
    """Tokenizer + processor on the frozen media → (document section, payload tensors, seconds).

    ``arrays`` are the very numpy arrays written to the payload (no re-read): the presentation and
    the VAE encode see the same pixels.
    """
    run.check_cancel()
    run.progress("presentation", "items", 0, 1)
    acquire = time.perf_counter()
    with (
        run.provider.use_component(run, "tokenizer") as tokenizer,
        run.provider.use_component(run, "processor") as processor,
    ):
        started = (
            time.perf_counter()
        )  # the components stay loaded in this actor after the first use
        ids, tags, mask, vision, facts = build_presentation(
            task, text, entries, arrays, tokenizer, processor
        )
        seconds = time.perf_counter() - started
    run.measure(tokenizer_processor_acquire_seconds=round(started - acquire, 6))
    seq = int(ids.shape[0])
    max_tokens = int(run.policy.limits.get("encoder_max_tokens", 32768))
    if seq > max_tokens:  # before anything travels to the encoder node
        raise InvalidStageInput(
            "ENCODER_MAX_TOKENS",
            f"presentation S={seq} 超過 limits.encoder_max_tokens={max_tokens}；不默默截斷",
            field_path="limits.encoder_max_tokens",
            expected=f"<= {max_tokens}",
            actual=str(seq),
        )
    digest, hashes = presentation_digest(ids, tags, mask, facts)
    packed = payload_tensors(ids, tags, mask, vision)
    section = {
        "kind": PRESENTATION_KIND,
        "text_len": seq,
        "tensors": list(TOKEN_TENSORS),
        "vision": {key: key for key in sorted(vision)},
        "pixel_wire_dtype": "BF16",  # encode_ids casts pixel values to BF16 first (minimax_h3_qwen3vl.py:368-375)
        **hashes,
        "facts": json_facts(facts),
        "digest": digest,
        "tokenizer_digest": component_digest(run, "tokenizer"),
        "processor_digest": component_digest(run, "processor"),
        "upstream": "S/presentation.py, S/stages/text_encoding.py:238-587",
    }
    run.progress("presentation", "items", 1, 1)
    return section, [(decl, raw) for decl, raw, _tensor in packed], seconds


__all__ = [
    "HOLD_POLICY",
    "REFERENCE_VIDEO_SHORT_EDGE_KEY",
    "hold_audio",
    "hold_frames",
    "prompt_text",
    "run",
    "stage_reference_video_short_edge",
]


def _resolve_reference_edges(run: StageRun, native_short_edge: Any) -> tuple[Any, Any]:
    try:
        image_edge = reference_image_short_edge(
            run.stage.get("reference_image_short_edge")
        )
        planned_edge = reference_image_short_edge(
            run.geometry.get("reference_image_short_edge")
        )
    except ValueError as exc:
        raise InvalidStageInput(
            "INVALID_ARGUMENT", str(exc), field_path="reference_image_short_edge"
        ) from exc
    if planned_edge != image_edge:
        raise InvalidStageInput(
            "LATENT_SOURCE_MISMATCH", "stage/plan reference_image_short_edge differs"
        )
    short_edge = stage_reference_video_short_edge(
        run.stage
    )  # None = the pinned path (unchanged)
    if (
        short_edge is not None
        and native_short_edge != _PINNED_REFERENCE_VIDEO_SHORT_EDGE
    ):
        raise UnsupportedCombination(
            "REFERENCE_VIDEO_SHORT_EDGE_PIN",
            f"釘版 MINIMAX_H3_BASE_SHORT_EDGE={native_short_edge} 不是此實驗審核過的 "
            f"{_PINNED_REFERENCE_VIDEO_SHORT_EDGE}；不套用 {REFERENCE_VIDEO_SHORT_EDGE_KEY}",
            field_path=REFERENCE_VIDEO_SHORT_EDGE_KEY,
        )
    return image_edge, short_edge


def _record_video_experiment(
    short_edge: Any,
    experiment: list[dict[str, Any]],
    run: StageRun,
    native_short_edge: Any,
    upstream_warnings: list[str],
) -> None:
    if short_edge is not None:
        if experiment:
            run.warn(
                "REFERENCE_VIDEO_SHORT_EDGE_UNVERIFIED",
                _short_edge_message(
                    short_edge,
                    native_short_edge,
                    experiment,
                    upstream_warnings,
                ),
                field_paths=[REFERENCE_VIDEO_SHORT_EDGE_KEY],
                expected=str(native_short_edge),
                actual=str(short_edge),
            )
        else:
            run.info(
                "REFERENCE_VIDEO_SHORT_EDGE_UNUSED",
                f"{REFERENCE_VIDEO_SHORT_EDGE_KEY}={short_edge} 未生效：素材裡沒有 reference_video",
            )


class _PrepareKeyframeInputs(NamedTuple):
    path: Any
    entries: list[dict[str, Any]]
    width: Any
    height: Any
    facts: Any
    run: StageRun
    role: Any
    entry: dict[str, Any]
    generated_frames: Any
    numeric: Any


def _prepare_keyframe(
    inputs: _PrepareKeyframeInputs,
) -> tuple[Any, Any, Any, dict[str, Any] | None]:
    from PIL import Image, ImageOps
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.canvas import (  # type: ignore[import-untyped]
        minimax_h3_prepare_keyframe_canvas,
        minimax_h3_stretch_keyframe_canvas,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.resolved_plan import (
        minimax_h3_resolve_spatial_shape,
    )

    path, entries, width, height, facts, run, role, entry, generated_frames, numeric = (
        inputs
    )
    with Image.open(path) as src:
        image = ImageOps.exif_transpose(src)
        image.load()
    image, matte = matte_transparency(image)
    keyframe_rank = len(
        [e for e in entries if e["material_chain"] == "image.target_canvas"]
    )
    if keyframe_rank == 0:
        prepared = minimax_h3_stretch_keyframe_canvas(
            image, target_width=width, target_height=height
        )
        transform = "stretch_lanczos(S/canvas.py:84-97)"
        upstream_canvas = minimax_h3_resolve_spatial_shape(
            width=facts["display_width"],
            height=facts["display_height"],
            base_short_edge=min(width, height),
        )
        if (upstream_canvas["width"], upstream_canvas["height"]) != (
            width,
            height,
        ):
            run.warn(
                "CANVAS_DIFFERS_FROM_UPSTREAM_POLICY",
                f"frozen canvas {width}x{height} ≠ 釘版依首幀推得的 "
                f"{upstream_canvas['width']}x{upstream_canvas['height']}；"
                "依 plan 凍結值 stretch（可能變形）",
            )
    else:
        prepared = minimax_h3_prepare_keyframe_canvas(
            image, target_width=width, target_height=height, allow_upscale=True
        )
        transform = "cover_crop_lanczos(S/canvas.py:57-81)"
    frame_index = 0 if role == "first_frame" else -1
    entry.update(
        {
            "frame_index": frame_index,
            "resolved_frame_index": 0 if frame_index == 0 else generated_frames - 1,
            "transform": transform,
        }
    )
    arr = numeric.asarray(prepared.convert("RGB"), dtype=numeric.uint8)
    name, layout = f"keyframe_{keyframe_rank:02d}", "H,W,C"
    return arr, name, layout, matte


class _PrepareReferenceImageInputs(NamedTuple):
    image_edge: Any
    facts: Any
    task: Any
    path: Any
    numeric: Any
    entry: dict[str, Any]
    index: Any


def _prepare_reference_image(
    inputs: _PrepareReferenceImageInputs,
) -> tuple[Any, Any, Any, dict[str, Any] | None]:
    from PIL import Image, ImageOps
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (  # type: ignore[import-untyped]
        minimax_h3_resize_reference_image,
        minimax_h3_resolve_reference_image_shape,
    )

    image_edge, facts, task, path, numeric, entry, index = inputs
    if image_edge is None:
        shape = minimax_h3_resolve_reference_image_shape(
            width=facts["display_width"], height=facts["display_height"]
        )
    else:
        if task != "ref2va":
            raise InvalidStageInput(
                "INVALID_ARGUMENT", "image edge experiment requires Ref2VA"
            )
        shape = {
            **resolve_reference_image_shape(
                facts["display_width"],
                facts["display_height"],
                short_edge=image_edge,
            ),
            "base_short_edge": image_edge,
            "shape_policy_version": "experimental_reference_image_short_edge_v1",
            "experimental": True,
        }
    with Image.open(path) as src:
        image = ImageOps.exif_transpose(src)
        image.load()
    image, matte = matte_transparency(image)
    prepared = minimax_h3_resize_reference_image(
        image,
        target_width=int(shape["width"]),
        target_height=int(shape["height"]),
    )
    arr = numeric.asarray(prepared.convert("RGB"), dtype=numeric.uint8)
    entry.update(
        {
            "resolved_shape": shape,
            "transform": (
                "reference_short_edge_2048(S/reference_encoding.py:125-205)"
                if image_edge is None
                else f"experimental_reference_image_short_edge_{image_edge}"
            ),
        }
    )
    name, layout = f"ref_image_{index:02d}", "H,W,C"
    return arr, name, layout, matte


class _PrepareVideoFramesInputs(NamedTuple):
    short_edge: Any
    facts: Any
    upstream_warnings: list[str]
    experiment: list[dict[str, Any]]
    index: Any
    path: Any
    frame_cap: Any
    start: Any
    numeric: Any
    material: Any
    generated_frames: Any
    entry: dict[str, Any]


def _prepare_video_frames(
    inputs: _PrepareVideoFramesInputs,
) -> tuple[Any, Any, Any, dict[str, Any] | None]:
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (
        minimax_h3_decode_reference_video_frames,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.resolved_plan import (
        MINIMAX_H3_BASE_SHORT_EDGE,
        minimax_h3_resolve_spatial_shape,
    )

    (
        short_edge,
        facts,
        upstream_warnings,
        experiment,
        index,
        path,
        frame_cap,
        start,
        numeric,
        material,
        generated_frames,
        entry,
    ) = inputs
    if short_edge is None:
        shape = minimax_h3_resolve_spatial_shape(
            width=facts["display_width"],
            height=facts["display_height"],
            base_short_edge=MINIMAX_H3_BASE_SHORT_EDGE,
        )
    else:  # experiment: same pinned resolver, smaller base short edge (its caveat is logged, not silenced)
        with _upstream_warnings(upstream_warnings):
            shape = minimax_h3_resolve_spatial_shape(
                width=facts["display_width"],
                height=facts["display_height"],
                base_short_edge=short_edge,
            )
        official = minimax_h3_resolve_spatial_shape(
            width=facts["display_width"],
            height=facts["display_height"],
            base_short_edge=MINIMAX_H3_BASE_SHORT_EDGE,
        )
        experiment.append(
            {
                "material_index": index,
                "source": (facts["display_width"], facts["display_height"]),
                "resolved": (shape["width"], shape["height"]),
                "official": (official["width"], official["height"]),
            }
        )
    frames = minimax_h3_decode_reference_video_frames(
        str(path),
        target_width=int(shape["width"]),
        target_height=int(shape["height"]),
        target_frame_count=frame_cap,
        fps=float(H3_FPS),
        start_time_seconds=start,
    )
    arr = numeric.ascontiguousarray(frames, dtype=numeric.uint8)
    hold: dict[str, Any] | None = None
    if material.get("hold_last_frame") is True:
        hold = {
            "policy": HOLD_POLICY,
            "decoded_frames": int(arr.shape[0]),
            "decoded_audio_seconds": None,
        }
        arr = hold_frames(arr, generated_frames)
        hold.update(held_frames=int(arr.shape[0]), held_audio_seconds=None)
    entry.update(
        {
            "resolved_shape": shape,
            "frame_count": int(arr.shape[0]),
            "input_has_audio": bool(facts.get("has_audio")),
            "transform": "ffmpeg_fps24_lanczos_setsar1(S/reference_encoding.py:368-438)",
        }
    )
    name, layout = f"ref_video_{index:02d}", "F,H,W,C"
    return arr, name, layout, hold


class _PrepareVideoSoundtrackInputs(NamedTuple):
    facts: Any
    material: Any
    run: StageRun
    index: Any
    entry: dict[str, Any]
    path: Any
    chain: Any
    seconds_cap: Any
    start: Any
    numeric: Any
    hold: dict[str, Any] | None
    generated_frames: Any
    tensors: list[tuple[TensorDecl, bytes]]
    arrays: dict[str, Any]


def _prepare_video_soundtrack(inputs: _PrepareVideoSoundtrackInputs) -> None:
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (
        _load_waveform,
    )

    (
        facts,
        material,
        run,
        index,
        entry,
        path,
        chain,
        seconds_cap,
        start,
        numeric,
        hold,
        generated_frames,
        tensors,
        arrays,
    ) = inputs
    if facts.get("has_audio") and material.get("use_embedded_audio", True) is False:
        _drop_soundtrack(run, index, entry)
    elif facts.get("has_audio"):
        wave, rate = _load_waveform(
            str(path),
            material_chain=chain,
            max_duration_seconds=seconds_cap,
            start_time_seconds=start,
        )
        wav = numeric.ascontiguousarray(wave.numpy(), dtype=numeric.float32)
        if hold is not None:
            hold["decoded_audio_seconds"] = int(wav.shape[-1]) / int(rate)
            # generated_frames / 24 s at the soundtrack's rate, rounded down to a whole sample: a window at
            # least as long as the shot gets no padding (ffmpeg's -t yields the nearest sample count)
            wav = hold_audio(wav, generated_frames * int(rate) // H3_FPS)
            hold["held_audio_seconds"] = int(wav.shape[-1]) / int(rate)
        tensors.append(
            (
                TensorDecl(f"ref_audio_{index:02d}", "F32", tuple(wav.shape), "C,N"),
                wav.tobytes(),
            )
        )
        arrays[f"ref_audio_{index:02d}"] = wav
        entry["audio"] = {
            "tensor": f"ref_audio_{index:02d}",
            "source_sample_rate": int(rate),
            "channels": "L,R",
        }
    contributes_audio(
        entry
    )  # the waveform above and the rule every later stage reads agree
    if (
        hold is not None
    ):  # only when asked: a reference video without the flag keeps exactly its old keys
        entry["hold"] = hold
        audio_note = (
            ""
            if hold["held_audio_seconds"] is None
            else f"；原聲 {hold['decoded_audio_seconds']:.3f} 秒補靜音到 {hold['held_audio_seconds']:.3f} 秒"
        )
        run.info(
            "REFERENCE_VIDEO_HELD",
            f"materials[{index}]（reference_video）視窗解出 {hold['decoded_frames']} 格，"
            f"之後重複最後一格到 {hold['held_frames']} 格{audio_note}",
            field_paths=[f"materials[{index}]"],
        )


class _PrepareAudioWaveInputs(NamedTuple):
    path: Any
    chain: Any
    seconds_cap: Any
    start: Any
    facts: Any
    numeric: Any
    entry: dict[str, Any]
    index: Any


def _prepare_audio_wave(inputs: _PrepareAudioWaveInputs) -> tuple[Any, Any, Any]:
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (
        _load_waveform,
    )

    path, chain, seconds_cap, start, facts, numeric, entry, index = inputs
    wave, rate = _load_waveform(
        str(path),
        material_chain=chain,
        max_duration_seconds=seconds_cap,
        start_time_seconds=start,
        source_sample_rate=int(facts["audio_sample_rate"]),
    )
    arr = numeric.ascontiguousarray(wave.numpy(), dtype=numeric.float32)
    entry.update(
        {
            "source_sample_rate": int(rate),
            "channels": "L,R",
            "transform": "ffmpeg_f32le_stereo(S/reference_encoding.py:207-284)",
        }
    )
    name, layout = f"ref_audio_{index:02d}", "C,N"
    return arr, name, layout


class _StoreMaterialInputs(NamedTuple):
    matte: dict[str, Any] | None
    entry: dict[str, Any]
    run: StageRun
    index: Any
    role: Any
    arr: Any
    numeric: Any
    tensors: list[tuple[TensorDecl, bytes]]
    name: Any
    layout: Any
    arrays: dict[str, Any]
    entries: list[dict[str, Any]]
    done: Any
    total: Any


def _store_material(inputs: _StoreMaterialInputs) -> None:
    (
        matte,
        entry,
        run,
        index,
        role,
        arr,
        numeric,
        tensors,
        name,
        layout,
        arrays,
        entries,
        done,
        total,
    ) = inputs
    if (
        matte is not None
    ):  # only when applied: an image without transparent pixels keeps exactly its old keys
        entry["alpha_matte"] = matte
        run.info(
            "TRANSPARENCY_MATTED",
            f"materials[{index}]（{role}）有透明像素：已合成到白底再前處理"
            f"（完全透明 {matte['transparent_pixels']} px、半透明 {matte['translucent_pixels']} px）；"
            '釘版的 convert("RGB") 會直接丟掉 alpha，露出檔案存在透明區底下的顏色',
            field_paths=[f"materials[{index}]"],
        )
    dtype = "U8" if arr.dtype == numeric.uint8 else "F32"
    tensors.append(
        (
            TensorDecl(name, dtype, tuple(int(d) for d in arr.shape), layout),
            arr.tobytes(),
        )
    )
    arrays[name] = arr
    entry["tensor"] = name
    entries.append(entry)
    run.progress("prepare_media", "items", done + 1, total)


class _PrepareMaterialsInputs(NamedTuple):
    order: Any
    run: StageRun
    materials: Any
    generated_frames: Any
    entries: list[dict[str, Any]]
    width: Any
    height: Any
    numeric: Any
    image_edge: Any
    task: Any
    short_edge: Any
    upstream_warnings: list[str]
    experiment: list[dict[str, Any]]
    tensors: list[tuple[TensorDecl, bytes]]
    arrays: dict[str, Any]
    total: Any


def _prepare_materials(inputs: _PrepareMaterialsInputs) -> None:
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.material_io import (  # type: ignore[import-untyped]
        _validate_localized_media,
    )

    (
        order,
        run,
        materials,
        generated_frames,
        entries,
        width,
        height,
        numeric,
        image_edge,
        task,
        short_edge,
        upstream_warnings,
        experiment,
        tensors,
        arrays,
        total,
    ) = inputs
    for done, index in enumerate(order):
        run.check_cancel()
        material = materials[index]
        role = str(material.get("role"))
        if role not in _ROLE_CHAIN:
            raise InvalidStageInput(
                "MATERIAL_ROLE", f"materials[{index}].role={role} 不支援"
            )
        condition_type, chain = _ROLE_CHAIN[role]
        path = _material_path(run, index, material)
        facts = dict(
            _validate_localized_media(str(path), condition_type=condition_type)
        )
        start = float(material.get("start_seconds") or 0.0)
        frame_cap, seconds_cap = reference_window(
            start, material.get("end_seconds"), generated_frames
        )
        entry: dict[str, Any] = {
            "material_index": index,
            "role": role,
            "condition_type": condition_type,
            "material_chain": chain,
            "source_sha256": (material.get("artifact") or {}).get("sha256"),
            "probe": facts,
            "start_time_seconds": start,
        }
        matte: dict[str, Any] | None = None
        if role in ("first_frame", "last_frame"):
            arr, name, layout, matte = _prepare_keyframe(
                _PrepareKeyframeInputs(
                    path,
                    entries,
                    width,
                    height,
                    facts,
                    run,
                    role,
                    entry,
                    generated_frames,
                    numeric,
                )
            )
        elif role == "reference_image":
            arr, name, layout, matte = _prepare_reference_image(
                _PrepareReferenceImageInputs(
                    image_edge, facts, task, path, numeric, entry, index
                )
            )
        elif role == "reference_video":
            arr, name, layout, hold = _prepare_video_frames(
                _PrepareVideoFramesInputs(
                    short_edge,
                    facts,
                    upstream_warnings,
                    experiment,
                    index,
                    path,
                    frame_cap,
                    start,
                    numeric,
                    material,
                    generated_frames,
                    entry,
                )
            )
            _prepare_video_soundtrack(
                _PrepareVideoSoundtrackInputs(
                    facts,
                    material,
                    run,
                    index,
                    entry,
                    path,
                    chain,
                    seconds_cap,
                    start,
                    numeric,
                    hold,
                    generated_frames,
                    tensors,
                    arrays,
                )
            )
        else:  # reference_audio
            arr, name, layout = _prepare_audio_wave(
                _PrepareAudioWaveInputs(
                    path, chain, seconds_cap, start, facts, numeric, entry, index
                )
            )
        _store_material(
            _StoreMaterialInputs(
                matte,
                entry,
                run,
                index,
                role,
                arr,
                numeric,
                tensors,
                name,
                layout,
                arrays,
                entries,
                done,
                total,
            )
        )


def _write_material_tensors(
    tensors: list[tuple[TensorDecl, bytes]], run: StageRun, document: dict[str, Any]
) -> None:
    if tensors:
        payload_path = run.output_dir / "prepared.payload.safetensors"
        write_payload(
            payload_path,
            tensors,
            metadata={"kind": "h3_prepared_media", "sglang": SGLANG_SOURCE_REVISION},
        )
        digest, size = file_sha256(payload_path)
        document["payload"] = {
            "artifact_id": f"sha256:{digest}",
            "sha256": digest,
            "size_bytes": size,
            "media_type": "application/x-safetensors",
        }

        run.outputs.append(
            OutputFile(
                name="prepared.payload",
                path=payload_path,
                media_type="application/x-safetensors",
                kind="metadata",
            )
        )
