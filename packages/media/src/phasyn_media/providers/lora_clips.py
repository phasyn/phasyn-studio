"""``media.lora_clips``: cut source videos into LoRA training clips (one per shot) with their evidence.

For every source video (role ``train``, ``heldout`` or ``eval_only``):

1. shots from the cut detector of :mod:`phasyn_media.scenes`;
2. a 12 fps grey pass for shot motion, luma and flashes, and stills spread over the source for static overlays
   (logos, watermarks, also translucent ones) that become loss masks and are blanked in the reference stills
   instead of being cropped away;
3. a 24 -> 30 fps conversion (one repeated frame in five at a fixed phase) is detected and undone by
   decimation before cutting, so the clips keep the drawings' own timing;
4. one window of 22 frames per usable shot, shots spaced apart, high motion first, capped per source;
5. every window is decoded at 24 fps and 1280x736 (scaled to cover, centre crop); a window with a letterbox or
   a cut the detector missed is rejected, otherwise its lossless clip, two reference frames from the same shot
   outside the window and a three-frame contact sheet (for the review model) are published.

The output is one JSON document (``lora.dataset.v1``) whose clips name their files by FileRef. Nothing is
captioned or chosen here; the review and the selection come later.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
from phasyn_components.errors import ComponentError
from phasyn_components.lora_training import constants as c
from phasyn_components.provider import (
    BaseProvider,
    Description,
    Port,
    RunContext,
    settings_schema,
)
from phasyn_components.settings import normalize_recording

from .. import lora_dataset as stats
from ..errors import MediaError
from ..files import check_local_file
from ..limits import DEFAULT_LIMITS
from ..probe import probe
from ..scenes import SceneDetection, detect_scene_cuts
from ..tools import (
    find_ffmpeg,
    input_url,
    list_encoders,
    redact,
    run_tool,
    summarize_stderr,
)
from ._failure import media_failure


MAX_SOURCES = 64
GREY_RATE = 12.0
GREY_W, GREY_H = 96, 54
TELECINE_W, TELECINE_H = 64, 36
TELECINE_SEGMENT_S = 8.0
OVERLAY_SAMPLES = 48
OVERLAY_W, OVERLAY_H = (
    480,
    276,
)  # the clip geometry at 3/8: a corner logo keeps its outline
SHEET_W, SHEET_H = 448, 258
CLEAR_ROWS = (64, 600)
LETTERBOX_MAX = 24
SILENCE_RATE = 48000
SILENCE_SECONDS = 2.5
NTSC_FPS = (29.0, 31.0)
REFERENCE_MARGIN_S = 0.25
LIMITS = replace(DEFAULT_LIMITS, max_frames=1_000_000, process_timeout_seconds=3600.0)
PARAMS: dict[str, dict[str, Any]] = {
    "scene_threshold": {
        "type": "number",
        "minimum": 0.05,
        "maximum": 0.9,
        "default": 0.3,
    },
    "min_shot_seconds": {
        "type": "number",
        "minimum": 0.5,
        "maximum": 30,
        "default": 1.3,
    },
    "min_gap_seconds": {"type": "number", "minimum": 0, "maximum": 120, "default": 4.0},
    "max_clips_per_source": {
        "type": "integer",
        "minimum": 1,
        "maximum": 2000,
        "default": 400,
    },
    "max_heldout_per_source": {
        "type": "integer",
        "minimum": 1,
        "maximum": 500,
        "default": 40,
    },
    "seed": {"type": "integer", "minimum": 0, "default": 0},
}
_ROLE_LIMIT = {
    "train": "max_clips_per_source",
    "heldout": "max_heldout_per_source",
    "eval_only": "max_heldout_per_source",
}


def _params(ctx: RunContext) -> dict[str, Any]:
    unknown = set(ctx.parameters) - PARAMS.keys()
    if unknown:
        raise ComponentError(
            "INVALID_ARGUMENT", f"不支援的參數：{', '.join(sorted(unknown))}"
        )
    out: dict[str, Any] = {}
    for key, spec in PARAMS.items():
        value = ctx.parameters.get(key, spec["default"])
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ComponentError("INVALID_ARGUMENT", f"{key} 必須是數字")
        if not spec["minimum"] <= value <= spec.get("maximum", value):
            raise ComponentError("INVALID_ARGUMENT", f"{key} 超出範圍")
        out[key] = int(value) if spec["type"] == "integer" else float(value)
    return out


def _sources(ctx: RunContext) -> list[dict[str, Any]]:
    value = ctx.input("videos").value
    if not isinstance(value, list) or not 0 < len(value) <= MAX_SOURCES:
        raise ComponentError(
            "INVALID_ARGUMENT", f"videos 需要 1 到 {MAX_SOURCES} 支影片"
        )
    seen: set[str] = set()
    out = []
    for i, item in enumerate(value):
        if not isinstance(item, Mapping) or not isinstance(item.get("file"), Mapping):
            raise ComponentError(
                "INVALID_ARGUMENT", f"videos[{i}] 需要 file（FileRef）"
            )
        source_id = str(item.get("source_id") or f"s{i + 1:02d}")
        role = str(item.get("role") or "train")
        if role not in c.SOURCE_ROLES or source_id in seen:
            raise ComponentError(
                "INVALID_ARGUMENT", f"videos[{i}] 的 role 或 source_id 無效"
            )
        seen.add(source_id)
        out.append(
            {
                "file": dict(item["file"]),
                "source_id": source_id,
                "role": role,
                "label": str(item.get("label") or source_id)[:200],
            }
        )
    return out


def _ffmpeg(  # noqa: PLR0913 - one bounded tool run, every knob explicit
    ctx: RunContext,
    exe: str,
    args: list[str],
    *,
    max_bytes: int,
    stdin: bytes | None = None,
    marks: Mapping[str, str] | None = None,
) -> bytes:
    """One bounded FFmpeg run (deadline, cancel, output cap); stdout is returned."""
    ctx.check_cancelled()
    run = run_tool(
        [
            exe,
            "-hide_banner",
            "-loglevel",
            "error",
            *([] if stdin is not None else ["-nostdin"]),
            *args,
        ],
        timeout=min(ctx.remaining_seconds(), LIMITS.process_timeout_seconds),
        cancel=ctx.cancel_token,
        max_stdout_bytes=max_bytes,
        stdin_data=stdin,
        what="FFmpeg LoRA clips",
    )
    if run.returncode:
        raise MediaError(
            "MEDIA_TOOL_FAILED",
            summarize_stderr(redact(run.stderr, dict(marks or {})), 600),
        )
    return run.stdout


class _Decoder:
    """Bounded FFmpeg decodes of one local source into numpy arrays."""

    def __init__(self, ctx: RunContext, path: Path) -> None:
        self.ctx, self.path = ctx, path
        self.url = input_url(path)
        self.exe = find_ffmpeg()

    def _run(
        self, args: list[str], *, max_bytes: int, stdin: bytes | None = None
    ) -> bytes:
        marks = {self.url: "<input>", str(self.path): "<input>"}
        return _ffmpeg(
            self.ctx, self.exe, args, max_bytes=max_bytes, stdin=stdin, marks=marks
        )

    def _input(self, start: float | None = None) -> list[str]:
        seek = ["-ss", f"{start:.3f}"] if start is not None else []
        return [
            *seek,
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            LIMITS.format_whitelist,
            *LIMITS.decoder_flags,
            "-i",
            self.url,
            "-map",
            "0:V:0",
            "-an",
            "-sn",
            "-dn",
        ]

    def grey(  # noqa: PLR0913 - the decode window and its output geometry
        self,
        *,
        rate: float | None,
        width: int,
        height: int,
        start: float | None = None,
        seconds: float | None = None,
        max_frames: int,
    ) -> np.ndarray:
        """Grey frames [N, height, width] (``rate`` None = the source's own frame rate)."""
        vf = (
            f"fps={rate}," if rate else ""
        ) + f"scale={width}:{height}:flags=area,format=gray"
        dur = ["-t", f"{seconds:.3f}"] if seconds else []
        raw = self._run(
            [
                *self._input(start),
                *dur,
                "-vf",
                vf,
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray",
                "-",
            ],
            max_bytes=max_frames * width * height + 1,
        )
        n = len(raw) // (width * height)
        return np.frombuffer(raw[: n * width * height], np.uint8).reshape(
            n, height, width
        )

    def stills(self, times: Sequence[float], *, width: int, height: int) -> np.ndarray:
        """One grey frame at each of ``times`` seconds [N, height, width], in the clip's crop of the picture."""
        vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=area,"
            f"crop={width}:{height},format=gray"
        )
        size = width * height
        out = []
        for t in times:
            self.ctx.check_cancelled()
            raw = self._run(
                [
                    *self._input(t),
                    "-vf",
                    vf,
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "gray",
                    "-",
                ],
                max_bytes=size + 1,
            )
            if len(raw) == size:
                out.append(np.frombuffer(raw, np.uint8).reshape(height, width))
        return np.stack(out) if out else np.zeros((0, height, width), np.uint8)

    def rgb(self, start: float, frames: int, *, decimate: bool) -> np.ndarray:
        """``frames`` RGB frames at 24 fps and the clip geometry, from ``start`` seconds."""
        vf = ("decimate=cycle=5," if decimate else "") + (
            f"fps={c.CLIP_FPS},scale={c.CLIP_WIDTH}:{c.CLIP_HEIGHT}:force_original_aspect_ratio=increase:"
            f"flags=lanczos,crop={c.CLIP_WIDTH}:{c.CLIP_HEIGHT},setsar=1"
        )
        size = c.CLIP_WIDTH * c.CLIP_HEIGHT * 3
        raw = self._run(
            [
                *self._input(start),
                "-vf",
                vf,
                "-frames:v",
                str(frames),
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ],
            max_bytes=frames * size + 1,
        )
        n = len(raw) // size
        return np.frombuffer(raw[: n * size], np.uint8).reshape(
            n, c.CLIP_HEIGHT, c.CLIP_WIDTH, 3
        )

    def encode(self, frames: np.ndarray, args: list[str], fmt: str) -> bytes:
        """Encode RGB frames from stdin with the given output arguments; returns the encoded bytes."""
        h, w = frames.shape[1:3]
        return self._run(
            [
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-s",
                f"{w}x{h}",
                "-r",
                str(c.CLIP_FPS),
                "-i",
                "-",
                *args,
                "-f",
                fmt,
                "-",
            ],
            max_bytes=256 * 1024 * 1024,
            stdin=frames.tobytes(),
        )


def _publish(
    ctx: RunContext, data: bytes, media_type: str, meta: dict[str, Any], type_id: str
) -> dict[str, Any]:
    out = ctx.new_file(None, media_type, meta, type_id=type_id)
    out.write(data)
    out.finish()
    return ctx.file_ref(out)


def _clip_codec() -> list[str]:
    if "libx264rgb" in list_encoders():
        return [
            "-c:v",
            "libx264rgb",
            "-qp",
            "0",
            "-preset",
            "faster",
            "-pix_fmt",
            "rgb24",
        ]
    return ["-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgr0"]


def _silence(ctx: RunContext) -> dict[str, Any]:
    seconds = SILENCE_SECONDS  # a reference audio needs 2-15 s; the trainer keeps the clip's length
    wav = _ffmpeg(
        ctx,
        find_ffmpeg(),
        [
            "-f",
            "lavfi",
            "-i",
            f"anullsrc=channel_layout=stereo:sample_rate={SILENCE_RATE}",
            "-t",
            f"{seconds:.6f}",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "-",
        ],
        max_bytes=16 * 1024 * 1024,
    )
    return _publish(
        ctx,
        wav,
        "audio/wav",
        {"role": "lora_silence", "seconds": seconds},
        "media.audio.v1",
    )


class _SourceJob:
    """All clips of one source."""

    def __init__(
        self,
        ctx: RunContext,
        source: dict[str, Any],
        params: dict[str, Any],
        codec: list[str],
    ) -> None:
        self.ctx, self.source, self.params, self.codec = ctx, source, params, codec
        local = check_local_file(ctx.resolve_file(source["file"]), limits=LIMITS)
        self.path = local.path
        self.info = probe(
            self.path, limits=LIMITS, count_frames=False, cancel=ctx.cancel_token
        )
        if self.info.kind != "video" or not (
            self.info.duration_seconds and self.info.fps_num and self.info.fps_den
        ):
            raise MediaError("INVALID_ARGUMENT", f"{source['label']} 不是可讀的影片")
        self.duration = float(self.info.duration_seconds)
        self.fps = self.info.fps_num / self.info.fps_den
        self.dec = _Decoder(ctx, self.path)
        self.last_sheet = b""

    def telecine(self) -> dict[str, Any]:
        if not NTSC_FPS[0] < self.fps < NTSC_FPS[1]:
            return {"telecine": False, "reason": "not_30fps"}
        starts = [self.duration * f for f in (0.2, 0.5, 0.8)]
        segs = [
            self.dec.grey(
                rate=None,
                width=TELECINE_W,
                height=TELECINE_H,
                start=s,
                seconds=TELECINE_SEGMENT_S,
                max_frames=int(TELECINE_SEGMENT_S * 31) + 2,
            )
            for s in starts
        ]
        return stats.telecine_phase(segs)

    def shots(self) -> tuple[list[stats.Shot], list[dict[str, Any]], dict[str, Any]]:
        scenes = detect_scene_cuts(
            self.path,
            SceneDetection(
                threshold=self.params["scene_threshold"], min_gap_seconds=0.5
            ),
            duration_seconds=self.duration,
            limits=LIMITS,
            cancel=self.ctx.cancel_token,
            timeout=min(self.ctx.remaining_seconds(), LIMITS.process_timeout_seconds),
        )
        stream = self.dec.grey(
            rate=GREY_RATE,
            width=GREY_W,
            height=GREY_H,
            max_frames=int(self.duration * GREY_RATE) + 16,
        )
        shots = stats.shot_stats(scenes.cuts_seconds, self.duration, stream, GREY_RATE)
        times = np.linspace(0.0, self.duration, OVERLAY_SAMPLES + 2)[1:-1]
        overlays = stats.static_overlays(
            self.dec.stills(times.tolist(), width=OVERLAY_W, height=OVERLAY_H),
            width=c.CLIP_WIDTH,
            height=c.CLIP_HEIGHT,
        )
        return shots, overlays, {"cuts": len(scenes.cuts_seconds), "shots": len(shots)}

    def run(
        self, index: int, total: int
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        src = self.source
        tele = self.telecine()
        shots, overlays, counts = self.shots()
        limit = int(self.params[_ROLE_LIMIT[src["role"]]])
        rules = stats.WindowRules(
            clip_seconds=c.CLIP_FRAMES / c.CLIP_FPS,
            min_shot_seconds=self.params["min_shot_seconds"],
            min_gap_seconds=self.params["min_gap_seconds"],
            limit=limit,
            seed=int(self.params["seed"]) + index,
        )
        windows = stats.pick_windows(shots, rules)
        skipped: dict[str, int] = {}
        for shot in shots:
            reason = stats.shot_problem(shot, rules)
            if reason:
                skipped[reason] = skipped.get(reason, 0) + 1
        clips = []
        for n, (shot, start) in enumerate(windows):
            self.ctx.check_cancelled()
            clips.append(
                self.clip(
                    shot,
                    start,
                    n,
                    decimate=bool(tele.get("telecine")),
                    overlays=overlays,
                )
            )
            self.progress(clips[-1], index, total, n + 1, len(windows))
        info = {
            "source_id": src["source_id"],
            "label": src["label"],
            "role": src["role"],
            "duration_seconds": round(self.duration, 3),
            "fps": round(self.fps, 4),
            "width": self.info.width,
            "height": self.info.height,
            "decimated": bool(tele.get("telecine")),
            "telecine": tele,
            **counts,
            "windows": len(windows),
            "shots_skipped": skipped,
            "overlays": overlays,
        }
        return info, clips

    def progress(
        self, clip: dict[str, Any], index: int, total: int, done: int, count: int
    ) -> None:
        """The newest contact sheet as the call's preview; step counts the clips of this source."""
        if not clip.get("sheet") or not self.last_sheet or not self.ctx.preview_enabled:
            return
        note = f"{self.source['label']}：{done}/{count}（來源 {index + 1}/{total}）"
        self.ctx.publish_preview(
            step=min(done, count),
            total=max(count, 1),
            data=self.last_sheet,
            media_type="image/jpeg",
            width=SHEET_W * 3,
            height=SHEET_H,
            note=note[:200],
        )

    def clip(
        self,
        shot: stats.Shot,
        start: float,
        n: int,
        *,
        decimate: bool,
        overlays: list[dict[str, Any]],
    ) -> dict[str, Any]:
        src = self.source
        clip_id = f"{src['source_id']}-c{n + 1:04d}"
        entry: dict[str, Any] = {
            "clip_id": clip_id,
            "source_id": src["source_id"],
            "role": src["role"],
            "shot_index": shot.index,
            "shot_start_seconds": round(shot.start, 3),
            "shot_seconds": round(shot.seconds, 3),
            "start_seconds": start,
        }
        frames = self.dec.rgb(start, c.CLIP_FRAMES, decimate=decimate)
        if frames.shape[0] != c.CLIP_FRAMES:
            return {**entry, "rejected": "too_few_frames"}
        st = stats.clip_stats(frames, clear_rows=CLEAR_ROWS)
        entry["stats"] = {k: v for k, v in st.items() if k != "dhash"}
        entry["dhash"] = st["dhash"]
        if st["letterbox_px"] >= LETTERBOX_MAX:
            return {**entry, "rejected": "letterbox"}
        if st["hidden_cut"]:
            return {**entry, "rejected": "hidden_cut"}
        meta = {"role": "lora_clip", "clip_id": clip_id, "source_id": src["source_id"]}
        video = self.dec.encode(frames, self.codec, "matroska")
        entry["video"] = _publish(
            self.ctx,
            video,
            "video/x-matroska",
            {
                **meta,
                "frames": c.CLIP_FRAMES,
                "fps": c.CLIP_FPS,
                "width": c.CLIP_WIDTH,
                "height": c.CLIP_HEIGHT,
            },
            "media.video.v1",
        )
        regions = [o["region"] for o in overlays]
        entry["references"] = [
            self.reference(shot, start, which, meta, regions=regions)
            for which in (0, 1)
        ]
        tiles = np.concatenate(
            [_thumb(frames[i]) for i in (0, c.CLIP_FRAMES // 2, c.CLIP_FRAMES - 1)],
            axis=1,
        )
        jpeg = self.dec.encode(
            tiles[None],
            ["-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-pix_fmt", "yuvj444p"],
            "image2pipe",
        )
        self.last_sheet = jpeg
        entry["sheet"] = _publish(
            self.ctx,
            jpeg,
            "image/jpeg",
            {**meta, "role": "lora_sheet"},
            "media.image.v1",
        )
        entry["loss_masks"] = [dict(o) for o in overlays]
        return entry

    def reference(
        self,
        shot: stats.Shot,
        start: float,
        which: int,
        meta: dict[str, Any],
        *,
        regions: Sequence[Sequence[int]],
    ) -> dict[str, Any]:
        """A still of the same shot outside the window when the shot is long enough, else the window's edge.

        Static overlays are blanked in it: a reference conditions the model, so a logo in it would be copied.
        """
        seconds = c.CLIP_FRAMES / c.CLIP_FPS
        if which == 0:
            t = shot.start + 0.05 if start - shot.start >= REFERENCE_MARGIN_S else start
        else:
            t = (
                shot.end - 0.1
                if shot.end - (start + seconds) >= REFERENCE_MARGIN_S
                else start + seconds - 1 / c.CLIP_FPS
            )
        frame = self.dec.rgb(max(0.0, t), 1, decimate=False)
        if frame.shape[0] != 1:
            frame = self.dec.rgb(start, 1, decimate=False)
        if regions:
            frame = stats.fill_regions(frame[0], regions)[None]
        png = self.dec.encode(frame, ["-frames:v", "1", "-c:v", "png"], "image2pipe")
        return _publish(
            self.ctx,
            png,
            "image/png",
            {**meta, "role": "lora_reference", "index": which, "seconds": round(t, 3)},
            "media.image.v1",
        )


def _thumb(frame: np.ndarray) -> np.ndarray:
    ys = np.linspace(0, frame.shape[0] - 1, SHEET_H).astype(np.int64)
    xs = np.linspace(0, frame.shape[1] - 1, SHEET_W).astype(np.int64)
    return np.ascontiguousarray(frame[ys][:, xs])


class LoraClipsProvider(BaseProvider):
    """Source videos -> training clip candidates, reference stills, contact sheets and a dataset document."""

    provider_id = c.PROVIDER_CLIPS

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:  # noqa: ARG003 - provider contract
        """Declare the ports; nothing is decoded here."""
        return Description(
            provider_id=cls.provider_id,
            kind="lora.dataset",
            label="LoRA 訓練片段切割（依鏡頭切換，每鏡頭一段 22 格）",
            inputs=[
                Port(
                    "videos",
                    c.SOURCES_TYPE,
                    required=True,
                    transport="inline",
                    description="[{file: FileRef, source_id, label, role: train|heldout|eval_only}]",
                )
            ],
            outputs=[
                Port(
                    "dataset",
                    c.DATASET_TYPE,
                    required=True,
                    transport="file",
                    description="lora.dataset.v1：每段的影片、參考格、縮圖表與統計",
                )
            ],
            parameters_schema={
                "type": "object",
                "properties": PARAMS,
                "additionalProperties": False,
            },
            settings_schema=settings_schema(
                invoke_properties=PARAMS, device_kinds=("cpu",)
            ),
            default_settings={
                "load": {
                    "device": {
                        "kind": "cpu",
                        "id": "cpu",
                        "resource_group": "cpu-dataset",
                    }
                },
                "invoke": {},
                "recording": normalize_recording({"mode": "summary"}),
            },
        )

    def invoke(self, ctx: RunContext) -> None:
        """Cut every source and publish the dataset document."""
        params = _params(ctx)
        sources = _sources(ctx)
        try:
            codec = _clip_codec()
            infos, clips = [], []
            for i, source in enumerate(sources):
                with ctx.recorder.phase(f"source.{source['source_id']}"):
                    info, got = _SourceJob(ctx, source, params, codec).run(
                        i, len(sources)
                    )
                infos.append(info)
                clips.extend(got)
                ctx.recorder.log(
                    "info",
                    "來源切割完成",
                    source_id=source["source_id"],
                    windows=info["windows"],
                    kept=sum(1 for c in got if not c.get("rejected")),
                )
            silence = _silence(ctx)
        except MediaError as exc:
            raise media_failure(ctx, exc, what="LoRA clips") from exc
        doc = {
            "schema": c.DATASET_SCHEMA,
            "clip": {
                "frames": c.CLIP_FRAMES,
                "fps": c.CLIP_FPS,
                "width": c.CLIP_WIDTH,
                "height": c.CLIP_HEIGHT,
            },
            "parameters": params,
            "sources": infos,
            "clips": clips,
            "silence": silence,
            "counts": {
                "clips": len(clips),
                "kept": sum(1 for c in clips if not c.get("rejected")),
            },
        }
        out = ctx.new_file(
            "dataset", "application/json", {"clips": len(clips), "sources": len(infos)}
        )
        out.write(json.dumps(doc, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        ctx.set_file_output("dataset", out)


__all__ = ["LoraClipsProvider"]
