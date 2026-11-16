"""``media.mux``／``media.probe``：CPU 媒體元件。

mux 不用 ``-shortest`` 暗裁；時長／offset／encode／mux 都記錄。沒有音訊時不自動生成音訊
（不接 mux 步驟即可）。

probe 的 invoke 參數 ``scenes``（x-phasyn-extension）：設定時另以 FFmpeg scene 分數偵測鏡頭切換
（``phasyn_media.scenes``），輸出多 ``scene_cuts_seconds``／``scene_detection``（契約 ``MediaInfo``）；
沒有 scenes（或 null）時輸出與加入此參數之前完全相同。
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import BaseProvider, Description, Port, RunContext, settings_schema
from phasyn_components.settings import normalize_recording

from ..errors import MediaError
from ..mux import mux
from ..probe import probe
from ..scenes import detect_scene_cuts, parse_scene_detection
from ._failure import media_failure

MUX_PARAMS: dict[str, dict[str, Any]] = {
    "audio_codec": {"enum": ["aac", "flac", "pcm_s16le"], "default": "aac"},
    "audio_bitrate": {"type": "integer", "minimum": 32000, "maximum": 1536000, "default": 192000},
    "trim_to_seconds": {"type": ["number", "null"], "minimum": 0, "default": None},
}

# media.probe 的 scenes 參數（範圍與預設值＝phasyn_media.scenes 的常數；形狀同契約 MediaSceneDetection，欄位可省略）
PROBE_PARAMS: dict[str, dict[str, Any]] = {
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
                        "description": "FFmpeg scene 分數門檻（0–1）；越低切換點越多",
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
        "description": "鏡頭切換偵測（只適用影片）。null＝不偵測；設定時輸出另含 scene_cuts_seconds"
        "（新鏡頭第一幀的秒數，以影片軌第一幀為 0，遞增且在 (0, 時長) 內）與 scene_detection（實際使用的參數）",
    }
}


class MuxProvider(BaseProvider):
    """``media.mux``. ETA work (``cost.stages``): ``mux`` in ``byte`` = size of the input video and audio files."""

    provider_id = "media.mux"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        return Description(
            provider_id=cls.provider_id,
            kind="media.mux",
            label="影音封裝（影片軌＋WAV；驗證 AV 同步）",
            inputs=[
                Port("video", "media.asset.v1", True, "inline", "解碼器輸出的完整影片 Asset"),
                Port("audio", "media.audio.v1", True, "file", "float32 stereo WAV"),
            ],
            outputs=[Port("asset", "media.asset.v1", True, "inline", "含音訊的 Asset（保留原 source_latent）")],
            settings_schema=settings_schema(invoke_properties=MUX_PARAMS, device_kinds=("cpu",)),
            parameters_schema={"type": "object", "properties": MUX_PARAMS, "additionalProperties": False},
            default_settings={
                "load": {"device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu-media"}},
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
        )

    def invoke(self, ctx: RunContext) -> None:

        params: dict[str, Any] = {k: v.get("default") for k, v in MUX_PARAMS.items()} | dict(ctx.parameters)
        asset = ctx.input("video").value
        if not isinstance(asset, Mapping) or not isinstance(asset.get("file"), Mapping):
            raise ComponentError("INVALID_ARGUMENT", "video 需要 media.asset.v1（含 file）")
        if not asset.get("complete"):
            raise ComponentError("MEDIA_INCOMPLETE", "影片 Asset 尚未完整（complete=false），不封裝半成品")
        fps = asset.get("fps") or {}
        video_path = ctx.resolve_file(asset["file"])
        audio_path = ctx.input("audio").require_path("audio")
        out = ctx.new_file(None, "video/mp4", {"kind": asset.get("kind"), "muxed": True}, type_id="media.video.v1")
        tmp = Path(ctx.work_dir) / f"{out.file_id}.mp4"
        t0 = time.perf_counter_ns()
        try:
            with ctx.recorder.phase("encode"):
                result = mux(
                    video_track=video_path,
                    pcm=audio_path,
                    output=tmp,
                    audio_codec=str(params["audio_codec"]),
                    audio_bitrate=int(params["audio_bitrate"]),
                    fps_num=int(fps.get("num") or 24),
                    fps_den=int(fps.get("den") or 1),
                    trim_to_seconds=params.get("trim_to_seconds"),
                    cancel=ctx.cancel_token,
                    expected_source_frames=int(asset.get("frame_count") or 0) or None,
                )
        except MediaError as exc:
            raise media_failure(ctx, exc, what="媒體處理失敗") from exc
        info = result.as_dict()
        wall_ms = (time.perf_counter_ns() - t0) / 1e6
        ctx.recorder.log("info", "mux 完成", wall_ms=wall_ms, result=info)
        read_bytes = video_path.stat().st_size + audio_path.stat().st_size
        ctx.recorder.record_cost(
            "mux", work=read_bytes, unit="byte", compute_ms=wall_ms, audio_codec=str(params["audio_codec"])
        )
        sha = str(info.get("sha256") or "")
        size = int(info.get("size_bytes") or tmp.stat().st_size)
        if len(sha) == 64:
            out.adopt_file(tmp, sha256=sha, size=size)
        else:
            import shutil

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
                "frame_count": int(info.get("delivered_frames") or asset.get("frame_count") or 0),
                "fps": asset.get("fps"),
                "width": int(asset.get("width") or 0),
                "height": int(asset.get("height") or 0),
                "complete": True,
                "actual_settings": {
                    **dict(asset.get("actual_settings") or {}),
                    "mux": {k: v for k, v in info.items() if k != "path"},
                },
            },
        )


class ProbeProvider(BaseProvider):
    provider_id = "media.probe"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        return Description(
            provider_id=cls.provider_id,
            kind="media.prepare",
            label="媒體探測（ffprobe：codec／幾何／fps／實際 frame 數；可選鏡頭切換偵測）",
            inputs=[Port("media", "media.video.v1", True, "file", "影片檔")],
            outputs=[
                Port(
                    "info",
                    "media.probe.v1",
                    True,
                    "inline",
                    "MediaInfo（帶 scenes 參數時另含 scene_cuts_seconds、scene_detection）",
                )
            ],
            settings_schema=settings_schema(invoke_properties=PROBE_PARAMS, device_kinds=("cpu",)),
            parameters_schema={"type": "object", "properties": PROBE_PARAMS, "additionalProperties": False},
            default_settings={
                "load": {"device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu-media"}},
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
        )

    def invoke(self, ctx: RunContext) -> None:

        try:  # 參數先驗證（422），不做任何探測
            detection = parse_scene_detection(ctx.parameters.get("scenes"))
        except MediaError as exc:
            raise ComponentError(
                "INVALID_ARGUMENT", exc.message, details={"field_paths": list(exc.field_paths)}
            ) from exc
        path = ctx.input("media").require_path("media")
        try:
            with ctx.recorder.span("ffprobe", part="media.probe"):
                info = probe(path, cancel=ctx.cancel_token)
        except MediaError as exc:
            raise media_failure(ctx, exc, what="媒體處理失敗") from exc
        out = info.as_dict()
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
