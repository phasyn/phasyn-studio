"""Encode painted Studio keyframes with optional project audio at their exact project rate."""

from __future__ import annotations

import shutil
from collections.abc import Mapping
from fractions import Fraction
from math import lcm
from pathlib import Path
from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.native_manifest import package_data, read_manifest
from phasyn_components.provider import BaseProvider, Description, Port

from ..errors import MediaError
from ..files import LocalFile, check_local_file, file_sha256, unchanged_since
from ..limits import DEFAULT_LIMITS
from ..probe import probe, run_ffprobe_json
from ..tools import input_url
from ._analysis_video import ffmpeg, publish, read_clock, workspace
from ._failure import media_failure
from .animatic_frames import SAMPLE_RATE, Animation, unpack


if TYPE_CHECKING:
    from phasyn_components.provider import RunContext


def _audio(ctx: RunContext, clip: Animation) -> LocalFile | None:
    item = ctx.optional_input("audio")
    track = clip.header["audio"]
    if item is None and track is None:
        return None
    if (
        item is None
        or item.file is None
        or track is None
        or track["sha256"] != item.file["sha256"]
    ):
        raise ComponentError(
            "INVALID_ARGUMENT",
            "The selected audio asset must match the frozen frame bundle.",
        )
    local = check_local_file(item.require_path("audio"))
    if file_sha256(local.path, cancel=ctx.cancel_token) != (
        item.file["sha256"],
        item.file["size_bytes"],
    ):
        raise ComponentError(
            "INTEGRITY_MISMATCH",
            "Project audio differs from its immutable file reference.",
        )
    info = probe(local.path, cancel=ctx.cancel_token)
    if info.audio_streams != 1 or info.video_streams:
        raise ComponentError(
            "INVALID_ARGUMENT", "Choose an audio asset with one playable audio stream."
        )
    if (
        info.duration_seconds is not None
        and track["start_sample"] >= info.duration_seconds * SAMPLE_RATE
    ):
        raise ComponentError(
            "INVALID_ARGUMENT", "The chosen audio offset is beyond the source."
        )
    return local


def _encode(
    ctx: RunContext, clip: Animation, audio: LocalFile | None, folder: Path
) -> Path:
    file = folder / "animatic.mp4"
    args = [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-filter_threads",
        "1",
        "-protocol_whitelist",
        "file",
        "-f",
        "image2",
        "-c:v",
        "png",
        "-threads",
        "1",
        "-framerate",
        f"{clip.fps.numerator}/{clip.fps.denominator}",
        "-start_number",
        "0",
        "-i",
        str(folder / "%06d.png"),
    ]
    marks = {str(folder): "<workspace>"}
    if audio:
        url = input_url(audio.path)
        marks[url] = "<audio>"
        args.extend(
            [
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                DEFAULT_LIMITS.format_whitelist,
                *DEFAULT_LIMITS.decoder_flags,
                "-i",
                url,
            ]
        )
        start = clip.header["audio"]["start_sample"]
        chain = (
            f"asetpts=PTS-STARTPTS,aresample={SAMPLE_RATE},atrim=start_sample={start}:end_sample={start + clip.samples},"
            f"asetpts=PTS-STARTPTS,apad=whole_len={clip.samples},atrim=end_sample={clip.samples}"
        )
        args.extend(
            [
                "-map",
                "1:a:0",
                "-af",
                chain,
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "2",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ]
        )
    args.extend(
        [
            "-map",
            "0:v:0",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-threads",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "passthrough",
            "-video_track_timescale",
            str(clip.fps.numerator),
            "-movie_timescale",
            str(lcm(clip.fps.numerator, SAMPLE_RATE)),
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            str(file),
        ]
    )
    ffmpeg(ctx, args, marks)
    return file


def _verify(
    ctx: RunContext, clip: Animation, path: Path, audio: LocalFile | None
) -> None:
    clock = read_clock(path, ctx)
    if (
        clock.first_pts != 0
        or clock.count != clip.count
        or any(clock.seconds(i) != i / clip.fps for i in range(clip.count + 1))
    ):
        raise ComponentError(
            "MEDIA_INCOMPLETE", "Rendered frame times differ from the project clock."
        )
    data = run_ffprobe_json(
        path,
        [
            "-show_streams",
            "-show_entries",
            "stream=codec_type,width,height,start_pts,duration_ts,time_base",
        ],
        limits=DEFAULT_LIMITS,
        cancel=ctx.cancel_token,
        timeout=ctx.remaining_seconds(),
    )
    videos = [s for s in data["streams"] if s["codec_type"] == "video"]
    sounds = [s for s in data["streams"] if s["codec_type"] == "audio"]
    if len(videos) != 1 or (videos[0]["width"], videos[0]["height"]) != (
        clip.header["width"],
        clip.header["height"],
    ):
        raise ComponentError(
            "MEDIA_INCOMPLETE",
            "The encoded animatic canvas differs from its frame bundle.",
        )
    if not audio and not sounds:
        return
    if (
        audio is None
        or len(sounds) != 1
        or sounds[0].get("start_pts") != 0
        or Fraction(sounds[0]["time_base"]) * int(sounds[0]["duration_ts"])
        != Fraction(clip.samples, SAMPLE_RATE)
        or not unchanged_since(audio)
    ):
        raise ComponentError(
            "MEDIA_INCOMPLETE",
            "The encoded audio does not cover the expected sample range.",
        )


class PrevisAnimaticProvider(BaseProvider):
    """Export one immutable playable animatic without editing a project's active timeline."""

    provider_id = "media.previs_animatic"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Expose the frame stream format and render result without loading media."""
        del settings
        raw = package_data("phasyn_media", f"{cls.provider_id}.json")
        if raw is None:
            raise ComponentError(
                "RUNTIME_ERROR", "Missing animatic capability manifest."
            )
        spec = read_manifest(raw, cls.provider_id, f"{cls.__module__}:{cls.__name__}")
        available = all(
            shutil.which(tool) is not None for tool in ("ffmpeg", "ffprobe")
        )
        return Description(
            provider_id=cls.provider_id,
            label=spec["label"],
            kind=spec["kind"],
            inputs=[Port(**p) for p in spec["inputs"]],
            outputs=[Port(**p) for p in spec["outputs"]],
            settings_schema=spec["settings_schema"],
            parameters_schema=spec["parameters_schema"],
            default_settings=spec["default_settings"],
            available=available,
            unavailable_reason=None
            if available
            else "FFmpeg and ffprobe are required.",
            unavailable_code=None if available else "RUNTIME_UNAVAILABLE",
            facts={
                "studio_animatic": {
                    "version": 1,
                    "frames": "frames",
                    "audio": "audio",
                    "asset": "asset",
                }
            },
        )

    def invoke(self, ctx: RunContext) -> None:
        """Render, verify exact frame/sample times, then atomically publish the output."""
        try:
            with workspace(ctx) as tmp:
                folder = Path(tmp)
                with ctx.recorder.phase("prepare"):
                    clip = unpack(ctx, folder)
                    audio = _audio(ctx, clip)
                with ctx.recorder.phase("encode"):
                    path = _encode(ctx, clip, audio, folder)
                    _verify(ctx, clip, path, audio)
                header = clip.header
                settings = {
                    key: header[key]
                    for key in (
                        "project_id",
                        "revision",
                        "shot_id",
                        "start",
                        "end",
                        "fps_num",
                        "fps_den",
                        "layer_sources",
                        "depth",
                        "audio",
                    )
                }
                settings.update(
                    frame_bundle=ctx.input("frames").file,
                    header_sha256=clip.scene_hash,
                    projection=header["scene"]["projection"],
                    audio_rate=SAMPLE_RATE if audio else None,
                    audio_samples=clip.samples if audio else 0,
                    audio_tail="pad_silence" if audio else None,
                )
                out = publish(
                    ctx, "video", "video/mp4", path, {"frame_count": clip.count}
                )
                asset = {
                    "asset_id": new_id(),
                    "kind": "final",
                    "file": ctx.file_ref(out),
                    "complete": True,
                    "source_latent": None,
                    "frame_count": clip.count,
                    "width": header["width"],
                    "height": header["height"],
                    "fps": {"num": clip.fps.numerator, "den": clip.fps.denominator},
                    "has_audio": audio is not None,
                    "actual_settings": {"animatic": settings},
                }
                contracts.validate("Asset", asset, code="RUNTIME_ERROR")
                ctx.set_output("asset", asset)
        except MediaError as exc:
            raise media_failure(ctx, exc, what="Animatic export") from exc
