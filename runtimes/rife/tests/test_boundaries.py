"""File and audio integrity boundaries for selective interpolation."""

from pathlib import Path
from unittest.mock import Mock

import pytest
from phasyn_components.errors import ComponentError

from phasyn_rife.model import _archive_bytes
from phasyn_rife.video import render


def test_archive_rejects_truncated_or_linked_weights(tmp_path: Path) -> None:
    path = tmp_path / "model.zip"
    path.write_bytes(b"incomplete")
    with pytest.raises(ValueError, match="Invalid RIFE"):
        _archive_bytes(path)
    link = tmp_path / "alias.zip"
    link.symlink_to(path)
    with pytest.raises(OSError):
        _archive_bytes(link)


def test_existing_output_survives_a_render_attempt(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    existing = tmp_path / "export.mp4"
    existing.write_bytes(b"original")
    with pytest.raises(ComponentError, match="MP4"):
        render(source, existing, parameters={}, interpolate=Mock(), cancel=None)
    assert existing.read_bytes() == b"original"
