"""Path traversal guard of the file store (CWE-22)."""

from __future__ import annotations

from pathlib import Path

import pytest

from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore, FileWriter, ensure_within


NODE = "00000000-0000-4000-8000-000000000001"
FILE = "00000000-0000-4000-8000-000000000002"


def test_ensure_within_accepts_the_root_and_children(tmp_path: Path) -> None:
    assert ensure_within(tmp_path, tmp_path) == tmp_path
    child = tmp_path / "a" / "b"
    assert ensure_within(tmp_path, child) == child


def test_ensure_within_refuses_escapes(tmp_path: Path) -> None:
    with pytest.raises(ComponentError) as caught:
        ensure_within(tmp_path / "files", tmp_path / "files" / ".." / "other")
    assert caught.value.code == "INVALID_ARGUMENT"


def test_ensure_within_refuses_a_symlink_out_of_the_root(tmp_path: Path) -> None:
    root = tmp_path / "files"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "link").symlink_to(outside)
    with pytest.raises(ComponentError):
        ensure_within(root, root / "link" / "x")


def test_store_paths_stay_unresolved_inside_the_root(tmp_path: Path) -> None:
    store = FileStore(tmp_path, NODE)
    assert store.directory(FILE) == tmp_path / "files" / FILE
    assert (
        store.remote_directory({"node_id": NODE, "file_id": FILE})
        == tmp_path / "files" / "remote" / NODE / FILE
    )


def test_writer_refuses_a_parent_segment(tmp_path: Path) -> None:
    with pytest.raises(ComponentError) as caught:
        FileWriter(
            tmp_path / "files" / ".." / "x",
            node_id=NODE,
            file_id=FILE,
            media_type="video/mp4",
            metadata={},
        )
    assert caught.value.code == "INVALID_ARGUMENT"
