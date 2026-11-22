"""Frame statistics behind the LoRA training clip rules (numpy only; FFmpeg decoding lives in the provider).

* :func:`telecine_phase` - a 24 fps drawing shown at ~30 fps repeats one frame in every five; such sources are
  decimated back to 24 fps before cutting, a native 30 fps source (even one animated on threes) is not;
* :func:`shot_stats` - motion, luma and flashes of every shot from a low-rate grey stream;
* :func:`pick_windows` - one window per shot, the shots spaced apart, high-motion shots first;
* :func:`clip_stats` - hidden cuts, held drawings, sharpness, letterbox and a perceptual hash of one clip;
* :func:`static_overlays` - logos and watermarks (also translucent ones) that stay while the picture changes
  (loss masks; :func:`fill_regions` blanks them in reference stills).
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

import numpy as np


# a repeated frame differs from its predecessor by codec noise only (grey levels on a 64x36 thumbnail)
DUPLICATE_DIFF = 0.5
TELECINE_DUP_RANGE = (0.12, 0.3)
TELECINE_PHASE_SHARE = 0.6
TELECINE_CYCLE = 5
MOVING_DIFF = 1.5
FLASH_JUMP = 40.0
HOLD_DIFF = 0.6
LETTERBOX_LUMA = 14.0
HIST_BINS = 8
HIDDEN_CUT_CORR = 0.55
# an overlay's outline: a grey-level step that stays at the same pixel while the picture under it changes; a
# translucent watermark changes brightness with the picture but keeps its outline, so edges are compared, not levels
OVERLAY_EDGE = 12.0
OVERLAY_PERSIST = 0.7
OVERLAY_SEGMENTS = 4
OVERLAY_MIN_STRETCHES = 2
OVERLAY_GROW = 3
OVERLAY_PAD = 4
OVERLAY_MIN_PIXELS = 20
OVERLAY_MAX_SHARE = 0.12
OVERLAY_MAX_SPAN = 0.5
OVERLAY_MIN_SAMPLES = 8
MIN_FRAMES = 2


def grey(frames: np.ndarray) -> np.ndarray:
    """RGB uint8 [N, H, W, 3] -> float32 luma [N, H, W] (BT.601 weights)."""
    f = frames.astype(np.float32)
    return 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]


def downsample(image: np.ndarray, height: int, width: int) -> np.ndarray:
    """Block-mean resize of [..., H, W] to [..., height, width] (bins of nearly equal size)."""
    h, w = image.shape[-2:]
    if h % height == 0 and w % width == 0:
        shaped = image.reshape(
            *image.shape[:-2], height, h // height, width, w // width
        )
        return shaped.astype(np.float32).mean(axis=(-3, -1))
    rows = np.array_split(np.arange(image.shape[-2]), height)
    cols = np.array_split(np.arange(image.shape[-1]), width)
    out = np.empty((*image.shape[:-2], height, width), dtype=np.float32)
    for i, r in enumerate(rows):
        band = image[..., r[0] : r[-1] + 1, :].mean(axis=-2)
        for j, c in enumerate(cols):
            out[..., i, j] = band[..., c[0] : c[-1] + 1].mean(axis=-1)
    return out


def frame_diffs(frames: np.ndarray) -> np.ndarray:
    """Mean absolute difference of consecutive grey frames [N, H, W] -> [N-1]."""
    if frames.shape[0] < MIN_FRAMES:
        return np.zeros(0, dtype=np.float32)
    return np.abs(np.diff(frames.astype(np.float32), axis=0)).mean(axis=(1, 2))


def telecine_phase(segments: Sequence[np.ndarray]) -> dict[str, Any]:
    """Whether native-rate grey segments repeat one frame per five at one fixed phase (24 -> 30 conversion)."""
    dup_total = moving_total = 0
    concentrated = 0
    checked = 0
    for seg in segments:
        diffs = frame_diffs(seg)
        if diffs.size < 4 * TELECINE_CYCLE:
            continue
        moving = diffs > DUPLICATE_DIFF
        dups = np.flatnonzero(~moving)
        neighbours_move = [
            i
            for i in dups
            if 0 < i < diffs.size - 1 and moving[i - 1] and moving[i + 1]
        ]
        dup_total += len(neighbours_move)
        moving_total += int(moving.sum()) + len(neighbours_move)
        if neighbours_move:
            residues = np.bincount(
                np.asarray(neighbours_move) % TELECINE_CYCLE, minlength=TELECINE_CYCLE
            )
            checked += 1
            if residues.max() / residues.sum() >= TELECINE_PHASE_SHARE:
                concentrated += 1
    rate = dup_total / moving_total if moving_total else 0.0
    lo, hi = TELECINE_DUP_RANGE
    telecine = bool(
        checked and lo <= rate <= hi and concentrated / checked >= TELECINE_PHASE_SHARE
    )
    return {
        "telecine": telecine,
        "isolated_duplicate_rate": round(rate, 4),
        "segments": checked,
    }


@dataclass(frozen=True)
class Shot:
    """One shot between two cuts, with statistics from the low-rate grey stream."""

    index: int
    start: float
    end: float
    motion: float
    moving_share: float
    luma: float
    flashes: int

    @property
    def seconds(self) -> float:
        """Shot length in seconds."""
        return self.end - self.start


def shot_stats(
    cuts: Sequence[float], duration: float, stream: np.ndarray, rate: float
) -> list[Shot]:
    """Statistics of every shot; ``stream`` is the grey video sampled at ``rate`` frames per second."""
    bounds = [0.0, *sorted(c for c in cuts if 0 < c < duration), duration]
    shots: list[Shot] = []
    for i, (start, end) in enumerate(pairwise(bounds)):
        a = int(np.ceil(start * rate))
        b = min(stream.shape[0], int(np.floor(end * rate)))
        part = stream[a:b]
        diffs = frame_diffs(part)
        luma = part.mean(axis=(1, 2)) if part.size else np.zeros(0)
        jumps = np.abs(np.diff(luma)) if luma.size > 1 else np.zeros(0)
        shots.append(
            Shot(
                index=i,
                start=start,
                end=end,
                motion=float(diffs.mean()) if diffs.size else 0.0,
                moving_share=float((diffs > MOVING_DIFF).mean()) if diffs.size else 0.0,
                luma=float(luma.mean()) if luma.size else 0.0,
                flashes=int((jumps > FLASH_JUMP).sum()),
            )
        )
    return shots


@dataclass(frozen=True)
class WindowRules:
    """Bounds for choosing one training window per shot."""

    clip_seconds: float
    min_shot_seconds: float = 1.3
    edge_margin_seconds: float = 0.15
    min_gap_seconds: float = 4.0
    min_moving_share: float = 0.15
    luma_range: tuple[float, float] = (18.0, 235.0)
    max_flashes: int = 2
    high_motion: float = 3.0
    high_share: float = 0.7
    limit: int = 400
    seed: int = 0


def shot_problem(shot: Shot, rules: WindowRules) -> str | None:
    """Why a shot gives no window (None = usable)."""
    need = max(
        rules.min_shot_seconds, rules.clip_seconds + 2 * rules.edge_margin_seconds
    )
    if shot.seconds < need:
        return "short_shot"
    if shot.moving_share < rules.min_moving_share:
        return "still_shot"
    if not rules.luma_range[0] <= shot.luma <= rules.luma_range[1]:
        return "too_dark_or_bright"
    if shot.flashes > rules.max_flashes:
        return "flashes"
    return None


def pick_windows(shots: Sequence[Shot], rules: WindowRules) -> list[tuple[Shot, float]]:
    """(shot, window start) for at most ``limit`` shots spaced ``min_gap_seconds`` apart, high motion first."""
    usable = [s for s in shots if shot_problem(s, rules) is None]
    rng = random.Random(rules.seed)  # noqa: S311 - a reproducible shuffle, not security
    high = [s for s in usable if s.motion >= rules.high_motion]
    low = [s for s in usable if s.motion < rules.high_motion]
    rng.shuffle(high)
    rng.shuffle(low)
    quota_high = round(rules.limit * rules.high_share)
    picked: list[Shot] = []
    for pool, quota in ((high, quota_high), (low, rules.limit)):
        taken = 0
        for shot in pool:
            if taken >= quota or len(picked) >= rules.limit:
                break
            if all(abs(shot.start - p.start) >= rules.min_gap_seconds for p in picked):
                picked.append(shot)
                taken += 1
    out = []
    for shot in sorted(picked, key=lambda s: s.start):
        mid = (shot.start + shot.end) / 2
        out.append((shot, round(max(shot.start, mid - rules.clip_seconds / 2), 3)))
    return out


def _hist(frame: np.ndarray) -> np.ndarray:
    q = (frame // (256 // HIST_BINS)).astype(np.int32)
    idx = (q[..., 0] * HIST_BINS + q[..., 1]) * HIST_BINS + q[..., 2]
    h = np.bincount(idx.ravel(), minlength=HIST_BINS**3).astype(np.float64)
    return h / max(np.linalg.norm(h), 1e-12)


def _correlation(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b / denom) if denom > 0 else 1.0


def letterbox_rows(luma: np.ndarray) -> int:
    """Rows of black bar at the top or bottom of a grey frame [H, W] (the smaller of the two)."""
    rows = luma.mean(axis=1)
    bright = rows > LETTERBOX_LUMA
    if not bright.any():
        return int(rows.size)
    return int(min(np.argmax(bright), np.argmax(bright[::-1])))


def laplacian_variance(luma: np.ndarray) -> float:
    """Variance of the 4-neighbour Laplacian: higher = crisper lines."""
    lap = (
        -4 * luma[1:-1, 1:-1]
        + luma[:-2, 1:-1]
        + luma[2:, 1:-1]
        + luma[1:-1, :-2]
        + luma[1:-1, 2:]
    )
    return float(lap.var())


def dhash(luma: np.ndarray) -> str:
    """128-bit difference hash (8 rows x 16 horizontal gradients) as 32 hexadecimal digits."""
    small = downsample(luma, 8, 17)
    bits = (small[:, 1:] > small[:, :-1]).ravel()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return f"{value:032x}"


def clip_stats(frames: np.ndarray, *, clear_rows: tuple[int, int]) -> dict[str, Any]:
    """Statistics of one RGB clip [N, H, W, 3]; ``clear_rows`` is the band used for sharpness."""
    luma = grey(frames)
    small = downsample(luma, 92, 160)
    diffs = frame_diffs(small)
    median = float(np.median(diffs)) if diffs.size else 0.0
    hists = [_hist(downsample_rgb(frames[i])) for i in range(frames.shape[0])]
    corr = min(
        (_correlation(hists[i - 1], hists[i]) for i in range(1, len(hists))),
        default=1.0,
    )
    jump = float(diffs.max()) if diffs.size else 0.0
    hidden_cut = corr < HIDDEN_CUT_CORR or jump > max(30.0, 6.0 * median + 8.0)
    lo, hi = clear_rows
    picks = sorted({0, frames.shape[0] // 2, frames.shape[0] - 1})
    sharp = float(np.mean([laplacian_variance(luma[i, lo:hi]) for i in picks]))
    return {
        "motion": round(median, 4),
        "max_frame_diff": round(jump, 3),
        "min_hist_corr": round(corr, 4),
        "hidden_cut": bool(hidden_cut),
        "hold_share": round(
            float((diffs < HOLD_DIFF).mean()) if diffs.size else 0.0, 4
        ),
        "sharpness": round(sharp, 2),
        "luma": round(float(small.mean()), 2),
        "letterbox_px": max(letterbox_rows(luma[i]) for i in picks),
        "dhash": dhash(luma[frames.shape[0] // 2]),
    }


def downsample_rgb(frame: np.ndarray, height: int = 92, width: int = 160) -> np.ndarray:
    """Nearest-sample RGB thumbnail (for colour histograms)."""
    ys = np.linspace(0, frame.shape[0] - 1, height).astype(np.int64)
    xs = np.linspace(0, frame.shape[1] - 1, width).astype(np.int64)
    return frame[ys][:, xs]


def static_overlays(
    samples: np.ndarray, *, width: int, height: int
) -> list[dict[str, Any]]:
    """Boxes (in ``width`` x ``height`` pixels) of overlays that stay in place across a source.

    ``samples`` are grey frames [N, h, w] in the clip geometry, spread over the whole source, so the picture changes
    between them; a channel logo or a burned-in watermark, opaque or translucent, keeps its outline. The samples are
    split into a few stretches and an outline has to persist within two of them, so a logo that moves to another
    corner once is found at both places while a still shot, which lasts through one stretch at most, is not. Lines across most of the frame (letterbox and frame
    borders) are not overlays.
    """
    n = samples.shape[0]
    if n < OVERLAY_MIN_SAMPLES:
        return []
    f = samples.astype(np.float32)
    edges = np.zeros(f.shape, dtype=bool)
    edges[:, :, 1:] |= np.abs(np.diff(f, axis=2)) > OVERLAY_EDGE
    edges[:, 1:, :] |= np.abs(np.diff(f, axis=1)) > OVERLAY_EDGE
    stretches = np.array_split(
        np.arange(n), max(1, min(OVERLAY_SEGMENTS, n // OVERLAY_MIN_SAMPLES))
    )
    held = np.zeros(f.shape[1:], dtype=np.int64)
    for idx in stretches:
        held += edges[idx].mean(axis=0) >= OVERLAY_PERSIST
    # in two stretches at least: a long still shot holds its outlines through one stretch, never through two
    persistent = held >= min(OVERLAY_MIN_STRETCHES, len(stretches))
    h, w = persistent.shape
    out = []
    for box in _components(_grow(persistent, OVERLAY_GROW)):
        y0, x0, y1, x1 = box
        bh, bw = y1 - y0, x1 - x0
        if bw > OVERLAY_MAX_SPAN * w or bh > OVERLAY_MAX_SPAN * h:
            continue
        if bh * bw > OVERLAY_MAX_SHARE * h * w:
            continue
        if int(persistent[y0:y1, x0:x1].sum()) < OVERLAY_MIN_PIXELS:
            continue
        out.append(
            {
                "region": _scaled_box(box, (h, w), (height, width), pad=OVERLAY_PAD),
                "reason": "static_overlay",
            }
        )
    return out


def fill_regions(frame: np.ndarray, regions: Sequence[Sequence[int]]) -> np.ndarray:
    """``frame`` [H, W, C] with every [x0, y0, x1, y1] box replaced by the mean colour of a ring around it.

    Used on reference stills, so a masked overlay is neither trained on nor handed to the model as a reference.
    """
    out = frame.copy()
    height, width = frame.shape[:2]
    for x0, y0, x1, y1 in regions:
        ring = 8
        rx0, ry0 = max(0, x0 - ring), max(0, y0 - ring)
        rx1, ry1 = min(width, x1 + ring), min(height, y1 + ring)
        around = np.ones((ry1 - ry0, rx1 - rx0), dtype=bool)
        around[y0 - ry0 : y1 - ry0, x0 - rx0 : x1 - rx0] = False
        patch = frame[ry0:ry1, rx0:rx1]
        colour = (
            patch[around].mean(axis=0)
            if around.any()
            else patch.reshape(-1, frame.shape[2]).mean(axis=0)
        )
        out[y0:y1, x0:x1] = colour.astype(frame.dtype)
    return out


def _grow(mask: np.ndarray, radius: int) -> np.ndarray:
    """``mask`` dilated by a (2 * radius + 1) square, so the letters of one logo join into one region."""
    h, w = mask.shape
    padded = np.pad(mask, radius)
    out = np.zeros_like(mask)
    for dy in range(2 * radius + 1):
        for dx in range(2 * radius + 1):
            out |= padded[dy : dy + h, dx : dx + w]
    return out


def _scaled_box(
    box: tuple[int, int, int, int],
    grid: tuple[int, int],
    size: tuple[int, int],
    *,
    pad: int = 1,
) -> list[int]:
    """(y0, x0, y1, x1) cells, grown by ``pad`` cells, as [x0, y0, x1, y1] pixels of ``size`` (height, width)."""
    (h, w), (height, width) = grid, size
    y0, x0 = max(0, box[0] - pad), max(0, box[1] - pad)
    y1, x1 = min(h, box[2] + pad), min(w, box[3] + pad)
    return [
        int(x0 * width / w),
        int(y0 * height / h),
        int(np.ceil(x1 * width / w)),
        int(np.ceil(y1 * height / h)),
    ]


def _components(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Bounding boxes (y0, x0, y1, x1; exclusive ends) of 8-connected True regions."""
    seen = np.zeros_like(mask, dtype=bool)
    boxes = []
    h, w = mask.shape
    for y, x in zip(*np.nonzero(mask), strict=True):
        if seen[y, x]:
            continue
        stack = [(int(y), int(x))]
        seen[y, x] = True
        y0, x0, y1, x1 = int(y), int(x), int(y) + 1, int(x) + 1
        while stack:
            cy, cx = stack.pop()
            y0, x0, y1, x1 = min(y0, cy), min(x0, cx), max(y1, cy + 1), max(x1, cx + 1)
            for ny in range(max(0, cy - 1), min(h, cy + 2)):
                for nx in range(max(0, cx - 1), min(w, cx + 2)):
                    if mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        boxes.append((y0, x0, y1, x1))
    return boxes


__all__ = [
    "Shot",
    "WindowRules",
    "clip_stats",
    "dhash",
    "fill_regions",
    "frame_diffs",
    "grey",
    "pick_windows",
    "shot_problem",
    "shot_stats",
    "static_overlays",
    "telecine_phase",
]
