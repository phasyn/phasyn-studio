"""Choose the training and evaluation clips from the extracted dataset and its review (pure, deterministic).

Rules, in order:

1. a clip the extractor rejected, the user dropped or the review has not covered is out;
2. the review must call the clip drawn animation without large on-screen text, and its caption must carry no
   identity (:mod:`.captions`);
3. per source, the softest quarter of the clips (lowest sharpness) is out when the source has at least four;
4. near-duplicates (perceptual hash distance at most :data:`DUPLICATE_BITS`) keep the sharper clip;
5. leakage: a training clip that nearly duplicates any held-out clip is removed, so evaluation never sees a
   frame the model was trained on (splits are by source video, never by clip);
6. no single source exceeds ``max_source_share`` of the training set, which holds at most ``max_clips``.

Evaluation references come only from held-out and evaluation-only sources, spread over those sources.
"""

from __future__ import annotations

import random
import statistics
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .captions import build_caption, identity_problems, review_problems
from .constants import CLIP_HEIGHT, CLIP_WIDTH


DUPLICATE_BITS = 12
_SOFT_MIN_CLIPS = 4
_TRAIN, _HELDOUT, _EVAL_ONLY = "train", "heldout", "eval_only"


@dataclass(frozen=True)
class SelectionOptions:
    """User-adjustable bounds of the selection (defaults suit a few hundred clips)."""

    max_clips: int = 220
    max_source_share: float = 0.45
    eval_count: int = 3
    seed: int = 0
    caption_prefix: str = ""
    dropped: frozenset[str] = frozenset()
    edited_captions: Mapping[str, str] = field(default_factory=dict)


def hamming(a: str, b: str) -> int:
    """Bit distance of two equal-length hexadecimal hashes."""
    return (int(a, 16) ^ int(b, 16)).bit_count()


def _soft_floor(clips: list[Mapping[str, Any]]) -> dict[str, float]:
    by_source: dict[str, list[float]] = {}
    for clip in clips:
        sharp = (clip.get("stats") or {}).get("sharpness")
        if isinstance(sharp, int | float):
            by_source.setdefault(str(clip["source_id"]), []).append(float(sharp))
    return {
        source: statistics.quantiles(values, n=4)[0]
        for source, values in by_source.items()
        if len(values) >= _SOFT_MIN_CLIPS
    }


SUBTITLE_BAND = 0.17


def _masks(clip: Mapping[str, Any], review: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The clip's static overlays plus the bottom band when the review saw subtitles."""
    masks = [dict(m) for m in clip.get("loss_masks") or []]
    if review.get("subtitles") is True:
        top = int(CLIP_HEIGHT * (1 - SUBTITLE_BAND))
        masks.append(
            {"region": [0, top, CLIP_WIDTH, CLIP_HEIGHT], "reason": "subtitles"}
        )
    return masks


def _caption_for(
    clip: Mapping[str, Any], review: Mapping[str, Any], options: SelectionOptions
) -> str:
    edited = options.edited_captions.get(str(clip["clip_id"]))
    if edited is not None and edited.strip():
        return edited.strip()
    hold = (clip.get("stats") or {}).get("hold_share")
    return build_caption(
        review,
        hold_share=float(hold) if isinstance(hold, int | float) else None,
        prefix=options.caption_prefix,
    )


def _first_problem(
    clip: Mapping[str, Any],
    review: Mapping[str, Any] | None,
    caption: str,
    options: SelectionOptions,
) -> str | None:
    if clip.get("rejected"):
        return f"technical:{clip['rejected']}"
    if str(clip["clip_id"]) in options.dropped:
        return "dropped_by_user"
    if review is None:
        return "no_review"
    problems = review_problems(review)
    if problems:
        return f"review:{problems[0]}"
    if _unplaced_logo(clip, review):
        return "logo"
    return "identity" if identity_problems(caption) else None


def _unplaced_logo(clip: Mapping[str, Any], review: Mapping[str, Any]) -> bool:
    """The reviewer saw a logo or watermark that the overlay detection did not place, so it cannot be masked."""
    return review.get("logo") is True and not any(
        m.get("reason") == "static_overlay" for m in clip.get("loss_masks") or []
    )


def _dedupe(
    items: list[dict[str, Any]], rejected: dict[str, str], reason: str
) -> list[dict[str, Any]]:
    items = sorted(
        items, key=lambda c: (-float(c.get("sharpness") or 0.0), c["clip_id"])
    )
    kept: list[dict[str, Any]] = []
    for item in items:
        if any(
            hamming(item["dhash"], other["dhash"]) <= DUPLICATE_BITS for other in kept
        ):
            rejected[item["clip_id"]] = reason
            continue
        kept.append(item)
    return kept


def _cap_sources(
    items: list[dict[str, Any]], options: SelectionOptions, rejected: dict[str, str]
) -> list[dict[str, Any]]:
    rng = random.Random(options.seed)  # noqa: S311 - a reproducible shuffle, not security
    order = sorted(items, key=lambda c: c["clip_id"])
    rng.shuffle(order)
    limit = max(1, int(options.max_source_share * options.max_clips))
    per: dict[str, int] = {}
    chosen: list[dict[str, Any]] = []
    for item in order:
        source = item["source_id"]
        if per.get(source, 0) >= limit or len(chosen) >= options.max_clips:
            rejected[item["clip_id"]] = "source_cap"
            continue
        per[source] = per.get(source, 0) + 1
        chosen.append(item)
    return sorted(chosen, key=lambda c: c["clip_id"])


def _eval_picks(items: list[dict[str, Any]], count: int) -> list[str]:
    by_source: dict[str, list[dict[str, Any]]] = {}
    for item in sorted(
        items, key=lambda c: (-float(c.get("motion") or 0.0), c["clip_id"])
    ):
        by_source.setdefault(item["source_id"], []).append(item)
    picks: list[str] = []
    while len(picks) < count and any(by_source.values()):
        for source in sorted(by_source):
            if by_source[source] and len(picks) < count:
                picks.append(by_source[source].pop(0)["clip_id"])
    return picks


def _candidates(
    dataset: Mapping[str, Any],
    reviews: Mapping[str, Any],
    options: SelectionOptions,
    rejected: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    clips = [dict(c) for c in dataset.get("clips") or []]
    floor = _soft_floor([c for c in clips if not c.get("rejected")])
    train: list[dict[str, Any]] = []
    held: list[dict[str, Any]] = []
    for clip in clips:
        cid = str(clip["clip_id"])
        review = reviews.get(cid)
        caption = _caption_for(clip, review or {}, options)
        problem = _first_problem(clip, review, caption, options)
        stats = clip.get("stats") or {}
        sharp = float(stats.get("sharpness") or 0.0)
        source = str(clip["source_id"])
        if (
            problem is None
            and clip.get("role") == _TRAIN
            and sharp < floor.get(source, 0.0)
        ):
            problem = "soft"
        if problem is not None:
            rejected[cid] = problem
            continue
        item = {
            "clip_id": cid,
            "source_id": source,
            "role": clip.get("role"),
            "caption": caption,
            "loss_masks": _masks(clip, review or {}),
            "dhash": str(clip.get("dhash") or "0"),
            "sharpness": sharp,
            "motion": float(stats.get("motion") or 0.0),
        }
        (train if clip.get("role") == _TRAIN else held).append(item)
    return train, held


def select(
    dataset: Mapping[str, Any], reviews: Mapping[str, Any], options: SelectionOptions
) -> dict[str, Any]:
    """The frozen selection document the encode and training phases read."""
    rejected: dict[str, str] = {}
    train, held = _candidates(dataset, reviews, options, rejected)
    train = _dedupe(train, rejected, "duplicate")
    held = _dedupe(held, rejected, "duplicate")
    leaks = [
        t["clip_id"]
        for t in train
        if any(hamming(t["dhash"], h["dhash"]) <= DUPLICATE_BITS for h in held)
    ]
    for cid in leaks:
        rejected[cid] = "leak"
    train = [t for t in train if t["clip_id"] not in set(leaks)]
    train = _cap_sources(train, options, rejected)
    picks = _eval_picks(held, options.eval_count)
    return {
        "train": [_public(t) for t in train],
        "heldout": [_public(h) for h in held],
        "eval": picks,
        "rejected": dict(sorted(rejected.items())),
        "stats": _stats(train, held, rejected),
        "leakage": {
            "removed": sorted(leaks),
            "threshold_bits": DUPLICATE_BITS,
            "split": "source_video",
        },
    }


def _public(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: item[key]
        for key in ("clip_id", "source_id", "role", "caption", "loss_masks")
    }


def _count(values: Iterable[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for value in values:
        out[value] = out.get(value, 0) + 1
    return dict(sorted(out.items()))


def _stats(
    train: list[dict[str, Any]], held: list[dict[str, Any]], rejected: dict[str, str]
) -> dict[str, Any]:
    return {
        "train_clips": len(train),
        "heldout_clips": len(held),
        "train_by_source": _count(t["source_id"] for t in train),
        "heldout_by_source": _count(h["source_id"] for h in held),
        "rejected_by_reason": _count(
            reason.split(":", 1)[0] for reason in rejected.values()
        ),
        "masked_clips": sum(1 for t in train if t["loss_masks"]),
    }


__all__ = ["DUPLICATE_BITS", "SelectionOptions", "hamming", "select"]
