"""Integrity boundaries for local restoration models and immutable media assets."""

from pathlib import Path
from unittest.mock import Mock

import pytest
from phasyn_components.errors import ComponentError

from phasyn_seedvr2.sources import unpack_engine, verify_weights
from phasyn_seedvr2.video import render


def test_engine_archive_is_verified_before_extraction(tmp_path: Path) -> None:
    archive = tmp_path / "source.tar.gz"
    archive.write_bytes(b"wrong archive")
    destination = tmp_path / "engine"
    with pytest.raises(ValueError):
        unpack_engine(archive, destination)
    assert not destination.exists()


def test_weight_verification_rejects_a_linked_directory(tmp_path: Path) -> None:
    actual = tmp_path / "actual"
    actual.mkdir()
    link = tmp_path / "alias"
    link.symlink_to(actual, target_is_directory=True)
    with pytest.raises(OSError):
        verify_weights(link)


def test_refuse_to_overwrite_an_existing_export(tmp_path: Path) -> None:
    source = tmp_path / "input.mp4"
    source.write_bytes(b"original media")
    output = tmp_path / "existing.mp4"
    output.write_bytes(b"keep")
    with pytest.raises(ComponentError, match="MP4"):
        render(source, output, parameters={}, restore=Mock(), cancel=None)
    assert output.read_bytes() == b"keep"
