"""Data integrity boundaries of Studio's restricted Kdenlive edit import."""

from __future__ import annotations

import json
from copy import deepcopy

import pytest

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.timeline_edit.otio import export_timeline
from phasyn_components.timeline_edit.otio_edits import import_kdenlive_edits


def test_external_relink_and_split_preserve_immutable_sources_and_linked_ranges() -> (
    None
):
    fixture = (
        contracts.contracts_dir() / "examples" / "timeline-commands" / "split.json"
    )
    timeline = json.loads(fixture.read_text(encoding="utf-8"))["vectors"][0]["before"]
    for index, source in enumerate(timeline["sources"], 1):
        source["file"] = {
            "node_id": "22222222-2222-4222-8222-222222222222",
            "file_id": f"11111111-1111-4111-8111-{index:012d}",
            "size_bytes": 23,
            "sha256": str(index) * 64,
            "media_type": "video/mp4",
            "metadata": {},
        }
    before = deepcopy(timeline)
    doc = export_timeline(timeline)
    # Kdenlive exports absolute targets and does not retain Studio's clip IDs.
    changed = "/editor/relinked/original.mp4"
    for track in doc["tracks"]["children"]:
        if not track["children"]:
            continue
        row = track["children"][0]
        row["metadata"] = {}
        row["media_references"]["DEFAULT_MEDIA"]["target_url"] = changed
        row["source_range"]["duration"]["value"] = 20
        tail = deepcopy(row)
        tail["source_range"]["start_time"]["value"] = 25
        tail["source_range"]["duration"]["value"] = 23
        track["children"].insert(1, tail)
    for relinks in ({}, {changed: ("9" * 64, 23)}, {changed: ("1" * 64, 24)}):
        with pytest.raises(ComponentError, match="回剪"):
            import_kdenlive_edits(timeline, doc, relinks)
        assert timeline == before
    edited = import_kdenlive_edits(timeline, doc, {changed: ("1" * 64, 23)})
    pieces = [clip for clip in edited["clips"] if clip["source_id"] == "src-a"]
    assert len(pieces) == 4
    assert len({clip["clip_id"] for clip in pieces}) == 4
    assert len({clip["linked_id"] for clip in pieces}) == 2
    assert {
        (clip["in_frame"], clip["out_frame"], clip["start_frame"]) for clip in pieces
    } == {(0, 20, 0), (25, 48, 20)}
    assert timeline == before and edited["sources"] == before["sources"]
