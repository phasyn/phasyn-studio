"""Read the still-image subset of art.exchange-manifest.v1 and submit revisions."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import struct
import zipfile
from contextlib import closing
from http.client import HTTPConnection, HTTPException
from pathlib import Path
from typing import Any
from uuid import UUID

MAX_MANIFEST = 128 * 1024
MAX_BYTES = 128 * 1024**2
MAX_PIXELS = 4096**2
ROLES = ("source", "mask", "depth", "pose")
KIND = "art.exchange-manifest.v1"


def plates(manifest: bytes) -> dict[str, Any]:
    """Check all fields that control image decoding, allocation or member selection."""
    if not 0 < len(manifest) <= MAX_MANIFEST:
        raise ValueError("工作包的 manifest 大小無效。")
    data = json.loads(manifest)
    if not isinstance(data, dict) or data.get("type") != KIND or data.get("schema_version") != "1.0":
        raise ValueError("請選擇 Studio 匯出的美術工作包。")
    media = data.get("media")
    if not isinstance(media, dict) or "source" not in media or not media.keys() <= set(ROLES):
        raise ValueError("工作包的素材角色無效。")
    size = None
    for role in ROLES:
        if role not in media:
            continue
        plate = media[role]
        if not isinstance(plate, dict) or plate.get("kind") != "image" or plate.get("role") != role:
            raise ValueError("Krita 工作包限靜態影格，請先在 Studio 擷取需要的影格。")
        w, h = plate.get("width"), plate.get("height")
        if not all(type(v) is int and 0 < v <= 8192 for v in (w, h)) or w * h > MAX_PIXELS:
            raise ValueError("畫布超過插件可編輯的範圍。")
        if size is None:
            size = (w, h)
        if (
            size != (w, h)
            or plate.get("rotation_degrees") != 0
            or plate.get("sample_aspect_ratio")
            not in (
                None,
                "1:1",
                "1/1",
            )
        ):
            raise ValueError("請使用尺寸一致、無旋轉、中性像素比例的素材。")
        if type(plate.get("alpha_channel")) is not bool:
            raise ValueError("素材缺少 alpha 通道宣告。")
        ext = {"image/png": "png", "image/jpeg": "jpg"}.get(plate.get("media_type"))
        if ext is None or plate.get("member") != f"media/{role}.{ext}":
            raise ValueError("僅支援工作包內的 PNG 與 JPEG 圖層。")
        ref = plate.get("file")
        if (
            not isinstance(ref, dict)
            or not isinstance(ref.get("sha256"), str)
            or not re.fullmatch("[0-9a-f]{64}", ref["sha256"])
        ):
            raise ValueError("工作包缺少素材內容摘要。")
        n = ref.get("size_bytes")
        if type(n) is not int or not 0 < n <= MAX_BYTES:
            raise ValueError("素材大小超出上限。")
    return media


def read_bundle(path: Path) -> tuple[bytes, dict[str, bytes]]:
    """Read named stored members into memory without extracting paths from a ZIP."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags), "rb") as source:
        meta = os.fstat(source.fileno())
        if not stat.S_ISREG(meta.st_mode) or not 22 <= meta.st_size <= MAX_BYTES:
            raise ValueError("請選擇 128 MiB 以內的工作包。")
        # The producer writes one disk, no ZIP comment and at most six entries. Bound
        # the actual central directory before ZipFile allocates entries from it.
        source.seek(-22, os.SEEK_END)
        signature, disk, directory_disk, disk_count, count, length, offset, comment = struct.unpack(
            "<4s4H2IH", source.read(22)
        )
        if (
            signature != b"PK\x05\x06"
            or disk
            or directory_disk
            or comment
            or disk_count != count
            or not 3 <= count <= len(ROLES) + 2
            or length > 4096
            or offset + length + 22 != meta.st_size
        ):
            raise ValueError("請選擇 Studio 直接產生的美術 ZIP。")
        with zipfile.ZipFile(source) as archive:
            return _read_members(archive)


def _read_members(archive: zipfile.ZipFile) -> tuple[bytes, dict[str, bytes]]:
    entries = archive.infolist()
    if len(entries) > len(ROLES) + 2 or len({entry.filename for entry in entries}) != len(entries):
        raise ValueError("工作包含重複或過多的項目。")

    def member(name: str, limit: int) -> bytes:
        entry = archive.getinfo(name)
        file_type = stat.S_IFMT(entry.external_attr >> 16)
        if (
            entry.compress_type != zipfile.ZIP_STORED
            or entry.flag_bits & 1
            or file_type not in (0, stat.S_IFREG)
            or not 0 < entry.file_size <= limit
        ):
            raise ValueError("工作包項目的類型或大小無效。")
        return archive.read(entry)

    manifest = member("manifest.json", MAX_MANIFEST)
    media = plates(manifest)
    if set(archive.namelist()) != {"manifest.json", "reference.png", *(p["member"] for p in media.values())}:
        raise ValueError("工作包項目與 manifest 不一致。")
    images = {}
    for role, plate in media.items():
        ref = plate["file"]
        blob = member(plate["member"], ref["size_bytes"])
        if len(blob) != ref["size_bytes"] or hashlib.sha256(blob).hexdigest() != ref["sha256"]:
            raise ValueError(f"{role} 素材與工作包內容摘要不符。")
        images[role] = blob
    return manifest, images


def _call(
    port: int,
    path: str,
    body: bytes | None = None,
    *,
    content: str = "application/json",
    key: str | None = None,
    missing_ok: bool = False,
) -> dict[str, Any] | None:
    headers = {"Content-Type": content}
    if key:
        headers["Idempotency-Key"] = key
    with closing(HTTPConnection("127.0.0.1", port, timeout=20)) as conn:
        conn.request("GET" if body is None else "POST", path, body=body, headers=headers)
        reply = conn.getresponse()
        if missing_ok and reply.status == 404:
            return None
        if not 200 <= reply.status < 300:
            raise ValueError(f"Studio 回覆 HTTP {reply.status}，請確認工作流和元件狀態。")
        payload = reply.read(1024**2 + 1)
    if len(payload) > 1024**2:
        raise ValueError("Studio 回覆過大。")
    result = json.loads(payload)
    if not isinstance(result, dict):
        raise ValueError("Studio 回覆格式無效。")
    return result


def _upload(port: int, body: bytes, media: str) -> dict[str, Any]:
    ref = _call(port, f"/api/files?media_type={media}", body, content="application/octet-stream")
    if not ref or ref.get("sha256") != hashlib.sha256(body).hexdigest() or ref.get("size_bytes") != len(body):
        raise ValueError("Studio 上傳結果與修訂檔不符。")
    return ref


def submit(port: int, role: str, manifest: bytes, png: bytes) -> str:
    """Submit the saved art-return pipeline. Lost replies can be observed by content identity."""
    if role not in plates(manifest) or not 0 < len(png) <= MAX_BYTES:
        raise ValueError("修訂角色或圖片大小無效。")
    identity = hashlib.sha256(b"krita-art-return-v1\0" + role.encode() + hashlib.sha256(manifest).digest())
    identity.update(png)
    key = identity.hexdigest()
    for _ in range(32):
        receipt = _call(port, f"/api/run-submissions/{key}", missing_ok=True)
        if receipt is None:
            break
        if receipt.get("state") == "unconfirmed":
            raise ValueError(f"Studio 正在核對先前回程，收據 {key}。")
        if receipt.get("state") != "rejected":
            return str(UUID(receipt["run_id"]))
        key = hashlib.sha256(key.encode("ascii")).hexdigest()
    else:
        raise ValueError("同一修訂連續遭拒，請在 Studio 檢查 art-return 設定。")
    pipeline = _call(port, "/api/pipelines/art-return")
    if not pipeline or pipeline.get("pipeline_id") != "art-return":
        raise ValueError("Studio 缺少 art-return 工作流。")
    steps = pipeline.get("steps")
    if not isinstance(steps, list) or len(steps) != 1 or steps[0].get("parameters", {}).get("operation") != "return":
        raise ValueError("art-return 的步驟與美術回程不相容。")
    steps[0]["parameters"]["role"] = role
    inputs = {
        "image_file": {"type_id": "media.image.v1", "file": _upload(port, png, "image/png")},
        "manifest_file": {"type_id": KIND, "file": _upload(port, manifest, "application/json")},
    }
    body = json.dumps({"pipeline": pipeline, "inputs": inputs, "label": f"Krita · {role}"}).encode()
    try:
        run = _call(port, "/api/runs", body, key=key)
        if run:
            return str(UUID(run["run_id"]))
    except (ValueError, KeyError, OSError, HTTPException) as exc:
        raise ValueError(f"請在 Studio 查詢回程收據 {key}，確認後再送出。") from exc
    raise ValueError(f"無法辨識 Studio 回應，回程收據 {key}。")
