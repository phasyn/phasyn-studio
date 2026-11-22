"""Local video imports for LoRA training: only configured roots, no links, no escapes, verified copies."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore

from phasyn_controller.lora_training import local_imports as li


NODE = "00000000-0000-4000-8000-000000000001"


@pytest.fixture
def root(tmp_path: Path) -> Path:
    r = tmp_path / "bridge"
    (r / "battle").mkdir(parents=True)
    (r / "battle" / "a.mp4").write_bytes(b"video-bytes")
    (r / "notes.txt").write_text("x")
    return r


def test_lists_only_folders_and_videos(root: Path) -> None:
    top = li.listing([root], 0, "")
    assert [(e["name"], e["kind"]) for e in top["entries"]] == [("battle", "folder")]
    inner = li.listing([root], 0, "battle")
    assert [e["name"] for e in inner["entries"]] == ["a.mp4"]


@pytest.mark.parametrize("bad", ["../x", "/etc", "battle/../../x", "a\x00b"])
def test_refuses_escapes(root: Path, bad: str) -> None:
    with pytest.raises(ComponentError):
        li.listing([root], 0, bad)


def test_unknown_root_is_not_found(root: Path) -> None:
    with pytest.raises(ComponentError) as caught:
        li.listing([root], 3, "")
    assert caught.value.code == "NOT_FOUND"


def test_symlinks_are_never_followed(root: Path, tmp_path: Path) -> None:
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "b.mp4").write_bytes(b"secret")
    (root / "link").symlink_to(outside)
    (root / "battle" / "c.mp4").symlink_to(outside / "b.mp4")
    assert "link" not in [e["name"] for e in li.listing([root], 0, "")["entries"]]
    store = FileStore(tmp_path / "store", NODE)
    for path in ("link/b.mp4", "battle/c.mp4"):
        with pytest.raises(ComponentError):
            li.import_file([root], 0, path, store, max_bytes=1 << 20)


def test_hard_links_and_non_videos_are_refused(root: Path, tmp_path: Path) -> None:
    os.link(root / "battle" / "a.mp4", root / "battle" / "d.mp4")
    store = FileStore(tmp_path / "store", NODE)
    with pytest.raises(ComponentError):
        li.import_file([root], 0, "battle/d.mp4", store, max_bytes=1 << 20)
    with pytest.raises(ComponentError):
        li.import_file([root], 0, "notes.txt", store, max_bytes=1 << 20)


def test_import_copies_and_hashes_without_touching_the_source(
    root: Path, tmp_path: Path
) -> None:
    store = FileStore(tmp_path / "store", NODE)
    before = (root / "battle" / "a.mp4").stat()
    ref = li.import_file([root], 0, "battle/a.mp4", store, max_bytes=1 << 20)
    assert ref["sha256"] == hashlib.sha256(b"video-bytes").hexdigest()
    assert ref["size_bytes"] == len(b"video-bytes")
    assert store.payload_path(ref["file_id"]).read_bytes() == b"video-bytes"
    after = (root / "battle" / "a.mp4").stat()
    assert (before.st_mtime_ns, before.st_size) == (after.st_mtime_ns, after.st_size)


def test_size_limit(root: Path, tmp_path: Path) -> None:
    store = FileStore(tmp_path / "store", NODE)
    with pytest.raises(ComponentError) as caught:
        li.import_file([root], 0, "battle/a.mp4", store, max_bytes=3)
    assert caught.value.code == "PAYLOAD_TOO_LARGE"
