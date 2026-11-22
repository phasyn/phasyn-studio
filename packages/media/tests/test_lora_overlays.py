"""Overlay detection for LoRA training clips: logos and watermarks must be found so they are never trained on."""

from __future__ import annotations

import numpy as np

from phasyn_media import lora_dataset as stats


H, W, N = 138, 240, 48
LOGO = (slice(6, 22), slice(186, 232))  # rows, cols of a corner logo on the sample grid


def _pictures(seed: int = 7) -> np.ndarray:
    """N different drawn-looking pictures: flat colour blocks at random places."""
    rng = np.random.default_rng(seed)
    out = np.empty((N, H, W), dtype=np.float32)
    for i in range(N):
        frame = np.full((H, W), rng.uniform(30, 200), dtype=np.float32)
        for _ in range(6):
            y, x = rng.integers(0, H - 20), rng.integers(0, W - 20)
            frame[y : y + rng.integers(10, 60), x : x + rng.integers(10, 90)] = (
                rng.uniform(0, 255)
            )
        out[i] = frame
    return out


def _logo(frames: np.ndarray, alpha: float) -> np.ndarray:
    """Letters of a white logo blended over every frame at ``alpha`` (translucent below 1)."""
    out = frames.copy()
    letters = np.zeros((H, W), dtype=bool)
    for x0 in range(LOGO[1].start, LOGO[1].stop - 4, 8):
        letters[LOGO[0], x0 : x0 + 4] = True
    out[:, letters] = (1 - alpha) * out[:, letters] + alpha * 255.0
    return out


def _boxes(frames: np.ndarray) -> list[list[int]]:
    found = stats.static_overlays(
        np.clip(frames, 0, 255).astype(np.uint8), width=W * 2, height=H * 2
    )
    return [b["region"] for b in found]


def _covers(box: list[int]) -> bool:
    x0, y0, x1, y1 = box
    return (
        x0 <= LOGO[1].start * 2
        and y0 <= LOGO[0].start * 2
        and x1 >= LOGO[1].stop * 2 - 8
        and y1 >= LOGO[0].stop * 2
    )


def test_a_translucent_corner_logo_is_found() -> None:
    boxes = _boxes(_logo(_pictures(), alpha=0.45))
    assert len(boxes) == 1
    assert _covers(boxes[0])


def test_changing_pictures_alone_have_no_overlay() -> None:
    assert _boxes(_pictures()) == []


def test_a_still_shot_through_one_stretch_is_not_an_overlay() -> None:
    frames = _pictures()
    # one stretch of the samples shows the same held drawing
    frames[: N // 4] = frames[0]
    assert _boxes(frames) == []


def test_letterbox_lines_are_not_overlays() -> None:
    frames = _pictures()
    frames[:, :12] = 0.0
    frames[:, -12:] = 0.0
    assert _boxes(frames) == []


def test_fill_regions_blanks_only_the_box() -> None:
    frame = np.zeros((40, 60, 3), dtype=np.uint8)
    frame[:, :] = (10, 20, 30)
    frame[2:10, 40:58] = 255
    out = stats.fill_regions(frame, [[40, 2, 58, 10]])
    assert (out[2:10, 40:58] == (10, 20, 30)).all()
    assert (out[12:] == frame[12:]).all()
