"""Data integrity of the timeline, the single edit state of a Studio project.

Table-driven over the shared vectors in ``contracts/examples``: every timeline command gives exactly the document
its vectors state or is refused with the stated reason and changes nothing; normalization migrates shot-level edits
without losing one, places a shot once, and never shortens an edit for a new take; and the facts clients derive from
the timeline (film order, the previous shot of a continuity) are the stated ones.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from typing import Any

import pytest

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.timeline import validate_timeline
from phasyn_components.timeline_edit import (
    Exporter,
    TimelineRejected,
    apply_command,
    apply_commands,
    continuity_frame,
    export_request,
    film_order,
    normalize_project,
    previous_shot,
)
from phasyn_components.timeline_edit.commands import COMMAND_DEFS, execute_command
from phasyn_components.timeline_edit.export import render_snapshot
from phasyn_components.timeline_edit.model import (
    clip_end,
    source_frame_at,
    timeline_duration,
)
from phasyn_components.timeline_edit.text import js_number, title_key


EXAMPLES = contracts.contracts_dir() / "examples"
REASONS = set(
    contracts.definition("StudioTimelineRejection")["properties"]["reason"]["enum"]
)
BASE_PROJECT: dict[str, Any] = {
    "project_id": "vector", "title": "Vector", "revision": 1, "created_at": "2026-11-01T00:00:00.000Z",
    "updated_at": "2026-11-01T00:00:00.000Z", "format": {"width": 768, "height": 448, "fps": {"num": 24, "den": 1}},
    "defaults": {"frames": 124, "route": "route-a", "steps": None}, "shots": [], "exports": [],
}  # fmt: skip


def load(directory: str, name: str) -> dict[str, Any]:
    document: dict[str, Any] = json.loads(
        (EXAMPLES / directory / name).read_text(encoding="utf-8")
    )
    return document


def command_vectors() -> list[Any]:
    return [
        pytest.param(vector, id=f"{path.stem}: {vector['name']}")
        for path in sorted((EXAMPLES / "timeline-commands").glob("*.json"))
        for vector in load("timeline-commands", path.name)["vectors"]
    ]


def vectors(directory: str, name: str) -> list[Any]:
    return [
        pytest.param(vector, id=vector["name"])
        for vector in load(directory, name)["vectors"]
    ]


def counting() -> Callable[[str], str]:
    """The allocator the vectors are written for: ``<prefix>-<n>``, counting from 1."""
    serial = 0

    def allocate(prefix: str) -> str:
        nonlocal serial
        serial += 1
        return f"{prefix}-{serial}"

    return allocate


def difference(a: Any, b: Any, path: str = "") -> str | None:
    """Where two JSON values differ (numbers within 1e-9, object key order ignored); None when they are equal."""
    if isinstance(a, dict) and isinstance(b, dict):
        return _dict_difference(a, b, path)
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path}: {len(a)} items vs {len(b)}"
        return next(
            (
                found
                for i, pair in enumerate(zip(a, b, strict=True))
                if (found := difference(*pair, f"{path}[{i}]"))
            ),
            None,
        )
    if (
        isinstance(a, bool)
        or isinstance(b, bool)
        or not isinstance(a, int | float)
        or not isinstance(b, int | float)
    ):
        return None if a == b and type(a) is type(b) else f"{path}: {a!r} vs {b!r}"
    return None if abs(a - b) <= 1e-9 else f"{path}: {a!r} vs {b!r}"


def _dict_difference(a: dict[str, Any], b: dict[str, Any], path: str) -> str | None:
    for key in sorted(set(a) | set(b)):
        if key not in a or key not in b:
            return f"{path}.{key}: only on one side"
        found = difference(a[key], b[key], f"{path}.{key}")
        if found:
            return found
    return None


def project_of(vector: dict[str, Any]) -> dict[str, Any]:
    return {
        **BASE_PROJECT,
        **copy.deepcopy(vector.get("project") or {}),
        "timeline": copy.deepcopy(vector["before"]),
    }


@pytest.mark.parametrize("vector", command_vectors())
def test_a_command_gives_its_vector_or_is_refused_and_changes_nothing(
    vector: dict[str, Any],
) -> None:
    validate_timeline(vector["before"])
    project = project_of(vector)
    untouched = copy.deepcopy(project)
    command = vector["command"]
    assets = (
        {
            (command["run_id"], command["output_key"], command["op"]): vector[
                "published_media"
            ]
        }
        if "published_media" in vector
        else {}
    )
    if "reject_reason" in vector:
        assert vector["reject_reason"] in REASONS
        with pytest.raises(TimelineRejected) as refused:
            execute_command(project, command, counting(), assets)
        assert refused.value.reason == vector["reject_reason"], refused.value.message
    else:
        result, _ = execute_command(project, command, counting(), assets)
        assert difference(result["timeline"], vector["after"]) is None
        validate_timeline(result["timeline"])
        expected = {key: value for key, value in untouched.items() if key != "timeline"}
        if "after_library" in vector:
            expected["library"] = vector["after_library"]
        assert {
            key: value for key, value in result.items() if key != "timeline"
        } == expected
    assert project == untouched  # the caller's document is never edited in place


def test_every_command_has_accepting_and_refusing_vectors() -> None:
    files = {
        path.stem.replace("-", "_"): path.name
        for path in (EXAMPLES / "timeline-commands").glob("*.json")
    }
    assert set(files) == set(COMMAND_DEFS)
    for op, name in files.items():
        document = load("timeline-commands", name)
        assert document["op"] == op and all(
            vector["command"]["op"] == op for vector in document["vectors"]
        )
        accepted = sum("after" in vector for vector in document["vectors"])
        assert accepted >= 3 and len(document["vectors"]) - accepted >= 2, op


def test_a_refused_command_of_a_batch_names_itself_and_nothing_of_the_batch_is_kept() -> (
    None
):
    vector = load("timeline-commands", "split.json")["vectors"][0]
    project = project_of(vector)
    untouched = copy.deepcopy(project)
    batch = [
        vector["command"],
        {"op": "remove", "clip_ids": ["nope"]},
        {"op": "master", "gain_db": -6},
    ]
    with pytest.raises(ComponentError) as refused:
        apply_commands(project, batch, counting())
    error = refused.value
    assert (error.code, error.status) == ("STUDIO_TIMELINE_REJECTED", 422)
    assert (
        error.details["command_index"] == 1
        and error.details["reason"] == "clip_not_found"
    )
    assert project == untouched
    with pytest.raises(ComponentError) as malformed:
        apply_commands(project, [{"op": "explode"}], counting())
    assert malformed.value.details == {
        "reason": "invalid_command",
        "supported": sorted(COMMAND_DEFS),
        "command_index": 0,
    }
    saved, applied = apply_commands(project, [batch[0], batch[2]], counting())
    assert [item["op"] for item in applied] == ["split", "master"] and saved[
        "timeline"
    ]["master_gain_db"] == -6
    for item in applied:
        contracts.validate("StudioTimelineApplied", item)
    assert normalize_project(saved) == saved


@pytest.mark.parametrize("vector", vectors("timeline-normalize", "normalize.json"))
def test_normalization_loses_no_edit_and_is_idempotent(vector: dict[str, Any]) -> None:
    before = copy.deepcopy(vector["before"])
    contracts.validate("StudioProject", before)
    result = normalize_project(before)
    assert before == vector["before"]
    assert difference(result, vector["after"]) is None
    contracts.validate("StudioProject", result)
    validate_timeline(result["timeline"])
    assert normalize_project(result) == result
    levels = vector.get("audio_level_db")
    if levels:
        legacy = {
            shot["shot_id"]: (shot.get("effects") or {}).get("volume_db", 0)
            for shot in before["shots"]
        }
        assert {shot_id: legacy[shot_id] for shot_id in levels["legacy"]} == levels[
            "legacy"
        ]
        clips = {clip["clip_id"]: clip for clip in result["timeline"]["clips"]}
        after = {
            clip_id: clips[clip_id]["motion"]["gain_db"]
            + (clips[clip_id].get("effects") or {}).get("volume_db", 0)
            for clip_id in levels["after"]
        }
        assert after == levels["after"] and sorted(after.values()) == sorted(
            levels["legacy"].values()
        )


def test_a_whole_take_clip_never_follows_past_a_lock_or_an_edit() -> None:
    """The follow rule changes nothing when its ripple is refused or the clip carries a timed edit."""
    documents = load("timeline-normalize", "normalize.json")["vectors"]
    follow = next(item for item in documents if "follow" in item["name"])
    # A locked sound track: neither the placeholder's clips nor the clips of the shorter take may move
    locked = copy.deepcopy(follow["before"])
    for track in locked["timeline"]["tracks"]:
        track["locked"] = track["locked"] or track["track_id"] == "audio-1"
    result = normalize_project(locked)["timeline"]
    assert result["clips"] == locked["timeline"]["clips"]
    waiting, shorter = result["sources"][1], result["sources"][2]
    assert (waiting["file"], waiting["duration_frames"]) == (None, 124)
    assert (
        shorter["take_id"],
        shorter["duration_frames"],
        shorter["pending_take_id"],
    ) == ("w1", 124, "w2")
    validate_timeline(result)
    # A fade is timed against the clip's length: the clip is an edit and waits for the user
    faded = copy.deepcopy(follow["before"])
    picture = next(
        clip
        for clip in faded["timeline"]["clips"]
        if clip["start_frame"] == 248 and clip["track_id"] == "video-1"
    )
    picture["effects"] = {"fade": {"video_out": 12}}
    result = normalize_project(faded)["timeline"]
    assert [clip for clip in result["clips"] if clip["start_frame"] >= 299] == [
        {**clip, "start_frame": clip["start_frame"] + 51}
        for clip in faded["timeline"]["clips"]
        if clip["start_frame"] == 248
    ]
    assert result["sources"][2]["pending_take_id"] == "w2"
    assert normalize_project(normalize_project(faded)) == normalize_project(faded)
    # A fade or a hold of 0 frames says nothing (a value that was set back leaves it): the clip still follows
    leftover = copy.deepcopy(follow["before"])
    picture = next(
        clip
        for clip in leftover["timeline"]["clips"]
        if clip["start_frame"] == 248 and clip["track_id"] == "video-1"
    )
    picture["effects"] = {"fade": {}, "hold": {"start": 0, "end": 0}}
    result = normalize_project(leftover)["timeline"]
    placed = [
        (clip["clip_id"], clip["start_frame"], clip["out_frame"])
        for clip in result["clips"]
    ]
    assert placed == [
        (clip["clip_id"], clip["start_frame"], clip["out_frame"])
        for clip in follow["after"]["timeline"]["clips"]
    ]
    assert "pending_take_id" not in result["sources"][2]


def _follow_vector() -> dict[str, Any]:
    documents = load("timeline-normalize", "normalize.json")["vectors"]
    project: dict[str, Any] = copy.deepcopy(
        next(item for item in documents if "follow" in item["name"])["before"]
    )
    return project


def test_following_a_take_never_cuts_a_caption_moves_a_marker_or_a_clip_that_began_earlier() -> (
    None
):
    """A re-fit only moves clips. What it would do to captions and markers needs the user's own edit."""
    # A caption over the frames a shorter take removes: the take waits and the caption stays
    captioned = _follow_vector()
    captioned["timeline"]["captions"] = [
        {
            "caption_id": "c1",
            "start_frame": 360,
            "end_frame": 372,
            "text": "tail",
            "position": "bottom",
            "size": "small",
        }
    ]
    captioned["timeline"]["markers"] = [
        {"marker_id": "m1", "frame": 365, "name": "hit", "color": "blue"}
    ]
    result = normalize_project(captioned)["timeline"]
    # Both moved 51 frames with the clip they sit on, because the placeholder before it grew; neither was cut
    assert [
        (item["start_frame"], item["end_frame"]) for item in result["captions"]
    ] == [(411, 423)]
    assert [item["frame"] for item in result["markers"]] == [416]
    assert result["sources"][2]["pending_take_id"] == "w2"
    assert [
        clip["out_frame"]
        for clip in result["clips"]
        if clip["source_id"] == result["sources"][2]["source_id"]
    ] == [
        124,
        124,
    ]
    # A music bed that began before the edit and lies across it (another sync-locked track) stays where it is
    scored = _follow_vector()
    bed_file = {
        **scored["timeline"]["sources"][0]["file"],
        "file_id": "00000000-0000-4000-8000-000000000066",
    }
    scored["timeline"]["sources"].append(
        {
            "source_id": "music",
            "name": "Music",
            "kind": "audio",
            "file": bed_file,
            "duration_frames": 2000,
            "width": 0,
            "height": 0,
            "has_audio": True,
        }
    )
    scored["timeline"]["clips"].append(
        {
            "clip_id": "bed",
            "source_id": "music",
            "track_id": "audio-2",
            "name": "Music",
            "start_frame": 100,
            "in_frame": 0,
            "out_frame": 400,
            "motion": {
                "x": 0,
                "y": 0,
                "scale": 1,
                "rotation": 0,
                "opacity": 1,
                "gain_db": 0,
                "pan": 0,
                "keyframes": {},
            },
        }
    )
    validate_timeline(scored["timeline"])
    result = normalize_project(scored)["timeline"]
    validate_timeline(result)
    spans = {
        clip["clip_id"]: (clip["start_frame"], clip["out_frame"])
        for clip in result["clips"]
    }
    assert spans["bed"] == (100, 400)
    assert [span for clip_id, span in spans.items() if clip_id != "bed"] == [
        (0, 124),
        (0, 124),
        (124, 175),
        (124, 175),
        (299, 100),
        (299, 100),
    ]


def test_following_a_take_is_idempotent_and_remembers_which_clips_were_cut() -> None:
    """What "shows the whole take" means is read from the clip, so a cut that equals a length must stay a cut."""
    # A proxy of the old media does not keep the clips from following; it goes with the old media
    proxied = _follow_vector()
    old = proxied["timeline"]["sources"][2]
    proxy_file = {**old["file"], "file_id": "00000000-0000-4000-8000-000000000077"}
    old.pop("proxy_error")
    old["proxy"] = {
        "asset_id": "00000000-0000-4000-8000-000000000078",
        "kind": "final",
        "file": proxy_file,
        "source_latent": None,
        "frame_count": 124,
        "fps": {"num": 24, "den": 1},
        "width": 384,
        "height": 224,
        "complete": True,
        "actual_settings": {},
    }
    old["proxy_source_sha256"] = old["file"]["sha256"]
    validate_timeline(proxied["timeline"])
    result = normalize_project(proxied)["timeline"]
    bound = result["sources"][2]
    assert (bound["take_id"], bound["duration_frames"], "proxy" in bound) == (
        "w2",
        100,
        False,
    )
    assert [
        clip["out_frame"]
        for clip in result["clips"]
        if clip["source_id"] == bound["source_id"]
    ] == [100, 100]

    # A placeholder whose plan drops below a cut clip stays as it is, on every pass
    planned = _follow_vector()
    planned["shots"][1]["frames"] = 107
    planned["timeline"]["sources"][1]["duration_frames"] = 141
    once = normalize_project(planned)
    waiting = once["timeline"]["sources"][1]
    assert (waiting["file"], waiting["duration_frames"]) == (None, 141)
    assert [
        clip["out_frame"]
        for clip in once["timeline"]["clips"]
        if clip["source_id"] == waiting["source_id"]
    ] == [
        124,
        124,
    ]
    assert normalize_project(once) == once

    # A clip cut to 100 frames, a take of exactly 100 frames, then the 124-frame take again: the cut is still 100
    cut = _follow_vector()
    third = cut["timeline"]["sources"][2]["source_id"]
    for clip in cut["timeline"]["clips"]:
        if clip["source_id"] == third:
            clip["out_frame"] = 100
    short = normalize_project(cut)
    assert short["timeline"]["sources"][2]["take_id"] == "w2"
    short["shots"][2]["active_take_id"] = "w1"
    back = normalize_project(short)["timeline"]
    assert (back["sources"][2]["take_id"], back["sources"][2]["duration_frames"]) == (
        "w1",
        124,
    )
    assert [
        clip["out_frame"] for clip in back["clips"] if clip["source_id"] == third
    ] == [100, 100]
    validate_timeline(back)


def test_a_longer_take_whose_clips_cannot_follow_is_bound_and_named_in_a_note() -> None:
    locked = _follow_vector()
    locked["shots"][2]["takes"][1]["frames"] = 141
    locked["shots"][2]["takes"][1]["asset"]["frame_count"] = 141
    for track in locked["timeline"]["tracks"]:
        track["locked"] = track["locked"] or track["track_id"] == "audio-1"
    result = normalize_project(locked)
    bound = result["timeline"]["sources"][2]
    assert (bound["take_id"], bound["duration_frames"]) == ("w2", 141)
    assert [
        clip["out_frame"]
        for clip in result["timeline"]["clips"]
        if clip["source_id"] == bound["source_id"]
    ] == [
        124,
        124,
    ]
    assert (
        len(result["timeline"]["migration_notes"]) == 1
        and "S3" in result["timeline"]["migration_notes"][0]
    )
    assert normalize_project(result) == result


def test_a_shot_is_placed_once_and_a_removed_shot_stays_out() -> None:
    vector = load("timeline-normalize", "normalize.json")["vectors"][1]
    placed = normalize_project(vector["before"])
    waiting = next(
        source
        for source in placed["timeline"]["sources"]
        if source.get("shot_id") == "s2"
    )
    ids = [
        clip["clip_id"]
        for clip in placed["timeline"]["clips"]
        if clip["source_id"] == waiting["source_id"]
    ]
    removed, _applied = apply_commands(
        placed, [{"op": "remove", "clip_ids": ids, "ripple": True}], counting()
    )
    shots = {shot["shot_id"]: shot["enabled"] for shot in removed["shots"]}
    assert shots == {"s1": True, "s2": False, "s3": False} and removed["timeline"][
        "placed_shot_ids"
    ] == ["s1", "s2"]
    again = copy.deepcopy(removed)
    again["shots"][1]["enabled"] = (
        True  # an older client asking for the shot's place again
    )
    assert normalize_project(again) == removed
    # A shot deleted from the project may leave its source behind: the document stays valid, the listing is cleaned.
    orphaned = {
        **placed,
        "shots": [shot for shot in placed["shots"] if shot["shot_id"] != "s2"],
    }
    cleaned = normalize_project(orphaned)
    contracts.validate("StudioProject", cleaned)
    validate_timeline(cleaned["timeline"])
    assert (
        cleaned["timeline"]["placed_shot_ids"] == ["s1"]
        and len(cleaned["timeline"]["clips"]) == 4
    )
    assert any(
        source.get("shot_id") == "s2" for source in cleaned["timeline"]["sources"]
    )


def test_a_legacy_value_the_timeline_cannot_hold_is_clamped_and_noted_instead_of_failing_the_project() -> (
    None
):
    document = copy.deepcopy(
        load("timeline-normalize", "normalize.json")["vectors"][0]["before"]
    )
    first, second = document["shots"][0], document["shots"][1]
    first.update(in_frame=100, out_frame=110)  # ten frames
    first["effects"] = {
        "fade": {"video_in": 8, "video_out": 8, "audio_in": 30},
        "impact": {"frames": 12, "style": "white"},
        "title": {
            "text": "T",
            "position": "bottom",
            "size": "medium",
            "start_frame": 50,
            "end_frame": 60,
            "image": None,
        },
        "transition_out": {"kind": "crossfade", "frames": 40},
    }
    second["effects"] = {}
    result = normalize_project(document)
    contracts.validate("StudioProject", result)
    validate_timeline(result["timeline"])
    video, audio = result["timeline"]["clips"][0], result["timeline"]["clips"][1]
    assert video["effects"]["fade"] == {"video_in": 5, "video_out": 5} and audio[
        "effects"
    ]["fade"] == {"audio_in": 10}
    assert video["effects"]["impact"]["frames"] == 10
    assert (
        video["effects"]["title"]["start_frame"],
        video["effects"]["title"]["end_frame"],
    ) == (9, None)
    assert video["effects"]["transition_out"] == {"kind": "crossfade", "frames": 10}
    assert (
        result["timeline"]["clips"][2]["start_frame"] == 0
    )  # the next clip overlaps the whole ten frames
    notes = result["timeline"]["migration_notes"]
    assert len(notes) == 6 and all(
        "「S1」" in note or "「S3」" in note for note in notes
    )
    assert normalize_project(result) == result


def test_a_character_swap_project_keeps_the_source_videos_sound_and_later_shot_edits_are_noted() -> (
    None
):
    document = copy.deepcopy(
        load("timeline-normalize", "normalize.json")["vectors"][0]["before"]
    )
    document["shots"] = document["shots"][:2]
    document["shots"][0].update(
        in_frame=0,
        out_frame=None,
        effects={
            "volume_db": -3,
            "transition_out": {"kind": "crossfade", "frames": 12},
        },
    )
    document["shots"][1].pop("effects")
    job = {
        "v": 1,
        "fps": 24,
        "start_frame": 48,
        "end_frame": 300,
        "max_frames": 124,
        "crossfade_frames": 12,
        "audio": "original",
    }
    video = {
        "item_id": "lib1", "kind": "video", "name": "LIB1", "file": document["shots"][0]["takes"][0]["asset"]["file"],
        "created_at": "2026-11-01T00:00:00.000Z", "duration_seconds": 20.0, "width": 768, "height": 448, "has_audio": True,
        "note": "source video\nswap.v1 " + json.dumps(job),
    }  # fmt: skip
    document["library"] = [video]
    result = normalize_project(document)
    contracts.validate("StudioProject", result)
    validate_timeline(result["timeline"])
    picture = [
        clip for clip in result["timeline"]["clips"] if clip["track_id"] == "video-1"
    ]
    sound = [
        clip for clip in result["timeline"]["clips"] if clip["track_id"] == "audio-1"
    ]
    assert [(clip["start_frame"], "linked_id" in clip) for clip in picture] == [
        (0, False),
        (112, False),
    ]
    assert len(sound) == 1 and sound[0]["clip_id"].startswith("original-media-")
    assert (
        sound[0]["start_frame"],
        sound[0]["in_frame"],
        sound[0]["out_frame"],
        sound[0]["name"],
    ) == (
        0,
        48,
        284,
        "原影片音軌（LIB1）",
    )
    assert (
        len(result["timeline"]["migration_notes"]) == 1
        and "「S1」" in result["timeline"]["migration_notes"][0]
    )
    assert normalize_project(result) == result

    silent = copy.deepcopy(document)
    silent["library"][0]["has_audio"] = False
    own = normalize_project(silent)
    validate_timeline(own["timeline"])
    audio = [clip for clip in own["timeline"]["clips"] if clip["track_id"] == "audio-1"]
    assert [
        (clip["start_frame"], clip["motion"]["gain_db"], "linked_id" in clip)
        for clip in audio
    ] == [
        (0, -3, True),
        (112, 0, True),
    ]
    assert len(own["timeline"]["migration_notes"]) == 1

    # A shot-level trim or effect that arrives once the timeline exists is not an edit any more: it is dropped and said so.
    late = copy.deepcopy(own)
    late["timeline"].pop("migration_notes")
    late["shots"][0].update(in_frame=5, effects={"mute": True})
    noted = normalize_project(late)
    assert noted["timeline"]["clips"] == own["timeline"]["clips"]
    assert (noted["shots"][0]["in_frame"], "effects" in noted["shots"][0]) == (0, False)
    assert len(noted["timeline"]["migration_notes"]) == 1 and noted["timeline"][
        "migration_notes"
    ][0].startswith("1 個鏡頭")
    assert normalize_project(noted) == noted


def test_a_project_the_timeline_cannot_represent_is_left_alone() -> None:
    document = copy.deepcopy(
        load("timeline-normalize", "normalize.json")["vectors"][0]["before"]
    )
    document["format"]["fps"] = {"num": 1, "den": 2}
    assert normalize_project(document) == document
    assert normalize_project({**BASE_PROJECT}) == BASE_PROJECT


@pytest.mark.parametrize("vector", vectors("timeline-derived", "film-order.json"))
def test_film_order(vector: dict[str, Any]) -> None:
    validate_timeline(vector["timeline"])
    assert film_order(vector["shot_ids"], vector["timeline"]) == vector["expected"]


@pytest.mark.parametrize("vector", vectors("timeline-derived", "previous-shot.json"))
def test_previous_shot(vector: dict[str, Any]) -> None:
    validate_timeline(vector["timeline"])
    assert (
        previous_shot(vector["shot_ids"], vector["timeline"], vector["shot_id"])
        == vector["expected"]
    )


@pytest.mark.parametrize("vector", vectors("timeline-derived", "continuity-frame.json"))
def test_continuity_frame(vector: dict[str, Any]) -> None:
    found = continuity_frame(
        vector["last_source_frame"],
        vector["fps"],
        vector["take"],
        vector["planned_frames"],
    )
    assert found == vector["expected"]


def exported(
    project: dict[str, Any], exporter: Exporter, **options: Any
) -> dict[str, Any]:
    return export_request(
        project, {"revision": project["revision"], **options}, exporter
    )


def test_export_is_refused_rather_than_rendered_without_its_text_or_media() -> None:
    vector = load("timeline-commands", "add-text.json")["vectors"][0]
    project = {**BASE_PROJECT, "timeline": copy.deepcopy(vector["after"])}
    for source in project["timeline"]["sources"]:
        if source["kind"] != "text":
            source["file"] = {
                "node_id": "00000000-0000-4000-8000-0000000000a1", "file_id": "00000000-0000-4000-8000-000000000001",
                "size_bytes": 1, "sha256": "0" * 64, "media_type": "video/mp4", "metadata": {},
            }  # fmt: skip
    old = Exporter("00000000-0000-4000-8000-0000000000a1", "concat")
    current = Exporter.of(
        {
            "node_id": old.node_id,
            "component_id": "concat",
            "facts": {"timeline_export": {"version": 2, "text": True}},
        }
    )
    assert (current.version, current.text) == (2, True) and (old.version, old.text) == (
        1,
        False,
    )
    with pytest.raises(TimelineRejected) as missing:
        exported(project, old)
    assert missing.value.reason == "text_not_rasterized"

    drawn = exported(project, current, range="full")
    contracts.validate("RunRequest", drawn["body"])
    sent = drawn["body"]["inputs"]["sequence"]["value"]
    assert (
        sent["timeline"]["version"] == 2 and "placed_shot_ids" not in sent["timeline"]
    )
    assert any(source["kind"] == "text" for source in sent["timeline"]["sources"])
    assert (sent["width"], sent["height"], "fit" in sent) == (768, 448, False)
    assert drawn["body"]["pipeline"]["outputs"] == {
        "final": {"from_step": "concat", "output": "asset"}
    }

    # With a current image of its text, the same timeline goes to an older exporter as version 1 with image clips.
    title = next(
        clip
        for clip in project["timeline"]["clips"]
        if (clip.get("effects") or {}).get("title")
    )
    text = title["effects"]["title"]
    text["image"] = {
        **project["timeline"]["sources"][0]["file"],
        "media_type": "image/png",
    }
    text["image_key"] = title_key(text, 1280, 720)
    with pytest.raises(TimelineRejected) as stale:  # made for another output size
        exported(project, old)
    assert stale.value.reason == "text_not_rasterized"
    disabled, _ = apply_commands(
        project,
        [{"op": "set_enabled", "clip_ids": ["v2"], "enabled": False}],
        counting(),
    )
    plan = exported(
        disabled,
        old,
        size="720p",
        fit="fit",
        quality="small",
        speed="veryfast",
        audio_kbps=128,
    )
    contracts.validate("RunRequest", plan["body"])
    value = plan["body"]["inputs"]["sequence"]["value"]
    assert (value["width"], value["height"], value["fit"]) == (1280, 720, "contain")
    assert value["timeline"]["version"] == 1 and all(
        "enabled" not in clip for clip in value["timeline"]["clips"]
    )
    assert {clip["clip_id"] for clip in value["timeline"]["clips"]} == {
        "v1",
        "a1",
        "clip-2",
    }
    assert [source["kind"] for source in value["timeline"]["sources"]] == [
        "video",
        "image",
    ]
    assert plan["body"]["pipeline"]["steps"][0]["parameters"] == {
        "crf": 28,
        "preset": "veryfast",
        "audio_bitrate": 128000,
    }

    waiting = copy.deepcopy(project)
    waiting["timeline"]["sources"][0]["file"] = None
    with pytest.raises(TimelineRejected) as unrendered:
        exported(waiting, current)
    assert unrendered.value.reason == "not_rendered"
    with pytest.raises(TimelineRejected) as no_range:
        exported(project, current, range="work_area")
    assert no_range.value.reason == "work_area"
    with pytest.raises(TimelineRejected) as empty:
        exported({**BASE_PROJECT}, current)
    assert empty.value.reason == "empty_timeline"


MOTION: dict[str, Any] = {
    "x": 0,
    "y": 0,
    "scale": 1,
    "rotation": 0,
    "opacity": 1,
    "gain_db": 0,
    "pan": 0,
    "keyframes": {},
}
# How the clips on both sides of the cut at frame 48 show their sources: (v1, v2) in/out, window and effects.
CUT_SITUATIONS: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
    "whole takes, no handles": (
        {"source_id": "take-a", "in_frame": 0, "out_frame": 48},
        {"source_id": "take-b", "in_frame": 0, "out_frame": 48},
    ),
    "handles on both sides": (
        {"in_frame": 100, "out_frame": 148},
        {"in_frame": 100, "out_frame": 148},
    ),
    "a few handle frames": (
        {"in_frame": 188, "out_frame": 236},
        {"in_frame": 2, "out_frame": 50},
    ),
    "hidden output first": (
        {
            "in_frame": 0,
            "out_frame": 52,
            "output_window": {"start_frame": 0, "end_frame": 48},
        },
        {
            "in_frame": 30,
            "out_frame": 90,
            "output_window": {"start_frame": 3, "end_frame": 60},
        },
    ),
    "speed, frame step and holds": (
        {"in_frame": 0, "out_frame": 60, "effects": {"speed_percent": 125}},
        {
            "in_frame": 100,
            "out_frame": 146,
            "effects": {"frame_step": 2, "hold": {"start": 2}},
        },
    ),
}


def cut_film(situation: str) -> dict[str, Any]:
    """v1 and v2 meet at frame 48 on V1 with their sound on A1, v3 follows; a song on A2 runs across every cut."""
    left, right = CUT_SITUATIONS[situation]

    def clip(
        clip_id: str,
        source: str,
        track: str,
        window: tuple[int, dict[str, Any]],
        link: str,
    ) -> dict[str, Any]:
        start, shape = window
        return {
            "clip_id": clip_id, "source_id": source, "track_id": track, "name": clip_id, "start_frame": start,
            "linked_id": link, "motion": copy.deepcopy(MOTION), **copy.deepcopy(shape),
        }  # fmt: skip

    def track(track_id: str, kind: str) -> dict[str, Any]:
        return {
            "track_id": track_id, "kind": kind, "name": track_id, "locked": False, "muted": False, "solo": False,
            "sync_lock": True, "gain_db": 0, "pan": 0,
        }  # fmt: skip

    def source(source_id: str, frames: int, kind: str = "video") -> dict[str, Any]:
        return {
            "source_id": source_id, "name": source_id, "kind": kind, "file": None, "duration_frames": frames,
            "width": 64, "height": 32, "has_audio": True,
        }  # fmt: skip

    timeline: dict[str, Any] = {
        "version": 2, "fps": {"num": 24, "den": 1}, "master_gain_db": 0, "placed_shot_ids": [],
        "sources": [
            source("src-a", 240), source("src-b", 240), source("take-a", 48), source("take-b", 48),
            source("song", 2400, "audio"),
        ],
        "tracks": [track("video-1", "video"), track("audio-1", "audio"), track("audio-2", "audio")],
        "clips": [], "markers": [{"marker_id": "m1", "frame": 50, "name": "Hit", "color": "blue"}],
        "captions": [{"caption_id": "c1", "start_frame": 40, "end_frame": 56, "text": "Across", "position": "bottom", "size": "small"}],
    }  # fmt: skip
    for kind in ("video", "audio"):
        timeline["clips"] += [
            clip(f"{kind[0]}1", "src-a", f"{kind}-1", (0, left), "l1"),
            clip(f"{kind[0]}2", "src-b", f"{kind}-1", (48, right), "l2"),
        ]
    v2 = next(item for item in timeline["clips"] if item["clip_id"] == "v2")
    for kind in ("video", "audio"):
        shape = {"in_frame": 200, "out_frame": 224}
        timeline["clips"].append(
            clip(f"{kind[0]}3", "src-a", f"{kind}-1", (clip_end(v2), shape), "l3")
        )
    timeline["clips"].append(
        clip("song", "song", "audio-2", (0, {"in_frame": 0, "out_frame": 600}), "song")
    )
    assert (
        clip_end(next(item for item in timeline["clips"] if item["clip_id"] == "v1"))
        == 48
    )
    validate_timeline(timeline)
    return timeline


def transitioned(timeline: dict[str, Any], **command: Any) -> dict[str, Any]:
    project = {**BASE_PROJECT, "timeline": copy.deepcopy(timeline)}
    result: dict[str, Any] = apply_command(
        project, {"op": "transition", "clip_id": "v1", **command}, counting()
    )["timeline"]
    validate_timeline(result)
    return result


def shown(timeline: dict[str, Any], clip_id: str, frames: range) -> list[int]:
    clip = next(item for item in timeline["clips"] if item["clip_id"] == clip_id)
    return [source_frame_at(clip, frame) for frame in frames]


@pytest.mark.parametrize("situation", list(CUT_SITUATIONS))
@pytest.mark.parametrize("frames", [1, 7, 12])
@pytest.mark.parametrize("alignment", ["center", "start", "end"])
def test_a_transition_takes_only_frames_beyond_the_cut_and_gives_them_back_exactly(
    situation: str, frames: int, alignment: str
) -> None:
    original = cut_film(situation)
    result = transitioned(
        original, kind="crossfade", frames=frames, alignment=alignment
    )
    old, new = (
        {clip["clip_id"]: clip for clip in doc["clips"]} for doc in (original, result)
    )
    # Nothing but the two clips at the cut and their linked sound changes: no clip moves, the length stays.
    assert {
        key: clip for key, clip in new.items() if key not in {"v1", "a1", "v2", "a2"}
    } == {key: clip for key, clip in old.items() if key not in {"v1", "a1", "v2", "a2"}}
    assert (result["captions"], result["markers"]) == (
        original["captions"],
        original["markers"],
    )
    assert timeline_duration(result) == timeline_duration(original)
    cut = new["v1"]["effects"]["transition_out"]["cut"]
    splits = {
        "start": (0, frames),
        "end": (frames, 0),
        "center": (frames // 2, frames - frames // 2),
    }
    before, after = splits[alignment]
    assert (cut["incoming"]["frames"], cut["outgoing"]["frames"], cut["alignment"]) == (
        before,
        after,
        alignment,
    )
    assert (new["v2"]["start_frame"], clip_end(new["v1"])) == (48 - before, 48 + after)
    # Both clips show what they showed outside the overlap, frame for frame.
    assert shown(result, "v1", range(48 - before)) == shown(
        original, "v1", range(48 - before)
    )
    v2_end = clip_end(old["v2"])
    assert shown(result, "v2", range(48 + after, v2_end)) == shown(
        original, "v2", range(48 + after, v2_end)
    )
    for clip in (new["v1"], new["v2"]):
        source = next(
            item for item in result["sources"] if item["source_id"] == clip["source_id"]
        )
        assert 0 <= clip["in_frame"] < clip["out_frame"] <= source["duration_frames"]

    # A freeze is recorded exactly where the media ran out, and every change starts again from the cut.
    def hold_end(clip: dict[str, Any]) -> int:
        return int(((clip.get("effects") or {}).get("hold") or {}).get("end", 0))

    assert hold_end(new["v1"]) - hold_end(old["v1"]) == cut["outgoing"]["freeze"]
    assert transitioned(result, kind="cut") == original
    for change in (
        {"frames": 5},
        {"frames": frames, "alignment": "end" if alignment != "end" else "start"},
    ):
        changed = transitioned(result, kind="dip_to_black", **change)
        assert transitioned(changed, kind="cut") == original


def test_edits_around_a_recorded_cut_give_back_what_the_clips_lent() -> None:
    def edit(timeline: dict[str, Any], *commands: dict[str, Any]) -> dict[str, Any]:
        saved, _ = apply_commands(
            {**BASE_PROJECT, "timeline": copy.deepcopy(timeline)},
            list(commands),
            counting(),
        )
        return dict(saved["timeline"])

    def clips(timeline: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {clip["clip_id"]: clip for clip in timeline["clips"]}

    original = cut_film("whole takes, no handles")
    quiet = {
        **original,
        "clips": [clip for clip in original["clips"] if clip["clip_id"] != "song"],
    }
    applied = transitioned(original, kind="crossfade", frames=12)
    assert clips(applied)["v1"]["effects"]["hold"] == {"end": 6} and clips(applied)[
        "v2"
    ]["effects"]["hold"] == {"start": 6}
    # Deleting the incoming clip leaves the outgoing one ending at the cut, and a ripple closes from the cut on.
    lifted = clips(edit(applied, {"op": "remove", "clip_ids": ["v2"]}))
    assert lifted["v1"] == clips(original)["v1"] and lifted["v3"]["start_frame"] == 96
    rippled = clips(
        edit(
            transitioned(quiet, kind="crossfade", frames=12),
            {"op": "remove", "clip_ids": ["v2"], "ripple": True},
        )
    )
    assert rippled["v1"] == clips(original)["v1"] and rippled["v3"]["start_frame"] == 48
    first = clips(
        edit(
            transitioned(quiet, kind="crossfade", frames=12),
            {"op": "remove", "clip_ids": ["v1"], "ripple": True},
        )
    )
    assert (
        first["v2"] == {**clips(original)["v2"], "start_frame": 0}
        and first["v3"]["start_frame"] == 48
    )
    # A trim moves the cut with the edge that moved; removing the transition then gives back what is still hidden.
    trimmed = edit(applied, {"op": "trim", "clip_id": "v1", "edge": "out", "delta": -2})
    cut = clips(trimmed)["v1"]["effects"]["transition_out"]["cut"]
    assert (cut["outgoing"]["frames"], cut["incoming"]["frames"]) == (6, 4)
    removed = clips(edit(trimmed, {"op": "transition", "clip_id": "v1", "kind": "cut"}))
    assert removed["v1"] == {
        **clips(original)["v1"],
        "output_window": {"start_frame": 0, "end_frame": 46},
    }
    assert removed["v2"] == {
        **clips(original)["v2"],
        "start_frame": 46,
        "effects": {"hold": {"start": 2}},
    }
    # A rearrange that separates recorded cuts closes up where the cuts are.
    both = transitioned(
        transitioned(original, kind="crossfade", frames=12),
        clip_id="v2",
        kind="crossfade",
        frames=8,
    )
    moved = clips(edit(both, {"op": "rearrange", "clip_ids": ["v2"], "to_frame": 0}))
    assert moved["v2"] == {**clips(original)["v2"], "start_frame": 0}
    assert (
        moved["v1"] == {**clips(original)["v1"], "start_frame": 48}
        and moved["v3"] == clips(original)["v3"]
    )
    # The export draws the overlap: the cut stays in the editor's document.
    snapshot = render_snapshot(
        applied,
        Exporter("00000000-0000-4000-8000-0000000000a1", "concat", 2, text=True),
        64,
        32,
    )
    assert clips(snapshot)["v1"]["effects"] == {
        "hold": {"end": 6},
        "transition_out": {"kind": "crossfade", "frames": 12},
    }


def adjusted_film() -> tuple[dict[str, Any], str]:
    """The add_text film (two shots on V1/A1, V2 free) with an adjustment layer added at frame 10: (project, clip)."""
    vector = load("timeline-commands", "add-text.json")["vectors"][0]
    project = {**BASE_PROJECT, "timeline": copy.deepcopy(vector["before"])}
    saved, applied = apply_commands(
        project, [{"op": "add_adjustment", "at_frame": 10}], counting()
    )
    contracts.validate("StudioTimelineApplied", applied[0])
    assert applied[0]["source_ids"] == ["adjust-1"] and "track_ids" not in applied[0]
    return saved, str(applied[0]["clip_ids"][0])


def edited(project: dict[str, Any], *commands: dict[str, Any]) -> dict[str, Any]:
    saved, _ = apply_commands(project, list(commands), counting())
    validate_timeline(saved["timeline"])
    return saved


def clip_of(project: dict[str, Any], clip_id: str) -> dict[str, Any]:
    return next(
        clip for clip in project["timeline"]["clips"] if clip["clip_id"] == clip_id
    )


def test_an_adjustment_layer_is_trimmed_moved_and_cut_like_any_clip_and_keeps_its_range_from_zero() -> (
    None
):
    project, layer = adjusted_film()
    assert {
        key: clip_of(project, layer)[key]
        for key in ("track_id", "start_frame", "in_frame", "out_frame")
    } == {
        "track_id": "video-2",
        "start_frame": 10,
        "in_frame": 0,
        "out_frame": 120,
    }
    # Its head grows into the frames before it: there is no media to run out of, its range starts again at 0
    grown = clip_of(
        edited(project, {"op": "trim", "clip_id": layer, "edge": "in", "delta": -10}),
        layer,
    )
    assert (
        grown["start_frame"],
        grown["in_frame"],
        grown["out_frame"],
        clip_end(grown),
    ) == (0, 0, 130, 130)
    # A ripple trim of its end moves what follows on the sync-locked tracks with it
    shortened = edited(
        project,
        {"op": "trim", "clip_id": layer, "edge": "out", "delta": -20, "mode": "ripple"},
    )
    assert clip_end(clip_of(shortened, layer)) == 110
    # The razor makes two adjustment clips of the same source, both on the composite below them
    cut = edited(project, {"op": "split", "at_frame": 50, "clip_ids": [layer]})
    parts = [
        clip
        for clip in cut["timeline"]["clips"]
        if clip["source_id"] == clip_of(project, layer)["source_id"]
    ]
    assert [
        (clip["start_frame"], clip_end(clip), clip["in_frame"]) for clip in parts
    ] == [(10, 50, 0), (50, 130, 0)]
    moved = clip_of(
        edited(project, {"op": "move", "clip_ids": [layer], "to_frame": 200}), layer
    )
    assert (moved["start_frame"], moved["track_id"]) == (200, "video-2")
    joined = edited(cut, {"op": "join", "clip_id": layer})
    assert clip_of(joined, layer) == clip_of(project, layer)


@pytest.mark.parametrize(
    ("patch", "reason"),
    [
        ({"motion": {"x": 0.2}}, "adjustment_layer"),
        (
            {
                "motion": {
                    "keyframes": {
                        "rotation": [
                            {"frame": 0, "value": 0, "interpolation": "linear"}
                        ]
                    }
                }
            },
            "adjustment_layer",
        ),
        ({"motion": {"gain_db": -6}}, "adjustment_layer"),
        ({"effects": {"speed_percent": 150}}, "adjustment_layer"),
        ({"effects": {"hold": {"end": 4}}}, "adjustment_layer"),
        ({"effects": {"frame_step": 2}}, "adjustment_layer"),
        ({"effects": {"camera": {"zoom_percent": 120}}}, "adjustment_layer"),
        ({"effects": {"impact": {"frames": 2, "style": "white"}}}, "adjustment_layer"),
        ({"effects": {"title": {"text": "標題"}}}, "adjustment_layer"),
        ({"effects": {"volume_db": -6}}, "adjustment_layer"),
        ({"effects": {"mute": True}}, "adjustment_layer"),
        ({"effects": {"fade": {"audio_out": 6}}}, "adjustment_layer"),
    ],
)
def test_an_adjustment_layer_refuses_what_needs_a_picture_a_clock_or_a_sound_of_its_own(
    patch: dict[str, Any], reason: str
) -> None:
    project, layer = adjusted_film()
    untouched = copy.deepcopy(project)
    with pytest.raises(ComponentError) as refused:
        apply_commands(
            project, [{"op": "set_clip", "clip_id": layer, **patch}], counting()
        )
    assert (
        refused.value.details["reason"] == reason
        and refused.value.details["command_index"] == 0
    )
    assert project == untouched
    # What changes the picture without moving it or its clock is kept
    keys = [
        {"frame": 0, "value": 0, "interpolation": "linear"},
        {"frame": 24, "value": 1, "interpolation": "ease_in"},
    ]
    look = {
        "effect_stack": [
            {
                "effect_id": "fx-1",
                "kind": "vignette",
                "enabled": True,
                "amount": 0.6,
                "softness": 0.4,
            }
        ],
        "effects": {
            "color": {"saturation": 0.2, "invert": False},
            "fade": {"video_in": 12, "video_out": 6},
        },
        "motion": {"opacity": 0.8, "keyframes": {"opacity": keys}},
        "mask": {
            "kind": "rectangle",
            "x": 0,
            "y": 0,
            "width": 0.5,
            "height": 1,
            "feather": 0.1,
            "invert": True,
        },
        "blend_mode": "multiply",
    }
    styled = clip_of(
        edited(project, {"op": "set_clip", "clip_id": layer, **look}), layer
    )
    assert (styled["blend_mode"], styled["effects"]["color"]["saturation"]) == (
        "multiply",
        0.2,
    )


@pytest.mark.parametrize(
    "case", ["file", "sound", "shot", "audio_track", "transition_out", "transition_in"]
)
def test_a_document_with_an_inconsistent_adjustment_layer_is_refused(case: str) -> None:
    project, layer = adjusted_film()
    timeline = copy.deepcopy(project["timeline"])
    source = next(item for item in timeline["sources"] if item["kind"] == "adjustment")
    clip = next(item for item in timeline["clips"] if item["clip_id"] == layer)
    expected = "adjustment_layer"
    if case == "file":
        source["file"] = {
            "node_id": "00000000-0000-4000-8000-0000000000a1", "file_id": "00000000-0000-4000-8000-000000000001",
            "size_bytes": 1, "sha256": "0" * 64, "media_type": "video/mp4", "metadata": {},
        }  # fmt: skip
    elif case == "sound":
        source["has_audio"] = True
    elif case == "shot":
        source["shot_id"] = "shot-1"
    elif case == "audio_track":
        clip["track_id"], expected = "audio-2", "track_kind"
    elif case == "transition_out":
        clip["effects"] = {"transition_out": {"kind": "crossfade", "frames": 6}}
    else:
        # A shot on V2 right before the layer, crossfading into it
        clip["start_frame"] = 48
        timeline["clips"].append(
            {**copy.deepcopy(timeline["clips"][0]), "clip_id": "before", "track_id": "video-2", "start_frame": 6,
             "linked_id": "before", "effects": {"transition_out": {"kind": "crossfade", "frames": 6}}}
        )  # fmt: skip
    with pytest.raises(ComponentError) as refused:
        validate_timeline(timeline)
    assert refused.value.details["reason"] == expected


def test_the_controller_keeps_a_saved_adjustment_layer_and_exports_it_only_where_it_is_composited() -> (
    None
):
    project, layer = adjusted_film()
    # What the editor saves: the layer with its look; normalization keeps it as it is, and is idempotent
    saved = edited(
        project,
        {"op": "set_clip", "clip_id": layer, "effects": {"color": {"brightness": 0.1}}},
    )
    contracts.validate("StudioProject", saved)
    assert normalize_project(saved) == saved
    assert normalize_project(normalize_project(saved)) == saved
    for source in saved["timeline"]["sources"]:
        if source["kind"] != "adjustment":
            source["file"] = {
                "node_id": "00000000-0000-4000-8000-0000000000a1", "file_id": "00000000-0000-4000-8000-000000000001",
                "size_bytes": 1, "sha256": "0" * 64, "media_type": "video/mp4", "metadata": {},
            }  # fmt: skip
    node = "00000000-0000-4000-8000-0000000000a1"
    current = Exporter.of(
        {
            "node_id": node,
            "component_id": "concat",
            "facts": {
                "timeline_export": {"version": 2, "text": True, "adjustment": True}
            },
        }
    )
    older = Exporter.of(
        {
            "node_id": node,
            "component_id": "concat",
            "facts": {"timeline_export": {"version": 2, "text": True}},
        }
    )
    assert (current.adjustment, older.adjustment) == (True, False)
    sent = exported(saved, current)["body"]["inputs"]["sequence"]["value"]["timeline"]
    assert [source["kind"] for source in sent["sources"]] == [
        "video",
        "video",
        "adjustment",
    ]
    assert clip_of({"timeline": sent}, layer)["effects"] == {
        "color": {"brightness": 0.1}
    }
    # An export component without them would refuse the document: the export is refused instead, even switched off
    for enabled in (True, False):
        stated = edited(
            saved, {"op": "set_enabled", "clip_ids": [layer], "enabled": enabled}
        )
        with pytest.raises(TimelineRejected) as refused:
            exported(stated, older)
        assert (
            refused.value.reason == "adjustment_unsupported"
            and refused.value.details["clip_id"] == layer
        )


def test_layout_keys_are_the_strings_the_editor_writes() -> None:
    style = {
        "font_family": "sans",
        "font_size": 81.0,
        "font_weight": 700,
        "color": "#ffffff",
        "align": "center",
        "x": 0.5,
        "y": 0.85,
    }
    plain = {"text": '標題 "A"\n', "position": "bottom", "size": "medium"}
    assert (
        title_key(plain, 1280, 720)
        == '["title.v1","標題 \\"A\\"\\n","bottom","medium",1280,720]'
    )
    assert title_key({**plain, "style": style}, 1280, 720) == (
        '["title.v2","標題 \\"A\\"\\n","bottom","medium",1280,720,"sans",81,700,"#ffffff","center",0.5,0.85]'
    )
    numbers = {
        81.0: "81",
        0.06: "0.06",
        118.8: "118.8",
        1e-7: "1e-7",
        0.000001: "0.000001",
        1e21: "1e+21",
        -0.5: "-0.5",
        100.0: "100",
    }
    assert {value: js_number(value) for value in numbers} == numbers


def test_the_shared_vectors_exist() -> None:
    """An empty directory would turn every table above into zero cases."""
    for directory in ("timeline-commands", "timeline-derived", "timeline-normalize"):
        assert any((EXAMPLES / directory).glob("*.json")), directory
