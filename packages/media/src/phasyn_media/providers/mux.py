"""``media.mux``／``media.probe``：CPU 媒體元件.

mux 不用 ``-shortest`` 暗裁；時長／offset／encode／mux 都記錄。沒有音訊時不自動生成音訊
（不接 mux 步驟即可）。

probe 的 invoke 參數 ``scenes``（x-phasyn-extension）：設定時另以 FFmpeg scene 分數偵測鏡頭切換
（``phasyn_media.scenes``），輸出多 ``scene_cuts_seconds``／``scene_detection``（契約 ``MediaInfo``）；
沒有 scenes（或 null）時輸出與加入此參數之前完全相同。
"""

from __future__ import annotations

import shutil
import time
from collections.abc import Mapping
from fractions import Fraction
from pathlib import Path
from typing import Any

from phasyn_components.context import InputValue
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import (
    BaseProvider,
    Description,
    Port,
    RunContext,
    settings_schema,
)
from phasyn_components.settings import normalize_recording

from ..audio_conform import conform_audio
from ..errors import MediaError
from ..mux import mux
from ..probe import measured_frame_clock, probe, probe_source_timing
from ..scenes import detect_scene_cuts, parse_scene_detection
from ._failure import media_failure


_SHA256_HEX_LENGTH = 64


MUX_PARAMS: dict[str, dict[str, Any]] = {
    "audio_codec": {"enum": ["aac", "flac", "pcm_s16le"], "default": "aac"},
    "audio_bitrate": {
        "type": "integer",
        "minimum": 32000,
        "maximum": 1536000,
        "default": 192000,
    },
    "trim_to_seconds": {"type": ["number", "null"], "minimum": 0, "default": None},
    "audio_fit": {
        "enum": ["exact", "conform"],
        "default": "exact",
        "description": "exact\uff1d音訊必須已是與影片同長的 float32 雙聲道 WAV\uff1b"
        "conform\uff1d先把任何音檔（單聲道、其他取樣率、整數格式、TTS 輸出）轉成 48 kHz float32 雙聲道 WAV，"
        "並在結尾補靜音或裁掉，對齊影片長度（記錄在 mux.audio_fit）",
    },
}

# media.probe 的 scenes 參數（範圍與預設值=phasyn_media.scenes 的常數；形狀同契約 MediaSceneDetection，欄位可省略）
PROBE_PARAMS: dict[str, dict[str, Any]] = {
    "clip_origin": {
        "type": "boolean",
        "default": False,
        "description": "量測時間軸來源零點與容器零點的秒數差",
    },
    "frame_clock": {
        "type": "boolean",
        "default": False,
        "description": "解碼全部影格以核對固定幀率及來源雜湊",
    },
    "scenes": {
        "anyOf": [
            {
                "type": "object",
                "properties": {
                    "threshold": {
                        "type": "number",
                        "minimum": 0.05,
                        "maximum": 0.9,
                        "default": 0.3,
                        "description": "FFmpeg scene 分數門檻（0\u20131）；越低切換點越多",
                    },
                    "min_gap_seconds": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 10,
                        "default": 0.5,
                        "description": "相距小於此秒數的切換點只保留分數最高的一個",
                    },
                },
                "additionalProperties": False,
            },
            {"type": "null"},
        ],
        "default": None,
        "description": "鏡頭切換偵測（只適用影片）。null\uff1d不偵測；設定時輸出另含 scene_cuts_seconds"
        "（新鏡頭第一幀的秒數，以影片軌第一幀為 0，遞增且在 (0, 時長) 內）與 scene_detection（實際使用的參數）",
    },
}


class MuxProvider(BaseProvider):
    """``media.mux``. ETA work (``cost.stages``): ``mux`` in ``byte`` = size of the input video and audio files."""

    provider_id = "media.mux"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Return the input, output, and settings contract for this provider."""
        del settings  # The static port contract is independent of settings.
        return Description(
            provider_id=cls.provider_id,
            kind="media.mux",
            label="影音封裝（影片軌\uff0bWAV；驗證 AV 同步）",
            inputs=[
                Port(
                    "video",
                    "media.asset.v1",
                    required=True,
                    transport="inline",
                    description="解碼器輸出的完整影片 Asset",
                ),
                Port(
                    "audio",
                    "media.audio.v1",
                    required=True,
                    transport="file",
                    description="float32 stereo WAV",
                ),
            ],
            outputs=[
                Port(
                    "asset",
                    "media.asset.v1",
                    required=True,
                    transport="inline",
                    description="含音訊的 Asset（保留原 source_latent）",
                )
            ],
            settings_schema=settings_schema(
                invoke_properties=MUX_PARAMS, device_kinds=("cpu",)
            ),
            parameters_schema={
                "type": "object",
                "properties": MUX_PARAMS,
                "additionalProperties": False,
            },
            default_settings={
                "load": {
                    "device": {
                        "kind": "cpu",
                        "id": "cpu",
                        "resource_group": "cpu-media",
                    }
                },
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
        )

    def invoke(self, ctx: RunContext) -> None:
        """Process the submitted inputs and publish the resulting media."""
        params: dict[str, Any] = {
            k: v.get("default") for k, v in MUX_PARAMS.items()
        } | dict(ctx.parameters)
        asset = ctx.input("video").value
        if not isinstance(asset, Mapping) or not isinstance(asset.get("file"), Mapping):
            raise ComponentError(
                "INVALID_ARGUMENT", "video 需要 media.asset.v1（含 file）"
            )
        if not asset.get("complete"):
            raise ComponentError(
                "MEDIA_INCOMPLETE",
                "影片 Asset 尚未完整（complete=false），不封裝半成品",
            )
        fps_num, fps_den = _asset_fps(asset) or (24, 1)
        video_path = ctx.resolve_file(asset["file"])
        audio_path = ctx.input("audio").require_path("audio")
        out = ctx.new_file(
            None,
            "video/mp4",
            {"kind": asset.get("kind"), "muxed": True},
            type_id="media.video.v1",
        )
        tmp = Path(ctx.work_dir) / f"{out.file_id}.mp4"
        t0 = time.perf_counter_ns()
        fitted: dict[str, Any] | None = None
        try:
            if params["audio_fit"] == "conform":
                with ctx.recorder.phase("conform-audio"):
                    audio_path, fitted = _conform(ctx, asset, audio_path, out.file_id)
            with ctx.recorder.phase("encode"):
                result = mux(
                    video_track=video_path,
                    pcm=audio_path,
                    output=tmp,
                    audio_codec=str(params["audio_codec"]),
                    audio_bitrate=int(params["audio_bitrate"]),
                    fps_num=fps_num,
                    fps_den=fps_den,
                    trim_to_seconds=params.get("trim_to_seconds"),
                    cancel=ctx.cancel_token,
                    expected_source_frames=int(asset.get("frame_count") or 0) or None,
                )
        except MediaError as exc:
            raise media_failure(ctx, exc, what="媒體處理失敗") from exc
        info = result.as_dict()
        if fitted is not None:
            info["audio_fit"] = fitted
        wall_ms = (time.perf_counter_ns() - t0) / 1e6
        ctx.recorder.log("info", "mux 完成", wall_ms=wall_ms, result=info)
        read_bytes = video_path.stat().st_size + audio_path.stat().st_size
        ctx.recorder.record_cost(
            "mux",
            work=read_bytes,
            unit="byte",
            compute_ms=wall_ms,
            audio_codec=str(params["audio_codec"]),
        )
        if fitted is not None:
            audio_path.unlink(
                missing_ok=True
            )  # the conformed copy; the chosen file is untouched
        sha = str(info.get("sha256") or "")
        size = int(info.get("size_bytes") or tmp.stat().st_size)
        if len(sha) == _SHA256_HEX_LENGTH:
            out.adopt_file(tmp, sha256=sha, size=size)
        else:
            shutil.move(tmp, out.path)
            out.adopt_written()
        file_ref = {
            "node_id": str(ctx.recorder.node_id),
            "file_id": out.file_id,
            "size_bytes": out.size,
            "sha256": out.sha256,
            "media_type": "video/mp4",
            "metadata": out.metadata,
        }
        ctx.set_output(
            "asset",
            {
                "asset_id": new_id(),
                "kind": asset.get("kind", "final"),
                "file": file_ref,
                "source_latent": asset.get("source_latent"),
                "frame_count": int(
                    info.get("delivered_frames") or asset.get("frame_count") or 0
                ),
                "fps": asset.get("fps"),
                "width": int(asset.get("width") or 0),
                "height": int(asset.get("height") or 0),
                "complete": True,
                "has_audio": True,
                "actual_settings": {
                    **dict(asset.get("actual_settings") or {}),
                    "mux": {k: v for k, v in info.items() if k != "path"},
                },
            },
        )


def _asset_fps(asset: Mapping[str, Any]) -> tuple[int, int] | None:
    """The video Asset's frame rate as the contract's Rational ``{num, den}``; ``None`` when it is null or absent."""
    fps = asset.get("fps")
    if fps is None:
        return None
    if isinstance(fps, Mapping):
        num, den = fps.get("num"), fps.get("den")
        if (
            isinstance(num, int)
            and isinstance(den, int)
            and not isinstance(num, bool)
            and not isinstance(den, bool)
            and num >= 1
            and den >= 1
        ):
            return num, den
    raise ComponentError(
        "INVALID_ARGUMENT",
        "影片 Asset 的 fps 必須是 num、den 兩個正整數組成的分數（Rational）或 null",
        details={"field_path": "inputs.video.fps", "actual": repr(fps)[:80]},
    )


def _conform(
    ctx: RunContext, asset: Mapping[str, Any], audio: Path, name: str
) -> tuple[Path, dict[str, Any]]:
    """The chosen audio as float32 stereo WAV of the video's exact length (audio_fit = conform)."""
    fps = _asset_fps(asset)
    frames = int(asset.get("frame_count") or 0)
    if frames < 1 or fps is None:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "影片 Asset 缺少幀數或影格率，無法把聲軌對齊影片長度",
        )
    Path(ctx.work_dir).mkdir(parents=True, exist_ok=True)
    target = Path(ctx.work_dir) / f"{name}-soundtrack.wav"
    done = conform_audio(
        audio, target, frames=frames, fps=Fraction(*fps), cancel=ctx.cancel_token
    )
    return done.path, {"mode": "conform", **done.as_dict()}


def _probe_input(ctx: RunContext) -> InputValue:
    supplied = [
        value
        for name in ("media", "audio")
        if (value := ctx.optional_input(name)) is not None
    ]
    if len(supplied) != 1:
        raise ComponentError("INVALID_ARGUMENT", "請選擇一個影片或音訊來源")
    return supplied[0]


class ProbeProvider(BaseProvider):
    """Inspect the streams and format of a published media input."""

    provider_id = "media.probe"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Return the input, output, and settings contract for this provider."""
        del settings  # The static port contract is independent of settings.
        return Description(
            provider_id=cls.provider_id,
            kind="media.prepare",
            label="媒體探測（ffprobe：codec／幾何／fps／實際 frame 數；可選鏡頭切換偵測）",
            inputs=[
                Port(
                    "media",
                    "media.video.v1",
                    required=False,
                    transport="file",
                    description="影片檔",
                ),
                Port(
                    "audio",
                    "media.audio.v1",
                    required=False,
                    transport="file",
                    description="純音訊檔",
                ),
            ],
            outputs=[
                Port(
                    "info",
                    "media.probe.v1",
                    required=True,
                    transport="inline",
                    description="MediaInfo（帶 scenes 參數時另含 scene_cuts_seconds、scene_detection）",
                )
            ],
            settings_schema=settings_schema(
                invoke_properties=PROBE_PARAMS, device_kinds=("cpu",)
            ),
            parameters_schema={
                "type": "object",
                "properties": PROBE_PARAMS,
                "additionalProperties": False,
            },
            default_settings={
                "load": {
                    "device": {
                        "kind": "cpu",
                        "id": "cpu",
                        "resource_group": "cpu-media",
                    }
                },
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
        )

    def invoke(self, ctx: RunContext) -> None:
        """Process the submitted inputs and publish the resulting media."""
        try:  # 參數先驗證（422），不做任何探測
            detection = parse_scene_detection(ctx.parameters.get("scenes"))
        except MediaError as exc:
            raise ComponentError(
                "INVALID_ARGUMENT",
                exc.message,
                details={"field_paths": list(exc.field_paths)},
            ) from exc
        media = _probe_input(ctx)
        path = media.require_path("media")
        try:
            with ctx.recorder.span("ffprobe", part="media.probe"):
                info = probe(
                    path,
                    count_frames=ctx.parameters.get("clip_origin") is not True,
                    cancel=ctx.cancel_token,
                )
        except MediaError as exc:
            raise media_failure(ctx, exc, what="媒體處理失敗") from exc
        out = info.as_dict()
        if ctx.parameters.get("clip_origin") is True:
            try:
                timing = probe_source_timing(path, cancel=ctx.cancel_token)
                offset = timing.origin_seconds - timing.container_start
                out["clip_origin_offset"] = {
                    "num": offset.numerator,
                    "den": offset.denominator,
                }
            except MediaError as exc:
                raise media_failure(ctx, exc, what="來源時間原點量測失敗") from exc
        if ctx.parameters.get("frame_clock") is True:
            try:
                with ctx.recorder.span("frame_clock", part="media.probe"):
                    out["frame_clock"] = measured_frame_clock(
                        path,
                        media.file or {},
                        cancel=ctx.cancel_token,
                        timeout=max(1.0, ctx.remaining_seconds()),
                    )
            except MediaError as exc:
                raise media_failure(ctx, exc, what="影格時鐘核對失敗") from exc
        if detection is not None:
            if info.kind != "video" or not info.duration_seconds:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    f"鏡頭切換偵測只適用有時長的影片（這個檔案是 {info.kind}）",
                    details={"field_paths": ["parameters.scenes"], "kind": info.kind},
                )
            try:
                with ctx.recorder.span("scene_detect", part="media.probe"):
                    result = detect_scene_cuts(
                        path,
                        detection,
                        duration_seconds=float(info.duration_seconds),
                        cancel=ctx.cancel_token,
                        timeout=max(1.0, ctx.remaining_seconds()),
                    )
            except MediaError as exc:
                raise media_failure(ctx, exc, what="媒體處理失敗") from exc
            out.update(result.fields())
            ctx.recorder.log(
                "info",
                "鏡頭切換偵測完成",
                **detection.as_dict(),
                candidates=result.candidates,
                cuts=len(result.cuts_seconds),
                untimed_frames=result.untimed_frames,
                wall_ms=round(result.elapsed_seconds * 1000, 3),
            )
        ctx.set_output("info", out)


__all__ = ["MuxProvider", "ProbeProvider"]
