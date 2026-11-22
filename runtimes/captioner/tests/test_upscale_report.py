"""media.upscale report: the source record identifies the input file without the shape of a FileRef.

Adopting an upscaled take walks the whole asset for FileRefs and refuses one that is not a valid FileRef; a source
record with node_id, file_id, sha256 and size_bytes (but no media_type) made every 超分 2× result unadoptable
(STATE_CONFLICT invalid_adopted_media_file)."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from fractions import Fraction
from types import SimpleNamespace
from typing import Any

from phasyn_captioner.upscale import plan
from phasyn_captioner.upscale.report import actual_settings
from phasyn_components.typed import is_fileref


def _mappings(value: Any) -> Iterator[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        yield value
        for item in value.values():
            yield from _mappings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _mappings(item)


def test_report_has_no_fileref_shaped_record() -> None:
    ref = {
        "node_id": "00000000-0000-4000-8000-000000000001",
        "file_id": "00000000-0000-4000-8000-000000000002",
        "sha256": "5" * 64,
        "size_bytes": 2177185,
        "media_type": "video/mp4",
        "metadata": {},
    }
    method = SimpleNamespace(
        method_id="anime4k-v4-upscale-cnn-x2-vl",
        label="Anime4K",
        upscale=SimpleNamespace(sha256="6" * 64),
        halo=7,
        shaders=(("Anime4K_Upscale_CNN_x2_VL.glsl", "6" * 64),),
    )
    source = SimpleNamespace(
        color_assumed=False,
        pixel_format="yuv420p",
        dropped_streams=0,
        width=768,
        height=448,
        frames=124,
        fps=Fraction(24, 1),
        color={"primaries": "bt709"},
        audio=SimpleNamespace(codec="aac"),
    )
    report = actual_settings(
        "media.upscale",
        method,  # type: ignore[arg-type]
        "fp16",
        262144,
        ref=ref,
        asset={"asset_id": "00000000-0000-4000-8000-000000000003"},
        source=source,
        geometry=plan.Geometry(768, 448, 1536, 896, 1536, 896),
        params=plan.UpscaleParams(scale=2, target="2x", crf=16),
        track=SimpleNamespace(frames=124, duration_seconds=124 / 24, encoder_name="libx264"),
        size=7206476,
        sha256="9" * 64,
    )
    recorded = report["upscale"]["source"]
    assert {recorded["node_id"], recorded["file_id"], recorded["sha256"]} == {
        ref["node_id"],
        ref["file_id"],
        ref["sha256"],
    }
    assert [item for item in _mappings(report) if is_fileref(item)] == []
