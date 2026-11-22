"""Verify and inspect the closed, stored-only ZIP format of a portable Studio project."""

from __future__ import annotations

import hashlib
import json
import re
import stat
import struct
import zipfile
from collections.abc import Iterator
from typing import Any, BinaryIO

from phasyn_components import contracts
from phasyn_components.canonical import canonical_json, digest
from phasyn_components.creative_library import validate_archive_versions
from phasyn_components.errors import ComponentError
from phasyn_components.ids import is_uuid
from phasyn_components.timeline import validate_timeline
from phasyn_components.typed import check_fileref

from .studio_backfill import is_file_ref
from .studio_previs import validate_previs


type Doc = dict[str, Any]
CHUNK = 1024 * 1024
MAX_ZIP = 64 * 1024**3
MAX_DOC = 32 * 1024**2
MAX_MEMBERS = 16384
MAX_DIRECTORY = 4 * 1024**2
_MEDIA = re.compile(r"media/[0-9a-f]{64}")
FORMAT = "phasyn-project/1"


def invalid(reason: str) -> ComponentError:
    """Create a validation error without echoing untrusted paths or content."""
    return ComponentError("INVALID_ARGUMENT", reason)


def objects(value: Any) -> Iterator[Doc]:
    """Walk nested JSON, including the attached files in a FileRef's metadata.links."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            yield item
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)


def file_table(snapshot: Doc) -> dict[str, list[Doc]]:
    """Collect distinct published references, deduplicating archived bytes by digest."""
    table: dict[str, list[Doc]] = {}
    seen: dict[tuple[str, str], Doc] = {}
    for obj in objects(snapshot):
        if not is_file_ref(obj):
            continue
        ref = check_fileref(obj, where="專案可攜包")
        key = ref["node_id"], ref["file_id"]
        if key in seen:
            if seen[key] != ref:
                raise invalid("同一份來源檔案具有衝突的身分或附件")
            continue
        seen[key] = ref
        group = table.setdefault(ref["sha256"], [])
        if group and group[0]["size_bytes"] != ref["size_bytes"]:
            raise invalid("相同素材摘要標示了不同長度")
        group.append(ref)
    return table


def run_ids(data: Any) -> set[str]:
    """Identify run references without interpreting prompts or executing archived plans."""
    return {
        value
        for obj in objects(data)
        for key, value in obj.items()
        if (key == "run_id" or key.endswith("_run_id")) and is_uuid(value)
    }


def requirements(runs: list[Doc]) -> list[Doc]:
    """Summarize frozen component placement and identities as observed at generation."""
    unique: dict[str, Doc] = {}
    for run in runs:
        for step in run["request"]["pipeline"]["steps"]:
            value = {k: step[k] for k in ("node_id", "component_id")}
            frozen = run["steps"].get(step["step_id"], {})
            settings = frozen.get("settings")
            if isinstance(settings, dict):
                for key in ("model_identity", "runtime_identity"):
                    if isinstance(settings.get(key), dict) and settings[key]:
                        value[key] = settings[key]
                for key in ("provider_id", "runtime_id"):
                    if isinstance(settings.get(key), str) and settings[key]:
                        value[key] = settings[key]
            unique[digest(value)] = value
    return list(unique.values())


def _validate(snapshot: Doc) -> None:
    fields = {"project", "creative", "reviews", "runs", "drafts"}
    if snapshot.keys() != fields:
        raise invalid("專案可攜包的快照格式無效")
    project = snapshot["project"]
    contracts.validate("StudioProject", project)
    validate_previs(project)
    if "timeline" in project:
        validate_timeline(project["timeline"])
    contracts.validate("StudioTakeReviews", snapshot["reviews"])
    if snapshot["reviews"]["project_id"] != project["project_id"]:
        raise invalid("審查紀錄的來源專案不一致")
    for key, schema in (("runs", "Run"), ("drafts", "StudioDraftPlan")):
        rows = snapshot[key]
        if not isinstance(rows, list) or len(rows) > MAX_MEMBERS:
            raise invalid("凍結工作清單超出範圍")
        for row in rows:
            contracts.validate(schema, row)
    if len({r["run_id"] for r in snapshot["runs"]}) != len(snapshot["runs"]):
        raise invalid("工作清單有重複的 Run")
    validate_archive_versions(project["project_id"], snapshot["creative"])


def _bounded_directory(stream: BinaryIO) -> None:
    # Bound the central directory before ZipFile reads it into memory; our archives have no ZIP comment.
    size = stream.seek(0, 2)
    footer = struct.Struct("<4s4H2IH")
    if size > MAX_ZIP or size < footer.size:
        raise invalid("專案可攜包大小超出範圍")
    stream.seek(-footer.size, 2)
    marker, disk, start_disk, count_disk, count, cd_size, _, comment = footer.unpack(
        stream.read(footer.size)
    )
    if marker != b"PK\x05\x06" or comment or disk or start_disk or count != count_disk:
        raise invalid("專案可攜包的 ZIP 結尾不完整")
    large = struct.Struct("<4sQ2H2I4Q")
    locator = struct.Struct("<4sIQI")
    if size >= footer.size + locator.size:
        stream.seek(-(footer.size + locator.size), 2)
        tag, disk, location, disks = locator.unpack(stream.read(locator.size))
        if tag == b"PK\x06\x07":
            if (
                disk
                or disks != 1
                or location != size - footer.size - locator.size - large.size
                or location < 0
            ):
                raise invalid("專案可攜包的 ZIP64 位置無效")
            stream.seek(location)
            tag, length, _, _, disk, start_disk, count_disk, count, cd_size, _ = (
                large.unpack(stream.read(large.size))
            )
            if (
                tag != b"PK\x06\x06"
                or length != large.size - 12
                or disk
                or start_disk
                or count != count_disk
            ):
                raise invalid("專案可攜包的 ZIP64 索引無效")
    if count > MAX_MEMBERS or cd_size > MAX_DIRECTORY or cd_size > size:
        raise invalid("專案可攜包索引超出範圍")
    stream.seek(0)


def _document(raw: bytes) -> Doc:
    def unique(pairs: list[tuple[str, Any]]) -> Doc:
        result = dict(pairs)
        if len(result) != len(pairs):
            raise invalid("專案可攜包的 JSON 欄位重複")
        return result

    def reject_number(_: str) -> None:
        raise invalid("專案快照含非有限數值")

    value = json.loads(raw, object_pairs_hook=unique, parse_constant=reject_number)
    if not isinstance(value, dict):
        raise invalid("專案可攜包的 JSON 文件無效")
    return value


def _members(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    rows = archive.infolist()
    names = {entry.filename: entry for entry in rows}
    if len(names) != len(rows) or len(rows) > MAX_MEMBERS:
        raise invalid("專案可攜包有重複或過量項目")
    for name, entry in names.items():
        if (
            (
                name not in {"manifest.json", "snapshot.json"}
                and not _MEDIA.fullmatch(name)
            )
            or name != entry.orig_filename
            or entry.flag_bits & 1
            or entry.compress_type != zipfile.ZIP_STORED
            or entry.file_size != entry.compress_size
            or stat.S_IFMT(entry.external_attr >> 16) not in {0, stat.S_IFREG}
        ):
            raise invalid("專案可攜包包含不支援的路徑、連結或壓縮方式")
    if any(
        name not in names or names[name].file_size > MAX_DOC
        for name in ("manifest.json", "snapshot.json")
    ):
        raise invalid("專案可攜包缺少有效的快照或清單")
    if sum(x.file_size for x in rows) > MAX_ZIP:
        raise invalid("專案資料展開後超出容量上限")
    return names


def inspect(stream: BinaryIO) -> tuple[Doc, Doc]:
    """Validate every declared payload and return the immutable snapshot and missing-dependency report."""
    _bounded_directory(stream)
    with zipfile.ZipFile(stream) as archive:
        names = _members(archive)
        manifest = _document(archive.read("manifest.json"))
        raw = archive.read("snapshot.json")
        if manifest != {
            "format": FORMAT,
            "snapshot_sha256": hashlib.sha256(raw).hexdigest(),
        }:
            raise invalid("專案可攜包的版本或快照摘要不符")
        snapshot = _document(raw)
        _validate(snapshot)
        table = file_table(snapshot)
        unexpected = (
            names.keys()
            - {"manifest.json", "snapshot.json"}
            - {f"media/{sha}" for sha in table}
        )
        if unexpected:
            raise invalid("專案可攜包包含未被引用的素材")
        missing = []
        for sha, refs in table.items():
            name = f"media/{sha}"
            if name not in names:
                missing.append({"kind": "file", "id": sha})
                continue
            if names[name].file_size != refs[0]["size_bytes"]:
                raise invalid("專案素材大小不符")
            with archive.open(name) as blob:
                measured = hashlib.sha256()
                while chunk := blob.read(CHUNK):
                    measured.update(chunk)
                if measured.hexdigest() != sha:
                    raise ComponentError(
                        "FILE_HASH_MISMATCH", "專案素材內容與來源摘要不符"
                    )
    project = snapshot["project"]
    archived_runs = {r["run_id"] for r in snapshot["runs"]}
    needed_runs = run_ids(snapshot)
    missing.extend(
        {"kind": "run", "id": rid} for rid in sorted(needed_runs - archived_runs)
    )
    return snapshot, {
        "source_project_id": project["project_id"],
        "source_revision": project["revision"],
        "title": project["title"],
        "take_count": sum(
            len(s["takes"])
            for k in ("shots", "image_shots")
            for s in project.get(k, [])
        ),
        "file_count": len(table),
        "run_count": len(archived_runs),
        "creative_version_count": len(snapshot["creative"]),
        "requirements": requirements(snapshot["runs"]),
        "missing": missing,
        "importable": not missing,
    }


def metadata(snapshot: Doc) -> tuple[bytes, bytes]:
    """Bind the format and the complete, frozen JSON state to a versioned digest."""
    raw = canonical_json(snapshot)
    if len(raw) > MAX_DOC:
        raise invalid("專案快照超出容量上限")
    return raw, canonical_json(
        {"format": FORMAT, "snapshot_sha256": hashlib.sha256(raw).hexdigest()}
    )
