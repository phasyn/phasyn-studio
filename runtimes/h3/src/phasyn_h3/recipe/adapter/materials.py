"""Task/material policy and the normalized material plan.

Official support policy (upstream MiniMax-H3 model card):

* t2va  — no materials (FL2VA checkpoint)
* fl2va — first_frame <= 1, last_frame <= 1, total 1..2 (FL2VA checkpoint);
          ordered keyframe signatures (0,), (-1,), (0, -1) only (SG:task_profiles.py:72-76)
* ref2va — reference_image <= 9, reference_video <= 3, reference_audio <= 3, total 1..12
          (Ref2VA checkpoint); audio-only is rejected even though the pinned parser
          accepts it (SG:task_profiles.py:186-241 has an ``audio`` rule).

The pinned SGLang source defines no per-clip duration limit for reference
video/audio: it only *truncates* audio to the generated duration
(SG:stages/audio_encoding.py:147-152 + SG:reference_encoding.py:266-267) and caps
reference-video frames at the generated frame count (SG:reference_encoding.py:734-764,
811-818).  The official README's 2-15 s per clip / <=15 s total guidance
(H3:README.md:85) is not enforced by the runtime; the product enforces it as its
official support policy in ``reference_clip_diagnostics`` (the supported policy follows the
official guide even where the parser is wider).

``hold_last_frame`` (Phasyn Studio, ``reference_video`` only): ``prepare_media`` decodes the
window ``[start_seconds, end_seconds)``, then repeats its last frame up to the generated frame
count and pads its soundtrack with silence to the same length.  Such a clip always conditions at
the generated length: the 2-15 s / <=15 s rules and the row estimates take that length, and the
window itself only has to hold one frame.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

from phasyn_h3.recipe.abi.resolve import TaskPolicy

from . import constants as C
from ._diag import INVALID, UNSUPPORTED, err, warn
from .geometry import (
    align_frame_count,
    audio_latent_t,
    latent_frame_rows,
    requested_frame_count,
    resolve_reference_image_shape,
    resolve_spatial_shape,
    video_latent_t,
)

TASK_POLICIES: dict[str, TaskPolicy] = {
    "t2va": TaskPolicy(
        task="t2va",
        variants=("fl2va",),
        roles={},
        total=(0, 0),
        label_zh="文字生成音畫（T2VA）",
        requires_visual_reference=False,
        notes_zh=("不接受任何素材；只用 prompt。",),
    ),
    "fl2va": TaskPolicy(
        task="fl2va",
        variants=("fl2va",),
        roles={"first_frame": (0, 1), "last_frame": (0, 1)},
        total=(1, 2),
        label_zh="首幀／末幀／首末幀生成音畫（FL2VA）",
        requires_visual_reference=True,
        notes_zh=(
            "首末幀同時存在時必須 first_frame 在前（釘版只接受 frame_index 順序 [0]、[-1]、[0,-1]）。",
            "第一張關鍵幀會被拉伸到目標畫布；第二張以保持比例的 cover-crop 對齊。",
            "有末幀條件時不可選 trim_to_requested（會裁掉末幀 anchor）。",
        ),
    ),
    "ref2va": TaskPolicy(
        task="ref2va",
        variants=("ref2va",),
        roles={"reference_image": (0, 9), "reference_video": (0, 3), "reference_audio": (0, 3)},
        total=(1, 12),
        label_zh="多模態參考生成音畫（Ref2VA）",
        requires_visual_reference=True,
        notes_zh=(
            "至少需要一張參考圖或一段參考影片；只有音訊的參考不在官方支援範圍。",
            "官方 README 另建議每段影片／音訊 2–15 秒、總長 ≤15 秒；釘版 SGLang 只會截斷到生成時長，不額外檢查。",
            "參考音訊與影片原聲會被截斷到生成時長（釘版 runtime 行為）。",
        ),
    ),
}

ROLE_MEDIA = {
    "first_frame": "image/",
    "last_frame": "image/",
    "reference_image": "image/",
    "reference_video": "video/",
    "reference_audio": "audio/",
}
KEYFRAME_ROLES = ("first_frame", "last_frame")
_ROLE_FRAME_INDEX = {"first_frame": 0, "last_frame": -1}
IMAGE_ROLES = ("first_frame", "last_frame", "reference_image")

# Analytic upper bound of DiT rows per latent frame for a reference video resolved with
# adapt_shape_v1 at base 768: rounded dims <= nominal + 16 px each and nominal area <= MAX_PIXELS,
# so rows <= (MAX_PIXELS + 16 * (W + H) + 256) / 1024 with W + H maximal at ratio 4:1
# (2031.9 + 508.0) -> 1047.  Short-edge mode (ratio <= 1.75) gives <= 1041.
MAX_REFERENCE_VIDEO_FRAME_ROWS = 1047
# Reference images: 2048 px short edge, ratio <= 4 -> at most 2048 x 8192 -> 64 * 256 rows.
MAX_REFERENCE_IMAGE_ROWS = (C.REFERENCE_IMAGE_SHORT_EDGE // C.TOKEN_STRIDE) * (
    4 * C.REFERENCE_IMAGE_SHORT_EDGE // C.TOKEN_STRIDE
)


def _media_major(material: Mapping[str, Any]) -> str:
    artifact = material.get("artifact") or {}
    return str(artifact.get("media_type") or "").lower()


def holds_last_frame(material: Mapping[str, Any]) -> bool:
    """A reference video held at its window's last frame up to the generated length (``hold_last_frame``)."""
    return material.get("role") == "reference_video" and material.get("hold_last_frame") is True


def material_diagnostics(
    task: str, materials: Sequence[Mapping[str, Any]], *, duration_policy: str | None = None
) -> list[dict[str, Any]]:
    """checks (job-request field paths)."""
    policy = TASK_POLICIES.get(task)
    if policy is None:
        return []  # task errors are reported by the caller
    out: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for i, material in enumerate(materials):
        role = str(material.get("role"))
        path = f"materials[{i}]"
        if role not in policy.roles:
            allowed = "、".join(policy.roles) or "（不接受素材）"
            out.append(
                err(UNSUPPORTED, f"任務 {task} 不接受素材角色 {role}；允許：{allowed}", f"{path}.role", actual=role)
            )
            continue
        counts[role] = counts.get(role, 0) + 1
        if counts[role] > policy.roles[role][1]:
            out.append(
                err(
                    INVALID,
                    f"{role} 最多 {policy.roles[role][1]} 個",
                    f"{path}.role",
                    expected=f"<= {policy.roles[role][1]}",
                    actual=counts[role],
                )
            )
        media = _media_major(material)
        if not media.startswith(ROLE_MEDIA[role]):
            out.append(
                err(
                    INVALID,
                    f"{role} 需要 {ROLE_MEDIA[role]}* 素材",
                    f"{path}.artifact.media_type",
                    expected=ROLE_MEDIA[role] + "*",
                    actual=media or "(none)",
                )
            )
        hold = material.get("hold_last_frame")
        if hold is not None and not isinstance(hold, bool):
            out.append(err(INVALID, "hold_last_frame 必須是 true 或 false", f"{path}.hold_last_frame", actual=hold))
        elif hold and role != "reference_video":
            out.append(
                err(
                    INVALID,
                    "hold_last_frame 只適用於參考影片",
                    f"{path}.hold_last_frame",
                    expected="reference_video",
                    actual=role,
                )
            )
        start = material.get("start_seconds", 0) or 0
        end = material.get("end_seconds")
        if role in IMAGE_ROLES:
            if start:
                out.append(err(INVALID, "圖片素材不支援 start_seconds", f"{path}.start_seconds", actual=start))
            if end is not None:
                out.append(err(INVALID, "圖片素材不支援 end_seconds", f"{path}.end_seconds", actual=end))
        elif end is not None and float(end) <= float(start):
            out.append(
                err(INVALID, "end_seconds 必須大於 start_seconds", f"{path}.end_seconds", actual=f"{start}..{end}")
            )
    total = len(materials)
    lo, hi = policy.total
    if not lo <= total <= hi:
        out.append(
            err(
                INVALID,
                f"任務 {task} 的素材總數必須介於 {lo}–{hi}",
                "materials",
                expected=f"[{lo}, {hi}]",
                actual=total,
            )
        )
    if task == "fl2va":
        roles = [str(m.get("role")) for m in materials if m.get("role") in KEYFRAME_ROLES]
        signature = tuple(_ROLE_FRAME_INDEX[r] for r in roles)
        if roles and signature not in C.KEYFRAME_SIGNATURES and len(set(roles)) == len(roles):
            idx = next(i for i, m in enumerate(materials) if m.get("role") == "last_frame")
            out.append(
                err(
                    UNSUPPORTED,
                    "首末幀順序必須是 first_frame 在前、last_frame 在後；素材順序具語意，不自動重排",
                    f"materials[{idx}].role",
                    expected="first_frame, last_frame",
                    actual=", ".join(roles),
                )
            )
    if task == "ref2va" and materials and all(m.get("role") == "reference_audio" for m in materials):
        out.append(
            err(
                UNSUPPORTED,
                "官方支援政策不接受只有音訊的參考（釘版 parser 雖可接受）；請加入參考圖或參考影片",
                "materials",
                expected="至少一張 reference_image 或一段 reference_video",
                actual="audio-only",
            )
        )
    if duration_policy == "trim_to_requested":
        for i, material in enumerate(materials):
            if material.get("role") == "last_frame":
                out.append(
                    err(
                        UNSUPPORTED,
                        "末幀條件不可搭配 trim_to_requested：裁尾會移除末幀 anchor；請用 preserve_generated 或移除末幀",
                        "output.duration_policy",
                        f"materials[{i}].role",
                        expected="preserve_generated",
                        actual="trim_to_requested",
                    )
                )
    return out


def _metadata_for(material: Mapping[str, Any], index: int, metadata: Mapping[str, Mapping[str, Any]]) -> dict:
    artifact = material.get("artifact") or {}
    for key in (artifact.get("artifact_id"), artifact.get("sha256"), f"materials[{index}]", str(index)):
        if key is not None and key in metadata:
            return dict(metadata[key])
    return {}


def _display_size(meta: Mapping[str, Any]) -> tuple[float, float] | None:
    w = meta.get("display_width", meta.get("width"))
    h = meta.get("display_height", meta.get("height"))
    try:
        if w is None or h is None or float(w) <= 0 or float(h) <= 0:
            return None
        return float(w), float(h)
    except (TypeError, ValueError):
        return None


def condition_noise_plan(materials: Sequence[Mapping[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Pinned runtime has one imgvid and one audio noise_aug per request (SG:condition_noise.py:24-45,121-144).

    ``null`` means the model default (SG:denoise_loop.py:30,32); explicit values
    within one class must agree, otherwise the request is rejected (no silent pick).
    """
    classes: dict[str, list[tuple[int, float]]] = {"imgvid": [], "audio": []}
    for i, material in enumerate(materials):
        value = material.get("condition_noise")
        if value is None:
            continue
        cls = "audio" if material.get("role") == "reference_audio" else "imgvid"
        classes[cls].append((i, float(value)))
    out: dict[str, Any] = {}
    diags: list[dict[str, Any]] = []
    defaults = {"imgvid": C.IMGVID_COND_NOISE_DEFAULT, "audio": C.AUDIO_COND_NOISE_DEFAULT}
    for cls, values in classes.items():
        distinct = sorted({v for _, v in values})
        if len(distinct) > 1:
            diags.append(
                err(
                    UNSUPPORTED,
                    f"釘版 runtime 每個請求只有一個 {cls} condition noise；同類素材的 condition_noise 必須一致",
                    *[f"materials[{i}].condition_noise" for i, _ in values],
                    actual=", ".join(str(v) for v in distinct),
                )
            )
        explicit = values[0][1] if values else None
        out[cls] = explicit if explicit is not None else defaults[cls]
        out[f"{cls}_source"] = "request" if explicit is not None else "model_default"
    return out, diags


def normalize_materials(
    task: str,
    materials: Sequence[Mapping[str, Any]],
    *,
    geometry: Mapping[str, Any],
    metadata: Mapping[str, Mapping[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    """Ordered material plan + reference-row facts + warnings.

    Order is the request order (semantic; SG:request_validation.py:6-7).  Presentation
    labels follow SG:presentation.py:116-131 (fl2va ``<Picture i>``) and
    SG:stages/text_encoding.py:431-469 (ref2va: ``<Picture i>``, ``<Audio j>`` label only,
    a video contributes ``<Audio j>`` before ``<Video k>`` when it carries a soundtrack).
    """
    metadata = metadata or {}
    width, height = int(geometry["width"]), int(geometry["height"])
    generated_frames = int(geometry["generated_frames"])
    generated_seconds = float(geometry["generated_seconds"])
    target_rows = latent_frame_rows(width, height)
    target_latent_t = video_latent_t(generated_frames)
    target_audio_t = audio_latent_t(generated_seconds)
    counters = {"image": 0, "audio": 0, "video": 0}
    position = 0
    pending_probe = False
    keyframe_seen = 0
    out: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    ref_estimate = 0
    ref_upper = 0
    estimates_known = True
    for i, material in enumerate(materials):
        role = str(material.get("role"))
        meta = _metadata_for(material, i, metadata)
        size = _display_size(meta)
        start = float(material.get("start_seconds", 0) or 0)
        end = material.get("end_seconds")
        entry: dict[str, Any] = {
            "index": i,
            "role": role,
            "artifact": dict(material.get("artifact") or {}),
            "presentation": [],
            "condition_noise": material.get("condition_noise"),
        }
        if role in KEYFRAME_ROLES:
            frame_index = _ROLE_FRAME_INDEX[role]
            keyframe_seen += 1
            counters["image"] += 1
            entry.update(
                condition_role="keyframe",
                condition_type="image",
                material_chain="image.target_canvas",
                frame_index=frame_index,
                resolved_frame_index=generated_frames - 1 if frame_index == -1 else frame_index,
                encoders={"qwen": True, "visual_vae": True, "audio_vae": False},
                # SG:canvas.py:214-230: first keyframe is stretched, a second one is cover-cropped
                geometry_policy="target_canvas_stretch" if keyframe_seen == 1 else "target_canvas_cover_crop",
                window=None,
                token_rows={"visual": target_rows, "audio": 0, "known": True},
            )
            entry["presentation"].append(
                {
                    "position": position,
                    "label": f"<Picture {counters['image']}>",
                    "modality": "image",
                    "conditional": False,
                }
            )
            position += 1
            if keyframe_seen == 1 and size is not None:
                ratio = size[0] / size[1]
                if abs(ratio - width / height) / (width / height) > 0.01:
                    warnings.append(
                        warn(
                            "KEYFRAME_STRETCH",
                            "第一張關鍵幀比例與目標畫布不同；釘版會直接拉伸到畫布（SG canvas.py），可能變形",
                            f"materials[{i}].artifact",
                        )
                    )
        elif role == "reference_image":
            counters["image"] += 1
            rows = None
            if size is not None:
                try:
                    shape = resolve_reference_image_shape(*size, short_edge=geometry.get("reference_image_short_edge"))
                    rows = latent_frame_rows(shape["width"], shape["height"])
                except ValueError:
                    warnings.append(
                        warn("REFERENCE_IMAGE_RATIO", "參考圖比例超出 1:4..4:1", f"materials[{i}].artifact")
                    )
            entry.update(
                condition_role="reference",
                condition_type="image",
                material_chain="image.reference_preserve",
                frame_index=None,
                resolved_frame_index=None,
                encoders={"qwen": True, "visual_vae": True, "audio_vae": False},
                geometry_policy=f"reference_image_short_edge_{geometry.get('reference_image_short_edge', 2048)}",
                window=None,
                token_rows={"visual": rows, "audio": 0, "known": rows is not None},
            )
            entry["presentation"].append(
                {
                    "position": position,
                    "label": f"<Picture {counters['image']}>",
                    "modality": "image",
                    "conditional": False,
                }
            )
            position += 1
            ref_upper += MAX_REFERENCE_IMAGE_ROWS
            if rows is None:
                estimates_known = False
            else:
                ref_estimate += rows
        elif role == "reference_video":
            embedded = bool(material.get("use_embedded_audio", True))
            has_audio = meta.get("has_audio")
            if embedded and has_audio is True:
                condition_type, chain, audio_conditional = "video_audio", "video_audio.reference_preserve", False
            else:
                # use_embedded_audio=false: prepare_media leaves the soundtrack out (soundtrack_dropped; no
                # waveform, no <Audio j>, an empty audio partial), like the pinned ``video`` chain of a file
                # without one (SG:stages/audio_encoding.py:174-185); a shim deviation,
                condition_type, chain = "video", "video.reference_preserve"
                audio_conditional = embedded and has_audio is None
            contributes_audio = embedded and has_audio is not False
            vrows = None
            if size is not None:
                try:
                    shape = resolve_spatial_shape(*size, base_short_edge=C.BASE_SHORT_EDGE)
                    vrows = latent_frame_rows(shape["width"], shape["height"])
                except ValueError:
                    warnings.append(
                        warn("REFERENCE_VIDEO_RATIO", "參考影片比例超出 1:4..4:1", f"materials[{i}].artifact")
                    )
            duration = meta.get("video_duration_seconds", meta.get("duration_seconds"))
            held = holds_last_frame(material)
            frames = generated_frames  # a held clip is always the generated length
            if duration is not None and not held:
                usable = max(0.0, float(duration) - start)
                if end is not None:
                    usable = min(usable, float(end) - start)
                # The same count as prepare_media's reference_window, its FRAME_SLACK (1e-3 frame) included
                frames = max(1, min(generated_frames, int(usable * C.FPS + 1e-3)))
            length_known = held or duration is not None
            ref_t = video_latent_t(align_frame_count(frames))
            visual = None if vrows is None else ref_t * vrows
            audio_rows = (
                C.AUDIO_CHANNELS * audio_latent_t(min(generated_seconds, frames / C.FPS)) if contributes_audio else 0
            )
            window: dict[str, Any] = {
                "start_seconds": start,
                "end_seconds": end,
                "start_applied_by": "runtime_start_time_seconds",  # SG:resolved_plan.py:60-61
                "end_applied_by": None if end is None else "prepare_media",
                "runtime_max_frames": generated_frames,  # SG:reference_encoding.py:734-764
                "runtime_max_seconds": generated_seconds,
            }
            if held:
                window.update(hold_last_frame=True, hold_applied_by="prepare_media")
            entry.update(
                condition_role="reference",
                condition_type=condition_type,
                material_chain=chain,
                frame_index=None,
                resolved_frame_index=None,
                encoders={"qwen": True, "visual_vae": True, "audio_vae": contributes_audio},
                geometry_policy="adapt_shape_v1_short_edge_768",
                use_embedded_audio=embedded,
                window=window,
                token_rows={
                    "visual": visual,
                    "audio": audio_rows,
                    "known": visual is not None and length_known,
                },
            )
            if contributes_audio:
                counters["audio"] += 1
                entry["presentation"].append(
                    {
                        "position": position,
                        "label": f"<Audio {counters['audio']}>",
                        "modality": "audio",
                        "conditional": audio_conditional,
                    }
                )
                position += 1
                pending_probe = pending_probe or audio_conditional
            counters["video"] += 1
            entry["presentation"].append(
                {
                    "position": position,
                    "label": f"<Video {counters['video']}>",
                    "modality": "video",
                    "conditional": False,
                }
            )
            position += 1
            ref_upper += target_latent_t * MAX_REFERENCE_VIDEO_FRAME_ROWS + C.AUDIO_CHANNELS * target_audio_t
            if visual is None or not length_known:
                estimates_known = False
            else:
                ref_estimate += visual + audio_rows
        elif role == "reference_audio":
            counters["audio"] += 1
            duration = meta.get("audio_duration_seconds", meta.get("duration_seconds"))
            rows = None
            if duration is not None:
                usable = max(0.0, float(duration) - start)
                if end is not None:
                    usable = min(usable, float(end) - start)
                rows = C.AUDIO_CHANNELS * audio_latent_t(min(generated_seconds, usable))
                if usable > generated_seconds:
                    warnings.append(
                        warn(
                            "REFERENCE_AUDIO_TRUNCATED",
                            f"參考音訊長於生成時長 {generated_seconds:.3f} 秒；"
                            "釘版 runtime 會截斷（不是本產品默默改動）",
                            f"materials[{i}]",
                        )
                    )
            entry.update(
                condition_role="reference",
                condition_type="audio",
                material_chain="audio",
                frame_index=None,
                resolved_frame_index=None,
                encoders={"qwen": False, "visual_vae": False, "audio_vae": True},
                geometry_policy="stereo_32k_truncated_to_generated_duration",
                window={
                    "start_seconds": start,
                    "end_seconds": end,
                    # the pinned ``audio`` chain has no seek (SG:request_validation.py:227-236)
                    "start_applied_by": "prepare_media" if start else None,
                    "end_applied_by": None if end is None else "prepare_media",
                    "runtime_max_seconds": generated_seconds,  # SG:stages/audio_encoding.py:147-152
                },
                token_rows={"visual": 0, "audio": rows, "known": rows is not None},
            )
            entry["presentation"].append(
                {
                    "position": position,
                    "label": f"<Audio {counters['audio']}>",
                    "modality": "audio",
                    "conditional": False,
                    "ordinal_depends_on_probe": pending_probe,
                }
            )
            position += 1
            ref_upper += C.AUDIO_CHANNELS * target_audio_t
            if rows is None:
                estimates_known = False
            else:
                ref_estimate += rows
        else:  # pragma: no cover - rejected earlier
            continue
        out.append(entry)
    keyframe_rows = keyframe_seen * target_rows
    facts = {
        "N_keyframe_cond": keyframe_rows,
        "N_references_upper_bound": ref_upper,
        "N_references_estimate": ref_estimate if estimates_known else None,
        "reference_estimates_known": estimates_known,
        "presentation_items": position,
        "presentation_depends_on_probe": pending_probe,
    }
    return out, facts, warnings


REFERENCE_CLIP_SECONDS = (2.0, 15.0)
REFERENCE_TOTAL_SECONDS = 15.0


def generated_seconds_of(output: Mapping[str, Any]) -> float | None:
    """The generated length (frames snapped to 17n+5, / 24) of a request's ``output.requested_seconds``;
    None when that is not a finite number (the request's own duration error is reported then)."""
    seconds = output.get("requested_seconds")
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds):
        return None
    return align_frame_count(requested_frame_count(seconds)) / C.FPS


def reference_clip_diagnostics(
    materials: Sequence[Mapping[str, Any]],
    metadata: Mapping[str, Mapping[str, Any]],
    *,
    generated_seconds: float | None = None,
) -> list[dict[str, Any]]:
    """Official H3 guide (H3:README.md:85): each reference video/audio clip 2–15 s,
    total per type <= 15 s.  The clip is the requested window when given, else the
    probed media duration minus start; an unknown duration cannot be accepted.

    A held reference video (``hold_last_frame``) is its window followed by the window's last frame
    up to the generated length, so its clip is ``generated_seconds`` and its window needs only one
    frame (1/24 s); with an unknown generated length it is not measured."""
    out: list[dict[str, Any]] = []
    totals: dict[str, float] = {}
    lo, hi = REFERENCE_CLIP_SECONDS
    for i, material in enumerate(materials):
        role = material.get("role")
        if role not in ("reference_video", "reference_audio"):
            continue
        path = f"materials[{i}]"
        start = float(material.get("start_seconds", 0) or 0)
        end = material.get("end_seconds")
        meta = _metadata_for(material, i, metadata)
        duration = meta.get("duration_seconds")
        if end is not None:
            clip = float(end) - start
        elif duration is not None:
            clip = float(duration) - start
        else:
            out.append(
                err(
                    INVALID,
                    "參考素材時長未知（尚未 probe）；無法驗證官方 2–15 秒限制",
                    f"{path}.end_seconds",
                )
            )
            continue
        # Durations shown in libraries are rounded (a 107-frame clip is 4.458333 s, listed as 4.459 s): an end up to
        # half a frame past the clip is the clip's end, the decoder stops there; anything later is refused
        if duration is not None and end is not None and float(end) > float(duration) + 0.5 / C.FPS:
            out.append(
                err(
                    INVALID,
                    "end_seconds 超過素材實際長度",
                    f"{path}.end_seconds",
                    expected=f"<= {duration}",
                    actual=end,
                )
            )
        if holds_last_frame(material):
            if clip < 1 / C.FPS - 1e-6:
                out.append(
                    err(
                        INVALID,
                        "hold_last_frame 的參考影片視窗至少要 1 格（終點 − 起點 ≥ 1/24 秒）",
                        f"{path}.end_seconds",
                        expected=f">= {1 / C.FPS:.4f}",
                        actual=round(clip, 4),
                    )
                )
            if generated_seconds is None:
                continue
            clip = generated_seconds
        if not lo <= clip <= hi:
            out.append(
                err(
                    UNSUPPORTED,
                    f"{role} 每段需 {lo:g}–{hi:g} 秒（官方 Ref2VA 規範）",
                    f"{path}.end_seconds",
                    expected=f"[{lo:g}, {hi:g}]",
                    actual=round(clip, 3),
                )
            )
        totals[role] = totals.get(role, 0.0) + max(0.0, clip)
    for role, total in totals.items():
        if total > REFERENCE_TOTAL_SECONDS + 1e-6:
            out.append(
                err(
                    UNSUPPORTED,
                    f"{role} 總長需 ≤ {REFERENCE_TOTAL_SECONDS:g} 秒（官方 Ref2VA 規範）",
                    "materials",
                    expected=f"<= {REFERENCE_TOTAL_SECONDS:g}",
                    actual=round(total, 3),
                )
            )
    return out
