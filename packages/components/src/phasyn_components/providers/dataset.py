"""``dataset.export``：影片＋caption 配對匯出成實體資料集。

外部 FileRef 先物化進匯出包（不只送本機不可讀路徑）；split 以來源影片群組分配，避免同源
相鄰 clip 跨 train／validation；使用者可明確指定 split；空 split 或樣本少只警告、不阻擋。
"""

from __future__ import annotations

import hashlib
import io
import json
import time
import zipfile
from collections.abc import Mapping
from typing import Any

from .. import SCHEMA_VERSION
from ..errors import ComponentError
from ..ids import is_local_id
from ..provider import BaseProvider, Description, OutputFile, Port, RunContext, settings_schema
from ..settings import normalize_recording

PARAMS: dict[str, dict[str, Any]] = {
    "validation_ratio": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.1},
    "test_ratio": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.0},
    "seed": {"type": "integer", "minimum": 0, "default": 0},
    "min_split_warning": {"type": "integer", "minimum": 0, "default": 2},
}
EXTENSIONS = {"video/mp4": ".mp4", "video/x-matroska": ".mkv", "video/webm": ".webm", "video/quicktime": ".mov"}


class _Sink(io.RawIOBase):
    """把 zipfile 的輸出串流寫進 OutputFile（不可 seek；邊寫邊算 SHA-256）。"""

    def __init__(self, out: OutputFile) -> None:
        self._out = out
        self._pos = 0

    def writable(self) -> bool:
        return True

    def write(self, b: Any) -> int:
        data = bytes(b)
        self._out.write(data)
        self._pos += len(data)
        return len(data)

    def tell(self) -> int:
        return self._pos


def assign_split(group: str, *, seed: int, validation_ratio: float, test_ratio: float) -> str:
    h = hashlib.sha256(f"{seed}:{group}".encode()).digest()
    u = int.from_bytes(h[:8], "big") / 2**64
    if u < test_ratio:
        return "test"
    if u < test_ratio + validation_ratio:
        return "validation"
    return "train"


def _caption_text(value: Any) -> str:
    if isinstance(value, Mapping):
        return str(value.get("training_caption") or "")
    return str(value or "")


def _rows_of(value: Any) -> list[Any]:
    """輸入可為陣列，或 ``{schema_version, format, rows|items}`` 文件（工作台送出的形式）。"""
    if isinstance(value, Mapping):
        fmt = value.get("format", "video_text_pairs")
        if fmt != "video_text_pairs":
            raise ComponentError("INVALID_ARGUMENT", f"不支援的資料集格式：{fmt}")
        value = value.get("rows", value.get("items"))
    if not isinstance(value, list) or not value:
        raise ComponentError("INVALID_ARGUMENT", "items 必須是非空陣列")
    return value


class DatasetExportProvider(BaseProvider):
    provider_id = "dataset.export"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        return Description(
            provider_id=cls.provider_id,
            kind="dataset.export",
            label="訓練資料匯出（影片＋觀測 caption＋來源對映）",
            inputs=[
                Port(
                    "items",
                    "dataset.items.v1",
                    True,
                    "inline",
                    "[{video|source: FileRef, caption: string|CaptionPair, source_group?, split?（null＝自動）, sample_id?}]"
                    " 或 {schema_version, format: video_text_pairs, rows: [...]}",
                )
            ],
            outputs=[
                Port("manifest", "dataset.manifest.v1", True, "file", "DatasetManifest JSON"),
                Port(
                    "archive",
                    "dataset.archive.v1",
                    True,
                    "file",
                    "zip：videos/、captions/、manifest.jsonl、dataset_manifest.json",
                ),
            ],
            settings_schema=settings_schema(invoke_properties=PARAMS, device_kinds=("cpu",)),
            parameters_schema={"type": "object", "properties": PARAMS, "additionalProperties": False},
            default_settings={
                "load": {"device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu-dataset"}},
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
        )

    def invoke(self, ctx: RunContext) -> None:
        params: dict[str, Any] = {k: v.get("default") for k, v in PARAMS.items()} | dict(ctx.parameters)
        rows = _rows_of(ctx.input("items").value)
        rec = ctx.recorder
        notes: list[str] = []
        items: list[dict[str, Any]] = []
        used_ids: set[str] = set()
        for index, row in enumerate(rows):
            source = (row.get("video") or row.get("source")) if isinstance(row, Mapping) else None
            if not isinstance(source, Mapping):
                raise ComponentError("INVALID_ARGUMENT", f"items[{index}] 需要 video（或 source）FileRef")
            caption = _caption_text(row.get("caption")).strip()
            if not caption:
                raise ComponentError("INVALID_ARGUMENT", f"items[{index}] 的 caption 為空（資料錯誤）")
            video = dict(source)
            group = str(row.get("source_group") or video.get("sha256") or video.get("file_id"))
            sample_id = str(row.get("sample_id") or f"s{index:05d}")
            if not is_local_id(sample_id) or sample_id in used_ids:
                raise ComponentError("INVALID_ARGUMENT", f"items[{index}] 的 sample_id 不合法或重複：{sample_id}")
            used_ids.add(sample_id)
            split = row.get("split") or assign_split(
                group,
                seed=int(params["seed"]),
                validation_ratio=float(params["validation_ratio"]),
                test_ratio=float(params["test_ratio"]),
            )
            if split not in ("train", "validation", "test"):
                raise ComponentError("INVALID_ARGUMENT", f"items[{index}] 的 split 不合法：{split}")
            items.append(
                {
                    "sample_id": sample_id,
                    "video": video,
                    "caption": caption,
                    "source_group": group,
                    "split": split,
                    "explicit_split": bool(row.get("split")),
                }
            )
        groups: dict[str, set[str]] = {}
        for item in items:
            groups.setdefault(item["source_group"], set()).add(item["split"])
        for group, splits in groups.items():
            if len(splits) > 1:
                notes.append(
                    f"來源群組 {group[:16]} 被明確指定到多個 split：{sorted(splits)}（使用者指定，照辦但有洩漏風險）"
                )
        counts = {s: sum(1 for i in items if i["split"] == s) for s in ("train", "validation", "test")}
        for split, n in counts.items():
            if split == "test" and float(params["test_ratio"]) == 0 and n == 0:
                continue
            if n < int(params["min_split_warning"]):
                notes.append(f"split {split} 只有 {n} 筆（只警告，不阻擋匯出）")

        archive = ctx.new_file("archive", "application/zip", {"format": "video_text_pairs", "items": len(items)})
        manifest_items: list[dict[str, Any]] = []
        sink = _Sink(archive)
        with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
            for item in items:
                ctx.check_cancelled()
                t0 = time.perf_counter_ns()
                path = ctx.resolve_file(item["video"])
                ext = EXTENSIONS.get(str(item["video"].get("media_type")), ".bin")
                video_rel = f"videos/{item['sample_id']}{ext}"
                caption_rel = f"captions/{item['sample_id']}.txt"
                size = 0
                with open(path, "rb") as src, zf.open(video_rel, "w", force_zip64=True) as dst:
                    while chunk := src.read(8 * 1024 * 1024):
                        dst.write(chunk)
                        size += len(chunk)
                rec.transfer(
                    "disk_read",
                    direction="DISK_IN",
                    submitted_bytes=size,
                    host_ms=(time.perf_counter_ns() - t0) / 1e6,
                    byte_basis="logical_file",
                    owner="consumer",
                    src=f"file:{item['video'].get('file_id')}",
                    dst="dataset.zip",
                    src_memory_kind="disk",
                    dst_memory_kind="disk",
                )
                zf.writestr(caption_rel, item["caption"] + "\n")
                manifest_items.append(
                    {
                        "sample_id": item["sample_id"],
                        "relative_video_path": video_rel,
                        "relative_caption_path": caption_rel,
                        "source": item["video"],
                        "source_group": item["source_group"],
                        "split": item["split"],
                        "caption": item["caption"],
                    }
                )
            manifest = {
                "schema_version": SCHEMA_VERSION,
                "format": "video_text_pairs",
                "items": manifest_items,
                "notes": notes,
            }
            zf.writestr("manifest.jsonl", "".join(json.dumps(i, ensure_ascii=False) + "\n" for i in manifest_items))
            zf.writestr("dataset_manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        ctx.set_file_output("archive", archive)
        manifest_file = ctx.new_file("manifest", "application/json", {"items": len(items), "splits": counts})
        manifest_file.write(json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
        ctx.set_file_output("manifest", manifest_file)
        for note in notes:
            rec.log("warning", note)
        rec.set_metric("dataset.items", len(items), unit="count", scope="component_call", method="runtime_hook")


__all__ = ["DatasetExportProvider", "assign_split"]
