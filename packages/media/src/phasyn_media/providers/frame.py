"""``media.frame``：從影片取出一個實際解碼的影格存成 PNG（Studio 鏡頭連續性；x-phasyn-extension）。

- ``position``：first＝第 0 幀；last＝最後一個「可解碼」的影格；index＝``frame_index``（0 起，呈現順序）。
- 先以 ffprobe ``-count_frames`` 實際解碼計數（不採用容器標頭的 nb_frames，也不用時長×fps 估算），再以
  select filter（``n`` 同為解碼器輸出的呈現順序）取出該序號；取不到影格直接失敗，不以相鄰影格代替。
- 輸出原始解析度的 PNG（無損壓縮、RGB 8-bit）。YUV→RGB 依來源標記的 color matrix／range（FFmpeg 預設），
  不縮放、不裁切、不改 fps；旋轉標記依 FFmpeg 預設自動套用（與播放器看到的方向一致）並記錄在 metadata。
"""

from __future__ import annotations

import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.provider import BaseProvider, Description, Port, RunContext, settings_schema
from phasyn_components.settings import normalize_recording

from ..errors import MediaError
from ..limits import DEFAULT_LIMITS
from ..probe import probe, run_ffprobe_json
from ..tools import find_ffmpeg, input_url, redact, run_tool, summarize_stderr
from ._failure import media_failure

POSITIONS = ("first", "last", "index")
PARAMS: dict[str, dict[str, Any]] = {
    "position": {
        "enum": list(POSITIONS),
        "default": "last",
        "description": "first＝第 0 幀；last＝最後一個可解碼的影格；index＝frame_index",
    },
    "frame_index": {
        "type": ["integer", "null"],
        "minimum": 0,
        "maximum": 100000,
        "default": None,
        "description": "position=index 時要取的影格序號（0 起，呈現順序）；其他 position 必須留空",
    },
}
OUTPUT_PIX_FMT = "rgb24"


def resolve_index(position: Any, frame_index: Any, decoded_frames: int) -> int:
    """依 position 與實際可解碼的影格數決定要取的序號（純函式）；不合法的組合回 INVALID_ARGUMENT。"""
    if position not in POSITIONS:
        raise ComponentError("INVALID_ARGUMENT", f"position 必須是 {'、'.join(POSITIONS)}")
    if decoded_frames <= 0:
        raise ComponentError("MEDIA_INCOMPLETE", "影片沒有任何可解碼的影格")
    if position != "index":
        if frame_index is not None:
            raise ComponentError("INVALID_ARGUMENT", "frame_index 只在 position=index 時使用（不默默忽略）")
        return 0 if position == "first" else decoded_frames - 1
    if isinstance(frame_index, bool) or not isinstance(frame_index, int):
        raise ComponentError("INVALID_ARGUMENT", "position=index 需要 frame_index（整數，0 起）")
    if not 0 <= frame_index < decoded_frames:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"frame_index {frame_index} 超出範圍：影片共有 {decoded_frames} 個可解碼影格（0–{decoded_frames - 1}）",
            details={"frame_index": frame_index, "decoded_frames": decoded_frames},
        )
    return frame_index


def _source(ctx: RunContext) -> tuple[dict[str, Any], Path, str | None]:
    """恰好一個來源：``video``（media.asset.v1）或 ``video_file``（media.video.v1）。回傳 (FileRef, 本機路徑, asset_id)。"""
    asset_item = ctx.optional_input("video")
    file_item = ctx.optional_input("video_file")
    if (asset_item is None) == (file_item is None):
        raise ComponentError("INVALID_ARGUMENT", "video（media.asset.v1）與 video_file（media.video.v1）需要恰好接一個")
    if asset_item is not None:
        asset = asset_item.value
        if not isinstance(asset, Mapping) or not isinstance(asset.get("file"), Mapping):
            raise ComponentError("INVALID_ARGUMENT", "video 需要 media.asset.v1（含 file）")
        if not asset.get("complete"):
            raise ComponentError("MEDIA_INCOMPLETE", "影片 Asset 尚未完整（complete=false），不從半成品取影格")
        ref = dict(asset["file"])
        asset_id = asset.get("asset_id")
        return ref, ctx.resolve_file(ref), str(asset_id) if asset_id else None
    assert file_item is not None
    if file_item.file is None:
        raise ComponentError("INVALID_ARGUMENT", "video_file 需要 FileRef")
    return dict(file_item.file), file_item.require_path("video_file"), None


class FrameProvider(BaseProvider):
    provider_id = "media.frame"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        return Description(
            provider_id=cls.provider_id,
            kind="media.frame",
            label="取出影格（first／last／index；原解析度 PNG）",
            inputs=[
                Port(
                    "video",
                    "media.asset.v1",
                    False,
                    "inline",
                    "完整影片 Asset（例如上一個鏡頭的 take）；與 video_file 二擇一",
                ),
                Port("video_file", "media.video.v1", False, "file", "影片檔；與 video 二擇一"),
            ],
            outputs=[
                Port(
                    "image",
                    "media.image.v1",
                    True,
                    "file",
                    "PNG（RGB 8-bit、原解析度）；metadata 記錄來源檔、frame_index 與尺寸",
                )
            ],
            settings_schema=settings_schema(invoke_properties=PARAMS, device_kinds=("cpu",)),
            parameters_schema={"type": "object", "properties": PARAMS, "additionalProperties": False},
            default_settings={
                "load": {"device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu-frame"}},
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
        )

    def invoke(self, ctx: RunContext) -> None:

        params: dict[str, Any] = {k: v.get("default") for k, v in PARAMS.items()} | dict(ctx.parameters)
        position = params.get("position")
        if position not in POSITIONS:
            raise ComponentError("INVALID_ARGUMENT", f"position 必須是 {'、'.join(POSITIONS)}")
        rec = ctx.recorder
        limits = DEFAULT_LIMITS
        with rec.phase("input"):
            ref, path, asset_id = _source(ctx)
            try:
                info = probe(path, count_frames=False, cancel=ctx.cancel_token)
            except MediaError as exc:
                raise media_failure(ctx, exc, what="影片探測失敗") from exc
            if info.kind != "video":
                raise ComponentError("INVALID_ARGUMENT", f"來源不是影片（{info.kind}）")
        with rec.phase("count"):
            try:
                doc = run_ffprobe_json(
                    path,
                    ["-count_frames", "-select_streams", "V:0", "-show_entries", "stream=nb_read_frames"],
                    limits=limits,
                    cancel=ctx.cancel_token,
                    timeout=max(1.0, min(ctx.remaining_seconds(), limits.process_timeout_seconds)),
                )
            except MediaError as exc:
                raise media_failure(ctx, exc, what="解碼計數失敗") from exc
            streams = doc.get("streams") or []
            raw = streams[0].get("nb_read_frames") if streams and isinstance(streams[0], Mapping) else None
            decoded = int(raw) if isinstance(raw, str | int) and str(raw).isdigit() else 0
        index = resolve_index(position, params.get("frame_index"), decoded)
        rec.set_metric(
            "input_frame_count", decoded, unit="count", scope="component_call", method="ffprobe_count_frames"
        )
        out = ctx.new_file("image", "image/png", {"role": "extracted_frame"})
        tmp = Path(ctx.work_dir) / f"{out.file_id}.frame.png"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        argv = [
            find_ffmpeg(), "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
            "-protocol_whitelist", "file", "-format_whitelist", limits.format_whitelist, *limits.decoder_flags,
            "-i", input_url(path),
            "-map", "0:V:0", "-vf", f"select=eq(n\\,{index})", "-fps_mode", "passthrough",
            "-frames:v", "1", "-update", "1", "-c:v", "png", "-pix_fmt", OUTPUT_PIX_FMT,
            "-f", "image2", "-n", input_url(tmp),
        ]  # fmt: skip
        marks = {str(path): "<video>", input_url(path): "<video>", str(tmp): "<output>", input_url(tmp): "<output>"}
        try:
            with rec.phase("extract"):
                result = run_tool(
                    argv,
                    timeout=max(1.0, min(ctx.remaining_seconds(), limits.process_timeout_seconds)),
                    cancel=ctx.cancel_token,
                    max_stdout_bytes=1 << 20,
                    max_stderr_bytes=limits.max_stderr_bytes,
                    what="FFmpeg 取影格",
                )
            if result.returncode != 0:
                detail = summarize_stderr(redact(result.stderr, marks), 800)
                raise ComponentError("MEDIA_TOOL_FAILED", "FFmpeg 取影格失敗" + (f"：{detail}" if detail else ""))
            if not tmp.is_file() or tmp.stat().st_size == 0:
                raise ComponentError(
                    "MEDIA_INCOMPLETE",
                    f"解碼時沒有取到第 {index} 幀（計數 {decoded} 幀）；不以相鄰影格代替",
                    details={"frame_index": index, "decoded_frames": decoded},
                )
            with rec.phase("verify"):
                image = probe(tmp, cancel=ctx.cancel_token)
            if image.kind != "image" or not image.width or not image.height:
                raise ComponentError("MEDIA_TOOL_FAILED", f"輸出不是可辨識的影像（{image.kind}）")
        except MediaError as exc:
            tmp.unlink(missing_ok=True)
            raise media_failure(ctx, exc, what="取影格失敗") from exc
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        source_pix_fmt = info.pixel_format
        if source_pix_fmt and any(depth in source_pix_fmt for depth in ("10", "12", "14", "16")):
            rec.note(f"來源像素格式 {source_pix_fmt} 超過 8-bit；PNG 以 {OUTPUT_PIX_FMT}（8-bit）輸出")
        shutil.move(tmp, out.path)
        out.adopt_written()
        out.metadata.update(
            {
                "source_node_id": ref.get("node_id"),
                "source_file_id": ref.get("file_id"),
                "source_sha256": ref.get("sha256"),
                "source_asset_id": asset_id,
                "position": position,
                "frame_index": index,
                "source_frame_count": decoded,
                "width": int(image.width),
                "height": int(image.height),
                "pixel_format": OUTPUT_PIX_FMT,
                "source_pixel_format": source_pix_fmt,
                "source_color": {
                    "primaries": info.color_primaries,
                    "transfer": info.color_transfer,
                    "space": info.color_space,
                    "range": info.color_range,
                },
                "source_rotation_degrees": info.rotation_degrees,
            }
        )
        ctx.set_file_output("image", out)
        rec.set_metric("output_frame_count", 1, unit="count", scope="component_call", method="ffprobe_image")
        rec.log(
            "info",
            "已取出影格",
            position=position,
            frame_index=index,
            decoded_frames=decoded,
            width=image.width,
            height=image.height,
        )


__all__ = ["POSITIONS", "FrameProvider", "resolve_index"]
