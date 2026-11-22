"""Captions at the same position never overlap: the preview would stack them unreadably."""

from __future__ import annotations

from typing import Any

from phasyn_components.timeline_edit.caption_fit import fit_captions


def cap(
    cid: str, start: int, end: int, position: str = "bottom", **extra: Any
) -> dict[str, Any]:
    return {
        "caption_id": cid,
        "start_frame": start,
        "end_frame": end,
        "text": cid,
        "position": position,
        "size": "medium",
        **extra,
    }


def spans(captions: list[dict[str, Any]]) -> list[tuple[str, int, int]]:
    return [(c["caption_id"], c["start_frame"], c["end_frame"]) for c in captions]


def test_a_caption_that_runs_into_the_next_ends_where_it_starts() -> None:
    before = [cap("a", 0, 50), cap("b", 40, 80), cap("c", 70, 90)]
    assert spans(fit_captions(before)) == [("a", 0, 40), ("b", 40, 70), ("c", 70, 90)]
    assert spans(before) == [("a", 0, 50), ("b", 40, 80), ("c", 70, 90)]


def test_other_positions_may_overlap() -> None:
    assert spans(fit_captions([cap("a", 0, 50), cap("b", 10, 60, "top")])) == [
        ("a", 0, 50),
        ("b", 10, 60),
    ]


def test_two_captions_starting_together_play_one_after_the_other() -> None:
    assert spans(fit_captions([cap("a", 10, 40), cap("b", 10, 30)])) == [
        ("a", 10, 40),
        ("b", 40, 60),
    ]


def test_a_generated_caption_keeps_its_transcription_record_in_step() -> None:
    record = {
        "start_frame": 0,
        "end_frame": 50,
        "text": "a",
        "size": "medium",
        "position": "bottom",
    }
    fitted = fit_captions([cap("a", 0, 50, transcription=record), cap("b", 40, 80)])
    assert fitted[0]["end_frame"] == fitted[0]["transcription"]["end_frame"] == 40


def test_captions_without_overlap_are_unchanged() -> None:
    before = [cap("a", 0, 40), cap("b", 40, 80)]
    assert fit_captions(before) == before
