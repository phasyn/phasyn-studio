"""Studio 專案文件：revision 樂觀並行（新建 0→1、過期 409）、列表摘要、刪除需 revision、契約驗證。"""

from __future__ import annotations

import asyncio
import copy
import uuid
from pathlib import Path
from typing import Any

import pytest
from controller_support import Harness
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.testing.ids import NODE_A_ID, uid

from phasyn_controller.studio import StudioStore, run_refs, without_run
from phasyn_controller.studio_backfill import (
    reconcile_exports as port_exports,
    reconcile_images as port_images,
    reconcile_takes,
)


def project(pid: str = "p1") -> dict[str, Any]:
    take = {
        "take_id": "t1", "run_id": str(uuid.uuid4()), "output_key": "final", "created_at": "2026-10-17T00:00:00.000Z",
        "state": "succeeded", "prompt": "cat", "seed": 42, "frames": 124, "width": 768, "height": 448, "route": "route-a",
        "steps": None, "asset": None, "video_latent": None, "error": None, "timings_ms": {"te": 1.0, "dit": None},
    }  # fmt: skip
    shot = {
        "shot_id": "s1", "title": "橘貓", "prompt": "A cat", "frames": 124, "seed": 42, "seed_locked": False,
        "route": "route-a", "steps": None, "video_shift": None, "audio_shift": None, "enabled": True, "in_frame": 0,
        "out_frame": None, "takes": [take], "active_take_id": "t1", "note": "",
    }  # fmt: skip
    return {
        "project_id": pid, "title": "測試專案", "revision": 0, "created_at": "2026-10-17T00:00:00.000Z",
        "updated_at": "2026-10-17T00:00:00.000Z", "format": {"width": 768, "height": 448, "fps": {"num": 24, "den": 1}},
        "defaults": {"frames": 124, "route": "route-a", "steps": None}, "shots": [shot, {**shot, "shot_id": "s2", "takes": [],
        "active_take_id": None}], "exports": [],
    }  # fmt: skip


def test_studio_project_revision_list_and_delete(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            doc = project()
            contracts.validate("StudioProject", doc)
            created = await h.client.put("/api/studio/projects/p1", json=doc)
            assert created.status_code == 200, created.text
            saved = created.json()
            assert saved["revision"] == 1 and saved["updated_at"] != doc["updated_at"]

            stale = await h.client.put(
                "/api/studio/projects/p1", json=doc
            )  # 仍帶 revision 0
            assert (
                stale.status_code == 409 and stale.json()["code"] == "REVISION_CONFLICT"
            )
            assert stale.json()["details"]["stored_revision"] == 1

            edited = copy.deepcopy(saved)
            edited["title"] = "改名"
            second = (await h.client.put("/api/studio/projects/p1", json=edited)).json()
            assert (
                second["revision"] == 2 and second["created_at"] == saved["created_at"]
            )

            listed = (await h.client.get("/api/studio/projects")).json()["items"]
            contracts.validate("StudioProjectList", {"items": listed})
            assert listed == [
                {"project_id": "p1", "title": "改名", "revision": 2, "created_at": saved["created_at"],
                 "updated_at": second["updated_at"], "shot_count": 2, "rendered_shot_count": 1}
            ]  # fmt: skip

            # Project storage supports every route; the selected provider validates native frame constraints.
            short = copy.deepcopy(second)
            short["shots"][0]["frames"] = 50
            accepted = await h.client.put("/api/studio/projects/p1", json=short)
            assert (
                accepted.status_code == 200
                and accepted.json()["shots"][0]["frames"] == 50
            )
            current = accepted.json()
            assert current["revision"] == 3
            bad = copy.deepcopy(current)
            bad["shots"][0]["frames"] = 0
            invalid = await h.client.put("/api/studio/projects/p1", json=bad)
            assert (
                invalid.status_code == 422
                and invalid.json()["code"] == "INVALID_ARGUMENT"
            )
            mismatch = await h.client.put("/api/studio/projects/other", json=second)
            assert mismatch.status_code == 422

            assert (
                await h.client.delete("/api/studio/projects/p1?revision=1")
            ).status_code == 409
            assert (await h.client.delete("/api/studio/projects/p1")).status_code == 422
            gone = await h.client.delete("/api/studio/projects/p1?revision=3")
            assert gone.status_code == 200 and gone.json() == {
                "project_id": "p1",
                "deleted": True,
            }
            missing = await h.client.get("/api/studio/projects/p1")
            assert missing.status_code == 404

    asyncio.run(scenario())


def test_run_refs_and_without_run_cover_image_shots() -> None:
    """圖片鏡頭（image_shots）的 take 也由 run 刪除連動：列出、移除、清掉使用中的 take。"""

    doc = {
        "shots": [],
        "exports": [],
        "image_shots": [
            {"image_shot_id": "i1", "takes": [{"take_id": "k1", "run_id": "R1"}, {"take_id": "k2", "run_id": "r2"}],
             "active_take_id": "k1"}
        ],
    }  # fmt: skip
    assert run_refs(doc, "r1") == (["k1"], [])
    edited = without_run(doc, "r1")
    assert [t["take_id"] for t in edited["image_shots"][0]["takes"]] == ["k2"]
    assert edited["image_shots"][0]["active_take_id"] is None
    assert doc["image_shots"][0]["active_take_id"] == "k1"  # 原文件不變


# Timeline persistence tests cover refused writes and references that must survive run-file deletion.
def _timeline_file(index: int, media_type: str = "video/mp4") -> dict[str, Any]:
    return {
        "node_id": NODE_A_ID,
        "file_id": uid(index),
        "size_bytes": 1,
        "sha256": "a" * 64,
        "media_type": media_type,
        "metadata": {},
    }


def _timeline_document() -> dict[str, Any]:
    return {
        "version": 1,
        "fps": {"num": 24, "den": 1},
        "master_gain_db": 0,
        "sources": [
            {
                "source_id": "source-a",
                "name": "Synthetic source",
                "kind": "video",
                "file": _timeline_file(801),
                "duration_frames": 24,
                "width": 64,
                "height": 32,
                "has_audio": True,
            }
        ],
        "tracks": [
            {
                "track_id": "video-a",
                "name": "V1",
                "kind": "video",
                "locked": False,
                "muted": False,
                "solo": False,
                "sync_lock": True,
                "gain_db": 0,
                "pan": 0,
            }
        ],
        "clips": [
            {
                "clip_id": "clip-a",
                "source_id": "source-a",
                "track_id": "video-a",
                "name": "Synthetic clip",
                "start_frame": 0,
                "in_frame": 0,
                "out_frame": 24,
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
        ],
        "captions": [],
        "markers": [],
    }


@pytest.mark.parametrize(
    "case",
    [
        "duplicate_id",
        "missing_source",
        "missing_track",
        "source_handles",
        "overlap",
        "automation_range",
        "automation_order",
        "duration_bound",
    ],
)
def test_timeline_invalid_save_preserves_document_and_revision(
    tmp_path: Path, case: str
) -> None:
    store = StudioStore(tmp_path / "projects")
    body = project()
    body["timeline"] = _timeline_document()
    saved = store.put("p1", body)
    snapshot = (tmp_path / "projects" / "p1.json").read_bytes()
    edited = copy.deepcopy(saved)
    timeline = edited["timeline"]
    clip = timeline["clips"][0]
    if case == "duplicate_id":
        timeline["sources"].append(copy.deepcopy(timeline["sources"][0]))
    elif case == "missing_source":
        clip["source_id"] = "absent-source"
    elif case == "missing_track":
        clip["track_id"] = "absent-track"
    elif case == "source_handles":
        clip["out_frame"] = 25
    elif case == "overlap":
        timeline["clips"].append(
            {**copy.deepcopy(clip), "clip_id": "clip-b", "start_frame": 12}
        )
    elif case == "automation_range":
        clip["motion"]["keyframes"] = {
            "opacity": [{"frame": 0, "value": 2, "interpolation": "linear"}]
        }
    elif case == "automation_order":
        clip["motion"]["keyframes"] = {
            "x": [
                {"frame": 3, "value": 0, "interpolation": "linear"},
                {"frame": 3, "value": 1, "interpolation": "hold"},
            ]
        }
    else:
        clip["start_frame"] = 100000
    with pytest.raises(ComponentError) as refused:
        store.put("p1", edited)
    assert refused.value.code == "INVALID_ARGUMENT"
    assert store.get("p1") == saved
    assert (tmp_path / "projects" / "p1.json").read_bytes() == snapshot


def test_timeline_file_references_remain_protected_after_run_removal(
    tmp_path: Path,
) -> None:
    store = StudioStore(tmp_path / "projects")
    body = project()
    timeline = _timeline_document()
    refs = [
        _timeline_file(801),
        _timeline_file(802),
        _timeline_file(803, "image/png"),
        _timeline_file(804, "image/png"),
    ]
    source = timeline["sources"][0]
    source["proxy_source_sha256"] = source["file"]["sha256"]
    source["proxy"] = {
        "asset_id": uid(805),
        "kind": "preview",
        "file": refs[1],
        "source_latent": None,
        "frame_count": 24,
        "fps": timeline["fps"],
        "width": 64,
        "height": 32,
        "complete": True,
        "actual_settings": {},
    }
    timeline["captions"] = [
        {
            "caption_id": "caption-a",
            "start_frame": 0,
            "end_frame": 12,
            "text": "Synthetic caption",
            "position": "bottom",
            "size": "small",
            "image": refs[2],
        }
    ]
    timeline["clips"][0]["effects"] = {
        "title": {
            "text": "Synthetic title",
            "position": "top",
            "size": "small",
            "start_frame": 0,
            "end_frame": None,
            "image": refs[3],
        }
    }
    body["timeline"] = timeline
    saved = store.put("p1", body)
    expected = {(ref["node_id"].lower(), ref["file_id"].lower()) for ref in refs}
    assert expected <= store.library_file_keys()
    run_id = body["shots"][0]["takes"][0]["run_id"]
    store.remove_run_refs("p1", run_id)
    assert store.get("p1")["timeline"] == saved["timeline"]
    assert expected <= store.library_file_keys()


@pytest.mark.parametrize(
    "effects",
    [
        {"fade": {"video_in": 11}},
        {"fade": {"video_in": 6, "video_out": 5}},
        {"fade": {"video_out": 10}},
        {"fade": {"audio_in": 6, "audio_out": 5}},
        {"impact": {"frames": 11, "style": "white"}},
        {
            "title": {
                "text": "Synthetic title",
                "position": "top",
                "size": "small",
                "start_frame": 10,
                "end_frame": None,
                "image": None,
            }
        },
        {
            "title": {
                "text": "Synthetic title",
                "position": "top",
                "size": "small",
                "start_frame": 0,
                "end_frame": 11,
                "image": None,
            }
        },
    ],
    ids=[
        "video_fade_extent",
        "video_fade_sum",
        "video_fade_out_all",
        "audio_fade_sum",
        "impact_extent",
        "title_start",
        "title_end",
    ],
)
def test_timeline_effect_extent_refusal_preserves_document_and_revision(
    tmp_path: Path, effects: dict[str, Any]
) -> None:
    store = StudioStore(tmp_path / "projects")
    body = project()
    body["timeline"] = _timeline_document()
    body["timeline"]["clips"][0]["out_frame"] = 10
    saved = store.put("p1", body)
    snapshot = (tmp_path / "projects" / "p1.json").read_bytes()
    edited = copy.deepcopy(saved)
    edited["timeline"]["clips"][0]["effects"] = copy.deepcopy(effects)
    # Values satisfy the wire shape; refusal must enforce the edited clip's actual duration.
    contracts.validate("StudioTimeline", edited["timeline"])
    with pytest.raises(ComponentError) as refused:
        store.put("p1", edited)
    assert refused.value.code == "INVALID_ARGUMENT"
    assert store.get("p1") == saved
    assert store.get("p1")["revision"] == saved["revision"]
    assert (tmp_path / "projects" / "p1.json").read_bytes() == snapshot


# Read-back of finished runs into projects: a data-integrity boundary, the Controller writes projects itself.
def _waiting_project(run_id: str) -> dict[str, Any]:
    doc = project()
    take = {
        **doc["shots"][0]["takes"][0],
        "take_id": "t2",
        "run_id": run_id,
        "state": "rendering",
        "asset": None,
    }
    doc["shots"][0]["takes"].append(take)
    doc["shots"][1]["takes"] = [{**take, "take_id": "t3", "output_key": "final_1"}]
    return doc


def _run(run_id: str, state: str) -> dict[str, Any]:
    error = (
        {"code": "NODE_UNREACHABLE", "message": "node gone"}
        if state != "running"
        else None
    )
    return {"run_id": run_id, "state": state, "error": error, "request": {"pipeline": {"steps": [], "outputs": {}}},
            "steps": {}}  # fmt: skip


def test_backfill_reads_finished_runs_into_rendering_takes_only(tmp_path: Path) -> None:
    store = StudioStore(tmp_path / "projects")
    rid = str(uuid.uuid4())
    saved = store.put("p1", _waiting_project(rid))
    assert store.projects_waiting_on() == {"p1": {rid}}

    # A run that is still running changes nothing and writes nothing
    assert store.backfill("p1", [_run(rid, "running")]) is False
    assert store.get("p1")["revision"] == saved["revision"]

    # A person's edit saved meanwhile stays; only the rendering takes of that run change
    edited = copy.deepcopy(store.get("p1"))
    edited["title"] = "改名"
    edited = store.put("p1", edited)
    assert store.backfill("p1", [_run(rid, "failed")]) is True
    after = store.get("p1")
    assert after["revision"] == edited["revision"] + 1 and after["title"] == "改名"
    takes = {t["take_id"]: t for shot in after["shots"] for t in shot["takes"]}
    assert (
        takes["t1"] == edited["shots"][0]["takes"][0]
    )  # an already final take is untouched
    assert takes["t2"]["state"] == takes["t3"]["state"] == "failed"
    assert takes["t2"]["error"]["code"] == "NODE_UNREACHABLE"
    assert (
        after["shots"][0]["active_take_id"] == "t1"
    )  # a failed take never becomes the active one
    assert store.projects_waiting_on() == {}

    # Read back again: nothing left to change, nothing written
    assert store.backfill("p1", [_run(rid, "failed")]) is False
    assert store.get("p1")["revision"] == after["revision"]


def test_backfill_skips_missing_projects_and_other_runs(tmp_path: Path) -> None:
    store = StudioStore(tmp_path / "projects")
    rid = str(uuid.uuid4())
    saved = store.put("p1", _waiting_project(rid))
    assert store.backfill("missing", [_run(rid, "failed")]) is False
    assert store.backfill("p1", [_run(str(uuid.uuid4()), "cancelled")]) is False
    assert store.get("p1")["revision"] == saved["revision"]


def _file(n: int) -> dict[str, Any]:
    return {"node_id": NODE_A_ID, "file_id": uid(900 + n), "size_bytes": 10 + n, "sha256": "ab" * 32,
            "media_type": "video/mp4", "metadata": {}}  # fmt: skip


def _succeeded_two_shot_run(run_id: str) -> dict[str, Any]:
    asset = {"asset_id": uid(950), "kind": "final", "file": _file(0), "frame_count": 107, "fps": {"num": 24, "den": 1},
             "width": 768, "height": 448, "complete": True, "actual_settings": {}}  # fmt: skip
    step = {
        "state": "succeeded",
        "started_at": "2026-11-16T07:00:00.000Z",
        "finished_at": "2026-11-16T07:01:00.500Z",
    }
    return {
        "run_id": run_id, "state": "failed", "error": {"code": "STEP_FAILED", "message": "shot 2 failed"},
        "request": {"pipeline": {
            "steps": [{"step_id": "denoise_0"}, {"step_id": "video_0"}, {"step_id": "denoise_1"}, {"step_id": "video_1"}],
            "outputs": {"final_0": {"from_step": "video_0", "output": "video"},
                        "final_1": {"from_step": "video_1", "output": "video"}}}},
        "steps": {"denoise_0": dict(step), "video_0": {**step, "outputs": {"video": {"type_id": "media.asset.v1", "value": asset}}},
                  "denoise_1": {**step, "state": "failed", "error": {"code": "GPU_OOM", "message": "out of memory"}},
                  "video_1": {"state": "skipped"},
                  "concat": {"state": "failed", "error": {"code": "INPUT_MISSING", "message": "no shot 2"}}},
    }  # fmt: skip


def test_backfill_reads_a_partly_failed_run_into_takes_and_exports() -> None:
    """A run whose second shot failed: the first take succeeds, the second fails with its step's error, and the
    export that needed both fails."""

    rid = str(uuid.uuid4())
    doc = _waiting_project(rid)
    doc["shots"][0]["takes"][1]["output_key"] = "final_0"
    doc["shots"][0]["active_take_id"] = None
    doc["exports"] = [{"export_id": "e1", "run_id": rid, "state": "rendering", "asset": None, "error": None,
                       "frames": None}]  # fmt: skip
    run = _succeeded_two_shot_run(rid)
    port = copy.deepcopy(doc)
    assert reconcile_takes(port, run) == 2
    assert port_exports(port, run) == 1
    takes = {t["take_id"]: t for shot in port["shots"] for t in shot["takes"]}
    assert (
        takes["t2"]["state"] == "succeeded"
        and takes["t2"]["asset"]["frame_count"] == 107
    )
    assert (
        takes["t3"]["state"] == "failed" and takes["t3"]["error"]["code"] == "GPU_OOM"
    )
    assert port["exports"][0]["state"] == "failed"


def _image_asset(n: int, *, white: bool) -> dict[str, Any]:
    file = {**_file(n), "media_type": "image/png"}
    return {"asset_id": uid(960 + n), "file": file, "width": 1024, "height": 1024, "mode": "RGB" if white else "RGBA",
            "has_alpha": not white, "white_matte": white, "source_take": None, "actual_settings": {}}  # fmt: skip


def _image_project(run_id: str) -> dict[str, Any]:

    doc = project()
    shot: dict[str, Any] = {
        "image_shot_id": "i1", "title": "Lantern", "mode": "t2i", "prompt": "a lantern", "negative_prompt": "",
        "width": 1024, "height": 1024, "seed": -1, "seed_mode": "increment", "batch": 1, "steps": 40, "guidance": 1,
        "sigma_schedule": "native", "flow_shift_mu": None, "route": "unassigned", "references": [], "base_index": None,
        "reference_resolution": 1024, "mask_item_id": None, "mask_invert": False, "decode": "full",
        "preview": {"mode": "off", "every": 5}, "takes": [], "active_take_id": None, "note": "",
    }  # fmt: skip
    snapshot = {"v": 1, "mode": "t2i", "outputs": {"image": "image", "image_white": "image_white"},
                "auto_library": True}  # fmt: skip
    shot["takes"] = [{"take_id": "it1", "run_id": run_id, "created_at": "2026-11-16T07:00:00.000Z",
                      "state": "rendering", "seed": 42, "image": None, "image_white": None, "library_item_id": None,
                      "timings_ms": {}, "error": None, "params_snapshot": snapshot}]  # fmt: skip
    doc["image_shots"] = [shot]
    return doc


def _image_run(run_id: str) -> dict[str, Any]:
    step = {
        "state": "succeeded",
        "started_at": "2026-11-16T07:00:00.000Z",
        "finished_at": "2026-11-16T07:00:30.000Z",
    }
    outputs = {"image": {"type_id": "image.asset.v1", "value": _image_asset(1, white=False)},
               "image_white": {"type_id": "image.asset.v1", "value": _image_asset(2, white=True)}}  # fmt: skip
    return {
        "run_id": run_id, "state": "succeeded", "error": None,
        "request": {"pipeline": {
            "steps": [{"step_id": "dit", "inputs": {}},
                      {"step_id": "compose", "inputs": {"latent": {"from_step": "dit", "output": "latent"}}}],
            "outputs": {"image": {"from_step": "compose", "output": "image"},
                        "image_white": {"from_step": "compose", "output": "image_white"}}}},
        "steps": {"dit": dict(step), "compose": {**step, "outputs": outputs}},
    }  # fmt: skip


def test_backfill_adds_finished_images_to_the_library_like_the_studio(
    tmp_path: Path,
) -> None:
    """An image finished while no page was open reaches the library (auto_library) through the Controller's
    read-back; a second read-back adds nothing."""

    rid = str(uuid.uuid4())
    port = _image_project(rid)
    assert port_images(port, _image_run(rid), "2026-11-16T07:01:00.000Z") == 1

    store = StudioStore(tmp_path / "projects")
    saved = store.put("p1", _image_project(rid))
    assert store.projects_waiting_on() == {"p1": {rid}}
    assert store.backfill("p1", [_image_run(rid)]) is True
    after = store.get("p1")
    assert after["revision"] == saved["revision"] + 1
    shot = after["image_shots"][0]
    take = shot["takes"][0]
    assert take["state"] == "succeeded" and shot["active_take_id"] == "it1"
    assert take["library_item_id"] == "imgw-it1"
    item = next(entry for entry in after["library"] if entry["item_id"] == "imgw-it1")
    assert (
        item["file"] == _image_asset(2, white=True)["file"]
        and item["name"] == "Lantern · take 1 (white bg).png"
    )
    assert store.projects_waiting_on() == {}
    assert store.backfill("p1", [_image_run(rid)]) is False


@pytest.mark.parametrize("chosen", ["earlier", None])
@pytest.mark.parametrize("medium", ["video", "image"])
def test_other_run_preserves_selected_take(medium: str, chosen: str | None) -> None:
    """A new generation preserves a manual pick or the latest success shown by a legacy project."""
    rid = str(uuid.uuid4())
    if medium == "video":
        doc = _waiting_project(rid)
        shot = doc["shots"][0]
        pending = shot["takes"][1]
        pending["output_key"] = "final_0"
        run = _succeeded_two_shot_run(rid)
    else:
        doc = _image_project(rid)
        shot = doc["image_shots"][0]
        pending = shot["takes"][0]
        run = _image_run(rid)
    old = {**pending, "run_id": str(uuid.uuid4()), "state": "succeeded"}
    shot["takes"] = [
        {**old, "take_id": "earlier"},
        {**old, "take_id": "later"},
        pending,
    ]
    shot["active_take_id"] = chosen
    if medium == "video":
        reconcile_takes(doc, run)
    else:
        port_images(doc, run, "2026-11-19T00:00:00Z")
    assert pending["state"] == "succeeded"
    assert shot["active_take_id"] == (chosen or "later")
