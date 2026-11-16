"""media.upscale boundaries: untrusted video sizes and parameters are refused before decoding, work files stay
inside the call's work directory, tiles cover a frame exactly once, and only the pinned shader is accepted."""

from __future__ import annotations

from pathlib import Path

import pytest
from phasyn_captioner.upscale import plan
from phasyn_captioner.upscale.shader import SHADER_DIR, SHADER_FILE, load_vendored, parse_chain
from phasyn_components.errors import ComponentError


def _code(fn, *args, **kwargs) -> str:
    with pytest.raises(ComponentError) as info:
        fn(*args, **kwargs)
    return info.value.code


def test_source_and_output_pixels_are_bounded() -> None:
    assert plan.output_geometry(1280, 736, scale=2, target="2x").output_width == 2560
    assert _code(plan.output_geometry, 2048, 1090, scale=2, target="2x") == "INPUT_TOO_LARGE"
    assert _code(plan.output_geometry, 8193, 2, scale=2, target="2x") == "INVALID_ARGUMENT"
    assert _code(plan.output_geometry, 0, 736, scale=2, target="2x") == "INVALID_ARGUMENT"
    # 2160p of a very wide source would exceed the output bound
    assert _code(plan.output_geometry, 2048, 720, scale=2, target="2160p") == "INPUT_TOO_LARGE"


def test_target_keeps_aspect_with_even_width_and_never_downscales() -> None:
    g = plan.output_geometry(1280, 736, scale=2, target="2160p")
    assert (g.output_width, g.output_height) == (3756, 2160) and g.output_width % 2 == 0
    assert _code(plan.output_geometry, 1280, 1440, scale=2, target="1440p") == "INVALID_ARGUMENT"


def test_frame_count_is_bounded_not_truncated() -> None:
    plan.check_frames(7200, 7200)
    assert _code(plan.check_frames, 7201, 7200) == "INPUT_TOO_LARGE"
    assert _code(plan.check_frames, 0, 7200) == "MEDIA_INCOMPLETE"


@pytest.mark.parametrize(
    "raw",
    [{"scale": 3}, {"scale": True}, {"target": "4320p"}, {"crf": 9}, {"crf": 31}, {"crf": 16.0}, {"extra": 1}],
)
def test_parameters_out_of_range_are_refused(raw: dict) -> None:
    assert _code(plan.resolve_params, raw) in ("INVALID_ARGUMENT", "UNSUPPORTED_SETTING")


@pytest.mark.parametrize(
    "raw",
    [{"tile_pixels": 100}, {"tile_pixels": 2 * 1024 * 1024}, {"max_frames": 30000}, {"cuda_memory_cap_bytes": 1}],
)
def test_load_options_out_of_range_are_refused(raw: dict) -> None:
    assert _code(plan.resolve_load_options, raw) == "INVALID_ARGUMENT"


@pytest.mark.parametrize("name", ["", ".", "..", "../x.mp4", "a/b.mp4", ".hidden", "x\x00.mp4", "a\\b.mp4"])
def test_work_files_stay_inside_the_work_directory(tmp_path: Path, name: str) -> None:
    assert _code(plan.work_path, tmp_path, name) == "RUNTIME_ERROR"


def test_work_file_refuses_a_planted_link(tmp_path: Path) -> None:
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"")
    work = tmp_path / "work"
    work.mkdir()
    (work / "f.mp4").symlink_to(outside)
    assert _code(plan.work_path, work, "f.mp4") == "RUNTIME_ERROR"
    assert plan.work_path(work, "g.mp4") == work.resolve() / "g.mp4"


@pytest.mark.parametrize(("h", "w", "tile"), [(736, 1280, 512 * 512), (48, 64, 16384), (1088, 2048, 128 * 128)])
def test_tiles_cover_each_pixel_once_within_the_cap(h: int, w: int, tile: int) -> None:
    covered = [[0] * w for _ in range(h)]
    for y0, y1, x0, x1 in plan.tile_grid(h, w, tile):
        assert 0 < (y1 - y0) * (x1 - x0) <= tile
        for y in range(y0, y1):
            row = covered[y]
            for x in range(x0, x1):
                row[x] += 1
    assert all(v == 1 for row in covered for v in row)


def test_only_the_pinned_shader_is_accepted() -> None:
    spec = load_vendored()
    assert spec.halo == 7 and spec.depth_to_space == ("conv2d_last_tf", "conv2d_last_tf1", "conv2d_last_tf2")
    text = (SHADER_DIR / SHADER_FILE).read_text(encoding="ascii")
    broadcast = text.replace("float c1 = conv2d_last_tf1_tex(", "float c1 = c0; float unused = conv2d_last_tf1_tex(")
    assert _code(parse_chain, broadcast, name="x", sha256="0") == "MODEL_INCOMPATIBLE"
    residual = text.replace("    return result;\n}", "    return result + MAIN_tex(MAIN_pos);\n}", 1)
    assert _code(parse_chain, residual, name="x", sha256="0") == "MODEL_INCOMPATIBLE"
