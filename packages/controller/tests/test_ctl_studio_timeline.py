"""The Controller as the authority of a Studio project's timeline (data integrity of saved documents).

A read returns the normalized document and writes nothing; the first save that takes a project over keeps the
document as it was, once; a project that has a timeline cannot be saved without it; timeline commands are all or
nothing under the project's revision; an export is refused rather than rendered without its media or text and is
recorded only once its run exists; and a run purge never deletes media the timeline shows.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from controller_support import (
    ENDPOINT_A,
    NODE_A,
    FakeNode,
    Harness,
    descriptor,
    pipeline,
    port,
    step,
    wait_until,
)
from phasyn_components import contracts
from phasyn_components.files import FileStore
from phasyn_components.testing.ids import uid

from phasyn_controller.studio import LEGACY_DIR


PROJECTS = "/api/studio/projects"


def file_ref(n: int, media_type: str = "video/mp4") -> dict[str, Any]:
    return {
        "node_id": NODE_A,
        "file_id": uid(n),
        "size_bytes": 1,
        "sha256": "a" * 64,
        "media_type": media_type,
        "metadata": {},
    }


def take(
    take_id: str,
    n: int,
    *,
    frames: int = 124,
    run_id: str | None = None,
    asset: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rendered = asset or {
        "asset_id": uid(500 + n), "kind": "final", "file": file_ref(n), "source_latent": None, "frame_count": frames,
        "fps": {"num": 24, "den": 1}, "width": 768, "height": 448, "complete": True, "actual_settings": {},
    }  # fmt: skip
    return {
        "take_id": take_id, "run_id": run_id or uid(900 + n), "output_key": "final", "created_at": "2026-11-01T00:00:00.000Z",
        "state": "succeeded", "prompt": "cat", "seed": 1, "frames": frames, "width": 768, "height": 448, "route": "route-a",
        "steps": None, "asset": rendered, "video_latent": None, "error": None, "timings_ms": {},
    }  # fmt: skip


def shot(shot_id: str, takes: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {
        "shot_id": shot_id, "title": shot_id.upper(), "prompt": "A cat", "frames": 124, "seed": 1, "seed_locked": False,
        "route": "route-a", "steps": None, "video_shift": None, "audio_shift": None, "enabled": True, "in_frame": 0,
        "out_frame": None, "takes": takes, "active_take_id": takes[0]["take_id"] if takes else None, "note": "", **extra,
    }  # fmt: skip


def project(
    shots: list[dict[str, Any]], *, pid: str = "p1", revision: int = 0
) -> dict[str, Any]:
    return {
        "project_id": pid, "title": "測試專案", "revision": revision, "created_at": "2026-11-01T00:00:00.000Z",
        "updated_at": "2026-11-01T00:00:00.000Z", "format": {"width": 768, "height": 448, "fps": {"num": 24, "den": 1}},
        "defaults": {"frames": 124, "route": "route-a", "steps": None}, "shots": shots, "exports": [],
    }  # fmt: skip


def rendered_project(**kwargs: Any) -> dict[str, Any]:
    return project([shot("s1", [take("t1", 1)]), shot("s2", [take("t2", 2)])], **kwargs)


def stored_path(h: Harness, pid: str = "p1") -> Path:
    return Path(h.config.data_dir) / "config" / "studio" / f"{pid}.json"


def legacy_path(h: Harness, pid: str = "p1") -> Path:
    return stored_path(h, pid).parent / LEGACY_DIR / f"{pid}.json"


async def saved(h: Harness, doc: dict[str, Any]) -> dict[str, Any]:
    resp = await h.client.put(f"{PROJECTS}/{doc['project_id']}", json=doc)
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


async def read(h: Harness, pid: str = "p1") -> dict[str, Any]:
    resp = await h.client.get(f"{PROJECTS}/{pid}")
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


def test_a_read_writes_nothing_and_the_first_save_keeps_the_document_as_it_was(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            legacy = rendered_project(revision=3)
            legacy["shots"][0].update(
                in_frame=10,
                out_frame=110,
                effects={"volume_db": -6, "fade": {"video_in": 12}},
            )
            raw = json.dumps(legacy, ensure_ascii=False).encode()
            stored_path(h).write_bytes(raw)

            seen = await read(h)
            contracts.validate("StudioProject", seen)
            video, audio = seen["timeline"]["clips"][0], seen["timeline"]["clips"][1]
            assert (seen["revision"], seen["timeline"]["version"]) == (3, 2)
            assert (video["in_frame"], video["out_frame"], video["effects"]) == (
                10,
                110,
                {"fade": {"video_in": 12}},
            )
            assert audio["motion"]["gain_db"] == -6 and "effects" not in audio
            assert (
                seen["shots"][0]["in_frame"],
                seen["shots"][0]["out_frame"],
                "effects" in seen["shots"][0],
            ) == (
                0,
                None,
                False,
            )
            assert stored_path(h).read_bytes() == raw and not legacy_path(h).exists()
            assert (await h.client.get(f"{PROJECTS}/p1/legacy")).status_code == 404

            first = await saved(h, {**seen, "title": "接管後"})
            assert first["revision"] == 4 and first["timeline"] == seen["timeline"]
            assert json.loads(stored_path(h).read_text(encoding="utf-8")) == first
            assert json.loads(legacy_path(h).read_text(encoding="utf-8")) == legacy
            kept = await h.client.get(f"{PROJECTS}/p1/legacy")
            assert kept.status_code == 200 and kept.json() == legacy

            second = await saved(h, {**first, "title": "再保存"})
            assert (
                second["revision"] == 5
                and json.loads(legacy_path(h).read_text(encoding="utf-8")) == legacy
            )

            stale = await h.client.put(
                f"{PROJECTS}/p1", json={**first, "title": "過期"}
            )
            assert (
                stale.status_code == 409 and stale.json()["code"] == "REVISION_CONFLICT"
            )
            dropped = {key: value for key, value in second.items() if key != "timeline"}
            refused = await h.client.put(f"{PROJECTS}/p1", json=dropped)
            assert refused.status_code == 422 and refused.json()["details"] == {
                "field": "timeline"
            }
            assert await read(h) == second

            gone = await h.client.delete(f"{PROJECTS}/p1?revision=5")
            assert gone.status_code == 200 and not legacy_path(h).exists()

    asyncio.run(scenario())


def test_a_new_project_is_saved_with_its_timeline_and_a_broken_normalization_never_blocks_a_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            created = await saved(
                h,
                project(
                    [
                        shot("s1", [take("t1", 1)]),
                        shot("s2", []),
                        shot("s3", [], enabled=False),
                    ]
                ),
            )
            timeline = created["timeline"]
            assert created["revision"] == 1 and timeline["placed_shot_ids"] == [
                "s1",
                "s2",
            ]
            assert [shot["enabled"] for shot in created["shots"]] == [True, True, False]
            assert [source["file"] is None for source in timeline["sources"]] == [
                False,
                True,
            ]
            assert not legacy_path(h).exists()  # nothing of the shots had to be moved
            assert await read(h) == created

            def broken(_document: Any) -> Any:
                raise KeyError("a bug in normalization")

            monkeypatch.setattr("phasyn_controller.studio.normalize_project", broken)
            assert await read(h) == created
            failed = await h.client.put(f"{PROJECTS}/p1", json=created)
            assert (
                failed.status_code == 500
                and json.loads(stored_path(h).read_text(encoding="utf-8")) == created
            )

    asyncio.run(scenario())


def test_timeline_commands_are_all_or_nothing_under_the_revision(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            doc = await saved(h, rendered_project())
            url = f"{PROJECTS}/p1/timeline/commands"
            first, second = (
                doc["timeline"]["clips"][0]["clip_id"],
                doc["timeline"]["clips"][2]["clip_id"],
            )

            async def send(
                commands: list[dict[str, Any]], revision: int, **extra: Any
            ) -> Any:
                return await h.client.post(
                    url, json={"revision": revision, "commands": commands, **extra}
                )

            done = await send(
                [
                    {"op": "split", "at_frame": 20, "clip_ids": [first]},
                    {"op": "master", "gain_db": -6},
                ],
                1,
            )
            assert done.status_code == 200, done.text
            result = done.json()
            contracts.validate("StudioTimelineCommandsResult", result)
            assert [item["op"] for item in result["applied"]] == ["split", "master"]
            assert (
                result["project"]["revision"] == 2
                and len(result["project"]["timeline"]["clips"]) == 6
            )
            assert await read(h) == result["project"]

            rehearsal = await send(
                [{"op": "assemble", "mode": "rebuild", "confirm": True}],
                2,
                dry_run=True,
            )
            assert (
                rehearsal.status_code == 200
                and rehearsal.json()["project"]["revision"] == 2
            )
            assert len(rehearsal.json()["project"]["timeline"]["clips"]) == 4
            assert (
                await read(h) == result["project"]
            )  # a dry run never saves, confirm or not

            refused = await send(
                [
                    {"op": "master", "gain_db": 3},
                    {"op": "remove", "clip_ids": ["nope"]},
                ],
                2,
            )
            body = refused.json()
            assert (refused.status_code, body["code"]) == (
                422,
                "STUDIO_TIMELINE_REJECTED",
            )
            assert (body["details"]["command_index"], body["details"]["reason"]) == (
                1,
                "clip_not_found",
            )
            contracts.validate("StudioTimelineRejection", body["details"])
            unknown = await send([{"op": "explode"}], 2)
            assert (
                unknown.json()["details"]["reason"] == "invalid_command"
                and unknown.json()["details"]["command_index"] == 0
            )
            assert (await send([], 2)).json()["code"] == "INVALID_ARGUMENT"
            stale = await send([{"op": "master", "gain_db": 3}], 1)
            assert (stale.status_code, stale.json()["code"]) == (
                409,
                "REVISION_CONFLICT",
            )
            assert await read(h) == result["project"]

            removed = await send(
                [{"op": "remove", "clip_ids": [second], "ripple": True}], 2
            )
            after = removed.json()["project"]
            assert removed.status_code == 200 and after["revision"] == 3
            assert [shot["enabled"] for shot in after["shots"]] == [
                True,
                False,
            ]  # the linked audio went with it
            assert after["timeline"]["placed_shot_ids"] == ["s1", "s2"]
            unchanged = await send([{"op": "work_area", "clear": True}], 3)
            assert (
                unchanged.status_code == 200 and unchanged.json()["project"] == after
            )  # nothing changed, nothing saved
            assert (
                await h.client.post(
                    f"{PROJECTS}/missing/timeline/commands",
                    json={"revision": 0, "commands": [{"op": "master", "gain_db": 0}]},
                )
            ).status_code == 404

    asyncio.run(scenario())


def export_node(tmp_path: Path, *, facts: dict[str, Any] | None = None) -> FakeNode:
    concat = descriptor(
        NODE_A,
        "concat",
        inputs=[port("sequence", "media.sequence.v1")],
        outputs=[port("asset", "media.asset.v1")],
    )
    concat.update(provider_id="media.concat", facts=facts)
    node = FakeNode(
        NODE_A, ENDPOINT_A, [concat, descriptor(NODE_A, "echo", resource_group="cpu-2")]
    )
    node.files = FileStore(tmp_path / "node-a", NODE_A)
    return node


def test_an_export_is_built_from_the_saved_timeline_and_recorded_once_its_run_exists(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            doc = await saved(h, rendered_project())
            url = f"{PROJECTS}/p1/timeline/export"
            missing = await h.client.post(url, json={"revision": 1})
            assert (missing.status_code, missing.json()["code"]) == (
                422,
                "COMPONENT_NOT_CONFIGURED",
            )

            node = export_node(tmp_path)
            await h.add_node(node)
            busy = await h.start_run(
                pipeline([step("wait", NODE_A, "echo", params={"gate": "open"})])
            )
            await wait_until(lambda: node.started("wait"))
            active = await h.client.post(url, json={"revision": 1})
            assert (active.status_code, active.json()["code"]) == (409, "RUN_ACTIVE")
            assert await read(h) == doc
            node.gate("open").set()
            await h.wait_run(busy["run_id"])

            assert (await h.client.post(url, json={"revision": 0})).json()[
                "code"
            ] == "REVISION_CONFLICT"
            started = await h.client.post(
                url, json={"revision": 1, "size": "720p", "quality": "standard"}
            )
            assert started.status_code == 202, started.text
            result = started.json()
            contracts.validate("StudioTimelineExportResult", result)
            record = result["project"]["exports"][-1]
            assert (record["run_id"], record["export_id"], record["state"]) == (
                result["run_id"],
                result["export_id"],
                "rendering",
            )
            assert (
                record["shot_ids"] == ["s1", "s2"]
                and result["project"]["revision"] == 2
            )
            assert await read(h) == result["project"]
            run = await h.wait_run(result["run_id"])
            request = run["request"]
            assert request["pipeline"]["pipeline_id"] == "studio-export"
            assert request["pipeline"]["outputs"] == {
                "final": {"from_step": "concat", "output": "asset"}
            }
            sent = node.call("concat")["body"]
            assert sent["parameters"] == {
                "crf": 23,
                "preset": "medium",
                "audio_bitrate": 192000,
            }
            sequence = sent["inputs"]["sequence"]["value"]
            contracts.validate("MediaSequence", sequence)
            assert (
                sequence["width"],
                sequence["height"],
                sequence["fit"],
                sequence["clips"],
            ) == (
                1280,
                720,
                "cover",
                [],
            )
            assert (
                sequence["timeline"]["version"] == 1
                and len(sequence["timeline"]["clips"]) == 4
            )

            titled = await h.client.post(
                f"{PROJECTS}/p1/timeline/commands",
                json={
                    "revision": 2,
                    "commands": [{"op": "add_text", "text": "片名", "at_frame": 0}],
                },
            )
            assert titled.status_code == 200, titled.text
            before = await read(h)
            runs = len((await h.client.get("/api/runs")).json()["items"])
            unreadable = await h.client.post(url, json={"revision": 3})
            assert (unreadable.status_code, unreadable.json()["details"]["reason"]) == (
                422,
                "text_not_rasterized",
            )
            assert (
                await read(h) == before
                and len((await h.client.get("/api/runs")).json()["items"]) == runs
            )

    asyncio.run(scenario())


def test_an_export_waits_for_media_and_a_text_capable_exporter_gets_the_text(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            await h.add_node(
                export_node(
                    tmp_path, facts={"timeline_export": {"version": 2, "text": True}}
                )
            )
            waiting = await saved(
                h, project([shot("s1", [take("t1", 1)]), shot("s2", [])])
            )
            url = f"{PROJECTS}/p1/timeline/export"
            unrendered = await h.client.post(url, json={"revision": 1})
            assert (unrendered.status_code, unrendered.json()["code"]) == (
                422,
                "STUDIO_TIMELINE_REJECTED",
            )
            assert (
                unrendered.json()["details"]["reason"] == "not_rendered"
                and await read(h) == waiting
            )

            placeholder = waiting["timeline"]["clips"][2]["clip_id"]
            commands = [
                {"op": "remove", "clip_ids": [placeholder]},
                {"op": "add_text", "text": "片名", "at_frame": 0},
            ]
            edited = await h.client.post(
                f"{PROJECTS}/p1/timeline/commands",
                json={"revision": 1, "commands": commands},
            )
            assert edited.status_code == 200, edited.text
            started = await h.client.post(url, json={"revision": 2})
            assert started.status_code == 202, started.text
            run = await h.wait_run(started.json()["run_id"])
            timeline = run["request"]["inputs"]["sequence"]["value"]["timeline"]
            assert timeline["version"] == 2 and [
                source["kind"] for source in timeline["sources"]
            ] == ["video", "text"]

    asyncio.run(scenario())


@pytest.mark.parametrize("stored", ["before_the_timeline", "with_its_timeline"])
def test_a_run_purge_keeps_the_media_the_timeline_shows(
    tmp_path: Path, stored: str
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            gen = descriptor(NODE_A, "gen")
            node = FakeNode(NODE_A, ENDPOINT_A, [gen])
            node.files = FileStore(tmp_path / "node-a", NODE_A)
            await h.add_node(node)
            run = await h.wait_run(
                (
                    await h.start_run(
                        pipeline([step("gen", NODE_A, "gen", params={"produce": True})])
                    )
                )["run_id"]
            )
            asset = run["steps"]["gen"]["outputs"]["asset"]["value"]
            shown = (asset["file"]["node_id"], asset["file"]["file_id"])
            doc = project(
                [
                    shot(
                        "s1",
                        [take("t1", 1, frames=1, run_id=run["run_id"], asset=asset)],
                    )
                ],
                revision=1,
            )
            if stored == "with_its_timeline":
                await saved(h, {**doc, "revision": 0})
            else:
                stored_path(h).write_text(
                    json.dumps(doc, ensure_ascii=False), encoding="utf-8"
                )
            assert shown in h.ctl.studio.library_file_keys()

            plan = (
                await h.client.delete(
                    f"/api/runs/{run['run_id']}", params={"dry_run": "true"}
                )
            ).json()
            status = {
                (item["node_id"], item["file_id"]): item["status"]
                for item in plan["files"]
            }
            assert status[shown] == "kept" and set(status.values()) == {
                "kept",
                "planned",
            }
            purged = await h.client.delete(f"/api/runs/{run['run_id']}")
            assert purged.status_code == 200 and purged.json()["deleted"] is True, (
                purged.text
            )
            assert node.files.meta(shown[1]) is not None
            assert all(
                node.files.meta(key[1]) is None for key in status if key != shown
            )

            after = await read(h)
            source = after["timeline"]["sources"][0]
            assert after["shots"][0]["takes"] == [] and after["revision"] == 2
            assert (
                source["file"]["file_id"] == shown[1]
                and len(after["timeline"]["clips"]) == 2
            )
            assert (
                after["shots"][0]["enabled"] is True
                and shown in h.ctl.studio.library_file_keys()
            )
            if stored == "before_the_timeline":
                assert json.loads(legacy_path(h).read_text(encoding="utf-8")) == doc

    asyncio.run(scenario())


def test_examples_of_the_new_bodies_are_what_the_openapi_paths_name() -> None:
    openapi = json.loads(
        (contracts.contracts_dir() / contracts.OPENAPI_FILE).read_text(encoding="utf-8")
    )
    project_path = "/api/studio/projects/{project_id}"
    commands = openapi["paths"][f"{project_path}/timeline/commands"]["post"]
    export = openapi["paths"][f"{project_path}/timeline/export"]["post"]
    schema = "#/components/schemas/"
    assert commands["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": f"{schema}StudioTimelineCommandsRequest"
    }
    assert commands["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": f"{schema}StudioTimelineCommandsResult"
    }
    assert export["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": f"{schema}StudioTimelineExportRequest"
    }
    assert export["responses"]["202"]["content"]["application/json"]["schema"] == {
        "$ref": f"{schema}StudioTimelineExportResult"
    }
    assert "get" in openapi["paths"][f"{project_path}/legacy"]
    body = {
        "revision": 3,
        "range": "work_area",
        "size": "1080p",
        "fit": "fit",
        "quality": "small",
        "speed": "veryfast",
        "audio_kbps": 256,
    }
    contracts.validate("StudioTimelineExportRequest", body)
