"""Boundary: a quantized-weight cache entry is used only for exactly its key, and a damaged one never.

A stale or damaged entry would load wrong weights without any error, so the invalidation rule is checked
here (torch-free: the entries are written with the module's own header and manifest builders). The
torch side (bit identity of a hit against a fresh quantization) is checked on a CPU runtime outside `tools/check.sh`.
"""

from __future__ import annotations

import json
import math
import os
import struct
from pathlib import Path
from typing import Any

import pytest
from phasyn_h3.recipe.runtime import quantized_cache as qc

pytestmark = pytest.mark.static

SPECS = [
    ("blocks.0.qkv.weight", "I8", (8, 4)),
    ("blocks.0.qkv.weight_scale", "F32", (8, 1)),
    ("norm.weight", "BF16", (4,)),
]


def _parts(**overrides: Any) -> dict[str, Any]:
    parts: dict[str, Any] = {
        "source": {"index_sha256": "a" * 64, "shards": [{"name": "model-00001.safetensors", "size": 10}]},
        "quantization": {"scheme": "int8_convrot", "group_size": 256, "ignored_layers": ["adaln_proj"]},
        "excluded_modules": ["adaln_proj"],
        "runtime": {"torch": "2.14.1", "sm": [12, 0]},
    }
    parts.update(overrides)
    return parts


def _write(root: Path, parts: dict[str, Any]) -> tuple[str, Path]:
    key = qc.cache_key(parts)
    header = qc.build_header(SPECS, {"format": qc.FORMAT, "key": key})
    size = sum(qc.DTYPE_BYTES[dtype] * math.prod(shape) for _name, dtype, shape in SPECS)
    body = bytes(range(256))
    entry = root / key
    entry.mkdir(parents=True)
    (entry / qc.DATA_FILE).write_bytes(header + body[:size])
    manifest = qc.make_manifest(
        key,
        parts,
        header=header,
        data_size=len(header) + size,
        tensors=len(SPECS),
        strides={"blocks.0.qkv.weight": [1, 8]},
        quantized_layers=["blocks.0.qkv"],
        reverse_mapping=None,
    )
    (entry / qc.MANIFEST_FILE).write_text(json.dumps(manifest), encoding="utf-8")
    return key, entry


def test_a_well_formed_entry_is_a_hit_for_its_own_key_only(tmp_path: Path) -> None:
    key, _entry = _write(tmp_path, _parts())
    entry, reason = qc.lookup(tmp_path, key)
    assert reason == "hit" and entry is not None
    assert entry.quantized_layers == ("blocks.0.qkv",)
    assert {t.name: t.stride for t in entry.tensors}["blocks.0.qkv.weight"] == (1, 8)
    other = qc.cache_key(_parts(excluded_modules=["adaln_proj", "blocks.0.ff"]))
    assert other != key
    assert qc.lookup(tmp_path, other) == (None, "miss: no entry")


@pytest.mark.parametrize(
    "change",
    [
        {"excluded_modules": []},
        {"quantization": {"scheme": "int8_convrot", "group_size": 128, "ignored_layers": ["adaln_proj"]}},
        {"source": {"index_sha256": "b" * 64, "shards": [{"name": "model-00001.safetensors", "size": 10}]}},
        {"runtime": {"torch": "2.15.0", "sm": [12, 0]}},
        {"runtime": {"torch": "2.14.1", "sm": [12, 1]}},
    ],
)
def test_every_key_part_changes_the_key(change: dict[str, Any]) -> None:
    assert qc.cache_key(_parts(**change)) != qc.cache_key(_parts())


def test_a_format_bump_misses_old_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    key, _entry = _write(tmp_path, _parts())
    monkeypatch.setattr(qc, "FORMAT_VERSION", qc.FORMAT_VERSION + 1)
    assert qc.cache_key(_parts()) != key
    entry, reason = qc.lookup(tmp_path, key)  # the old directory name, read by the new code
    assert entry is None and reason.startswith("invalid")


def test_an_entry_copied_under_another_key_is_refused(tmp_path: Path) -> None:
    key, entry_dir = _write(tmp_path, _parts())
    other = qc.cache_key(_parts(excluded_modules=[]))
    entry_dir.rename(tmp_path / other)
    entry, reason = qc.lookup(tmp_path, other)
    assert entry is None and "key" in reason
    assert qc.lookup(tmp_path, key) == (None, "miss: no entry")


def _damage_truncate(entry: Path) -> None:
    data = entry / qc.DATA_FILE
    data.write_bytes(data.read_bytes()[:-3])


def _damage_append(entry: Path) -> None:
    with (entry / qc.DATA_FILE).open("ab") as handle:
        handle.write(b"\0")


def _damage_header(entry: Path) -> None:
    data = bytearray((entry / qc.DATA_FILE).read_bytes())
    position = data.index(b"[8,4]")
    data[position : position + 5] = b"[4,8]"  # same size, different shape: only the header sha256 tells
    (entry / qc.DATA_FILE).write_bytes(bytes(data))


def _damage_manifest_json(entry: Path) -> None:
    (entry / qc.MANIFEST_FILE).write_text('{"format": ', encoding="utf-8")


def _damage_manifest_parts(entry: Path) -> None:
    manifest = json.loads((entry / qc.MANIFEST_FILE).read_text(encoding="utf-8"))
    manifest["parts"]["excluded_modules"] = []  # key no longer the digest of its parts
    (entry / qc.MANIFEST_FILE).write_text(json.dumps(manifest), encoding="utf-8")


def _damage_missing_data(entry: Path) -> None:
    (entry / qc.DATA_FILE).unlink()


def _damage_symlinked_data(entry: Path) -> None:
    data = entry / qc.DATA_FILE
    real = entry.parent / "elsewhere.safetensors"
    data.rename(real)
    os.symlink(real, data)


def _damage_hardlinked_data(entry: Path) -> None:
    os.link(entry / qc.DATA_FILE, entry.parent / "second-name.safetensors")


@pytest.mark.parametrize(
    "damage",
    [
        _damage_truncate,
        _damage_append,
        _damage_header,
        _damage_manifest_json,
        _damage_manifest_parts,
        _damage_missing_data,
        _damage_symlinked_data,
        _damage_hardlinked_data,
    ],
)
def test_a_damaged_entry_is_never_used(tmp_path: Path, damage: Any) -> None:
    root = tmp_path / "cache"
    key, entry_dir = _write(root, _parts())
    damage(entry_dir)
    entry, reason = qc.lookup(root, key)
    assert entry is None and reason.startswith("invalid"), reason


def test_a_partial_write_left_behind_is_not_an_entry(tmp_path: Path) -> None:
    key, entry_dir = _write(tmp_path, _parts())
    entry_dir.rename(tmp_path / f".tmp-{key[:16]}-crashed")  # what a crash before the rename leaves
    assert qc.lookup(tmp_path, key) == (None, "miss: no entry")


def test_a_symlinked_cache_dir_is_refused(tmp_path: Path) -> None:
    real = tmp_path / "real"
    key, _entry = _write(real, _parts())
    (tmp_path / "link").symlink_to(real)
    entry, reason = qc.lookup(tmp_path / "link", key)
    assert entry is None and reason.startswith("invalid")


def _shard(path: Path, payload: bytes) -> None:
    header = json.dumps({"w": {"dtype": "BF16", "shape": [len(payload) // 2], "data_offsets": [0, len(payload)]}})
    raw = header.encode() + b" " * (-len(header) % 8)
    path.write_bytes(struct.pack("<Q", len(raw)) + raw + payload)


def test_a_changed_checkpoint_shard_changes_the_source_identity(tmp_path: Path) -> None:
    directory = tmp_path / "Ref2VA" / "transformer"
    directory.mkdir(parents=True)
    (directory / "model.safetensors.index.json").write_text(
        json.dumps({"weight_map": {"w": "model-00001-of-00001.safetensors"}}), encoding="utf-8"
    )
    shard = directory / "model-00001-of-00001.safetensors"
    _shard(shard, b"\1\2\3\4")
    before = qc.source_identity(directory)
    assert before["shards"][0]["recorded_sha256"] is None  # not a file the bundled manifest lists
    info = shard.stat()
    _shard(shard, b"\4\3\2\1")  # same size, same header
    os.utime(shard, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000))
    after = qc.source_identity(directory)
    assert after != before
    assert qc.cache_key(_parts(source=after)) != qc.cache_key(_parts(source=before))
