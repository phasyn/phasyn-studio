"""推理 Studio 反推研究文件：revision 409、append-only 版本、終態任務、預算、接受規則、封存，以及兩種刪除模式
（預覽範圍、共用保留、一次請求、部分失敗停止並回報、不自動重試）與 openapi 鏡像。"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import uuid
from pathlib import Path
from typing import Any

import pytest
from controller_support import (
    CONTROLLER_ID,
    ENDPOINT_A,
    NODE_A,
    FakeNode,
    Harness,
    descriptor,
)
from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.testing import ids

from phasyn_controller.runs import encode_run


URL = "/api/prompt-studies"
NOW = "2026-10-18T00:00:00.000Z"
KEYS = (
    "subject",
    "action",
    "composition",
    "environment",
    "lighting",
    "appearance",
    "style",
    "visible_text",
)
CORE = {"subject", "action", "composition", "style", "visible_text"}
SOURCE = {
    "node_id": CONTROLLER_ID,
    "file_id": ids.uid(1),
    "size_bytes": 10,
    "sha256": "a" * 64,
    "media_type": "image/png",
    "metadata": {},
}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def scene(
    language: str = "zh-TW",
    *,
    subject: str = "一個紅色茶壺。",
    locked: tuple[str, ...] = (),
) -> dict[str, Any]:
    sections = {
        key: {
            "text_en": "",
            "text_zh_tw": "",
            "explanation_zh_tw": "",
            "observation_ids": [],
            "locked": key in locked,
        }
        for key in KEYS
    }
    zh = language == "zh-TW"
    sections["subject"].update(
        text_en="A red teapot.",
        text_zh_tw=subject if zh else "",
        explanation_zh_tw="可見",
        observation_ids=["o001"],
    )
    sections["composition"].update(
        text_en="It is centered.",
        text_zh_tw="置中。" if zh else "",
        explanation_zh_tw="位置",
        observation_ids=["o002"],
    )
    sections["lighting"].update(  # 不在 core：detailed 與 core 不同
        text_en="Soft light.",
        text_zh_tw="柔光。" if zh else "",
        explanation_zh_tw="光線",
        observation_ids=["o003"],
    )
    observations = [
        {
            "id": "o001",
            "view_id": "v-full",
            "section": "subject",
            "claim_en": "A teapot.",
            "certainty": "observed",
        },
        {
            "id": "o002",
            "view_id": "v-full",
            "section": "composition",
            "claim_en": "Centered.",
            "certainty": "observed",
        },
        {
            "id": "o003",
            "view_id": "v-full",
            "section": "lighting",
            "claim_en": "Soft light.",
            "certainty": "observed",
        },
    ]
    return {
        "schema_version": 1,
        "prompt_language": language,
        "sections": sections,
        "observations": observations,
        "uncertainty_notes": [],
    }


def candidates(
    value: dict[str, Any], intentional: tuple[str, ...] = ()
) -> dict[str, Any]:
    field = "text_zh_tw" if value["prompt_language"] == "zh-TW" else "text_en"
    core = (
        CORE
        | set(intentional)
        | {key for key in KEYS if value["sections"][key]["locked"]}
    )
    items = []
    for variant in ("core", "detailed"):
        keys = [
            key
            for key in KEYS
            if (variant == "detailed" or key in core)
            and value["sections"][key][field].strip()
        ]
        prompt = "\n".join(value["sections"][key][field].strip() for key in keys)
        items.append(
            {
                "variant": variant, "prompt": prompt, "prompt_sha256": sha(prompt), "sections": keys,
                "token_status": "unchecked", "target_tokens": None, "token_reason": "CPU 編譯未檢查",
            }
        )  # fmt: skip
    return {
        "compiler_version": "prompt-compiler/1",
        "compiler_sha256": "0" * 64,
        "language": value["prompt_language"],
        "scene_sha256": digest(value),
        "intentional_changes": list(intentional),
        "identical": items[0]["prompt_sha256"] == items[1]["prompt_sha256"],
        "items": items,
    }


# Named fixture fields map directly to independent version metadata.
def version(  # noqa: PLR0913
    version_id: str,
    number: int,
    value: dict[str, Any],
    *,
    parent: str | None = None,
    origin: str = "analysis",
    intentional: tuple[str, ...] = (),
    run_ids: tuple[str, ...] = (),
) -> dict[str, Any]:
    return {
        "version_id": version_id,
        "number": number,
        "parent_version_id": parent,
        "origin": origin,
        "scene": value,
        "intentional_changes": list(intentional),
        "candidates": candidates(value, intentional),
        "provenance": {
            "kind": "manual" if origin == "manual" else "vision",
            "task_id": None,
            "run_ids": list(run_ids),
            "vision": None,
            "compile": None,
        },
        "note": "",
        "created_at": NOW,
    }


def render(
    version_id: str, variant: str, seed: int, run_id: str, *, state: str = "succeeded"
) -> dict[str, Any]:
    return {
        "kind": "render", "version_id": version_id, "variant": variant, "seed": seed, "split": "manual", "round": 0,
        "run_id": run_id, "state": state, "image": None, "image_asset": None, "error": None,
    }  # fmt: skip


# Named fixture fields map directly to independent task metadata.
def task(  # noqa: PLR0913
    task_id: str,
    *,
    state: str = "running",
    base: str | None = "v1",
    request: dict[str, Any] | None = None,
    run_ids: tuple[str, ...] = (),
    results: tuple[dict[str, Any], ...] = (),
) -> dict[str, Any]:
    req = request or {
        "kind": "render",
        "variants": ["core", "detailed"],
        "seeds": [1, 2],
        "settings": {"steps": 40},
    }
    return {
        "task_id": task_id,
        "kind": req["kind"],
        "state": state,
        "phase": None,
        "stop_reason": None if state == "running" else "completed",
        "base_version_id": base,
        "request": req,
        "rubric": None,
        "run_ids": list(run_ids),
        "result_refs": list(results),
        "best": None,
        "verification": "rendered" if results else "analysis_only",
        "error": None,
        "message": "",
        "created_at": NOW,
        "updated_at": NOW,
        "finished_at": None if state == "running" else NOW,
    }


def study(
    study_id: str, source: dict[str, Any] = SOURCE, **fields: Any
) -> dict[str, Any]:
    doc = {
        "study_id": study_id,
        "title": f"研究 {study_id}",
        "revision": 0,
        "created_at": NOW,
        "updated_at": NOW,
        "language": "zh-TW",
        "source": {
            "file": source,
            "name": "teapot.png",
            "width": 640,
            "height": 480,
            "library_item": None,
        },
        "crops": [],
        "settings": {"render_pipeline_id": "t2i-local"},
        "versions": [],
        "tasks": [],
        "accepted_version_id": None,
        "acceptance": None,
        "archived": False,
        "note": "",
    }
    doc.update(fields)
    return doc


async def put(h: Harness, doc: dict[str, Any], status: int = 200) -> dict[str, Any]:
    resp = await h.client.put(f"{URL}/{doc['study_id']}", json=doc)
    assert resp.status_code == status, resp.text
    return dict(resp.json())


async def saved(h: Harness, doc: dict[str, Any]) -> dict[str, Any]:
    result = await put(h, doc)
    contracts.validate("PromptStudy", result)
    return result


def test_crud_revision_conflict_listing_and_contract(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            assert (await h.client.get(URL)).json() == {"items": []}
            first = await saved(h, study("s1"))
            assert first["revision"] == 1 and first["updated_at"] != NOW
            assert (await h.client.get(f"{URL}/s1")).json() == first
            stale = await put(h, study("s1", title="別的分頁"), 409)
            assert stale["code"] == "REVISION_CONFLICT" and stale["details"] == {
                "stored_revision": 1,
                "expected_revision": 0,
            }
            again = await saved(h, {**first, "title": "茶壺"})
            assert again["revision"] == 2 and again["created_at"] == first["created_at"]
            mismatch = await h.client.put(f"{URL}/other", json=again)
            assert (
                mismatch.status_code == 422
                and mismatch.json()["code"] == "INVALID_ARGUMENT"
            )
            invalid = await put(h, {**again, "language": "ja"}, 422)
            assert invalid["details"]["schema"] == "PromptStudy"
            await saved(h, study("s2", archived=True))
            listing = (await h.client.get(URL)).json()["items"]
            assert [item["study_id"] for item in listing] == ["s1"]
            contracts.validate("PromptStudyList", {"items": listing})
            assert (
                listing[0]["source_name"] == "teapot.png"
                and listing[0]["version_count"] == 0
            )
            only = (await h.client.get(URL, params={"archived": "only"})).json()[
                "items"
            ]
            assert [item["study_id"] for item in only] == ["s2"]
            assert (
                len(
                    (await h.client.get(URL, params={"archived": "include"})).json()[
                        "items"
                    ]
                )
                == 2
            )
            assert (
                await h.client.get(URL, params={"archived": "yes"})
            ).status_code == 422
            missing = await h.client.get(f"{URL}/nope")
            assert missing.status_code == 404 and missing.json()["code"] == "NOT_FOUND"

    asyncio.run(scenario())


def test_versions_are_append_only_and_internally_consistent(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            v1 = version("v1", 1, scene())
            doc = await saved(h, study("s1", versions=[v1]))
            edited = copy.deepcopy(doc)
            edited["versions"][0]["note"] = "改寫歷史"
            changed = await put(h, edited, 409)
            assert (
                changed["code"] == "STATE_CONFLICT"
                and changed["details"]["version_id"] == "v1"
            )
            assert (await put(h, {**doc, "versions": []}, 409))[
                "code"
            ] == "STATE_CONFLICT"
            assert (await put(h, {**doc, "language": "en"}, 409))[
                "code"
            ] == "STATE_CONFLICT"
            moved = {**doc, "source": {**doc["source"], "name": "other.png"}}
            assert (await put(h, moved, 409))["code"] == "STATE_CONFLICT"
            crops = [{"view_id": "v-crop-1", "x0": 0, "y0": 0, "x1": 0.5, "y1": 0.5}]
            assert "裁切" in (await put(h, {**doc, "crops": crops}, 409))["message"]

            locked = scene(subject="一個藍色茶壺。", locked=("subject",))
            bad_cases = {
                "number": {**version("v2", 3, locked, parent="v1", origin="manual")},
                "parent": {**version("v2", 2, locked, origin="manual")},
                "sha": {
                    **version("v2", 2, locked, parent="v1", origin="manual"),
                    "scene": scene(subject="改過"),
                },
                "unlocked": version(
                    "v2",
                    2,
                    scene(),
                    parent="v1",
                    origin="manual",
                    intentional=("lighting",),
                ),
                "language": version("v2", 2, scene("en"), parent="v1", origin="manual"),
            }
            for name, bad in bad_cases.items():
                result = await put(h, {**doc, "versions": [*doc["versions"], bad]}, 422)
                assert result["code"] == "INVALID_ARGUMENT", (name, result)
            wrong_ref = scene()
            wrong_ref["sections"]["subject"]["observation_ids"] = ["o002"]
            result = await put(h, {**doc, "versions": [*doc["versions"], version("v2", 2, wrong_ref, parent="v1", origin="manual")]}, 422)  # fmt: skip
            assert "composition" in result["message"]
            crop_ref = scene()
            crop_ref["observations"][0]["view_id"] = "v-crop-1"
            result = await put(h, {**doc, "versions": [*doc["versions"], version("v2", 2, crop_ref, parent="v1", origin="manual")]}, 422)  # fmt: skip
            assert "視圖" in result["message"]
            tampered = version(
                "v2", 2, locked, parent="v1", origin="manual", intentional=("subject",)
            )
            tampered["candidates"]["items"][0]["prompt"] += "（偷改）"
            assert (
                "prompt_sha256"
                in (
                    await put(h, {**doc, "versions": [*doc["versions"], tampered]}, 422)
                )["message"]
            )

            good = version(
                "v2", 2, locked, parent="v1", origin="manual", intentional=("subject",)
            )
            appended = await saved(h, {**doc, "versions": [*doc["versions"], good]})
            assert [item["number"] for item in appended["versions"]] == [1, 2]

    asyncio.run(scenario())


def test_tasks_terminal_immutable_budgets_and_archive(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            v1 = version("v1", 1, scene())
            run_id = str(uuid.uuid4())
            reconstruct = {
                "kind": "reconstruct", "search_seeds": [11, 22], "holdout_seeds": [33, 44], "max_rounds": 2,
                "max_images": 16, "max_vision_operations": 96, "stop_after_no_improvement": 1, "settings": {},
            }  # fmt: skip
            running = task(
                "t1",
                request=reconstruct,
                run_ids=(run_id,),
                results=(render("v1", "core", 11, run_id),),
            )
            doc = await saved(h, study("s1", versions=[v1], tasks=[running]))
            changed_request = copy.deepcopy(doc)
            changed_request["tasks"][0]["request"]["max_images"] = 32
            assert "request" in (await put(h, changed_request, 409))["message"]
            archive = await put(h, {**doc, "archived": True}, 409)
            assert archive["details"]["running_task_ids"] == ["t1"]
            done = copy.deepcopy(doc)
            done["tasks"][0].update(
                state="succeeded",
                stop_reason="completed",
                finished_at=NOW,
                phase="done",
            )
            doc = await saved(h, done)
            revived = copy.deepcopy(doc)
            revived["tasks"][0]["state"] = "running"
            revived["tasks"][0]["finished_at"] = None
            assert (await put(h, revived, 409))["details"]["task_id"] == "t1"
            assert (await put(h, {**doc, "tasks": []}, 409))["code"] == "STATE_CONFLICT"

            overlap = task("t2", request={**reconstruct, "holdout_seeds": [22, 55]})
            assert (
                "重疊"
                in (await put(h, {**doc, "tasks": [*doc["tasks"], overlap]}, 422))[
                    "message"
                ]
            )
            small = task("t2", request={**reconstruct, "max_images": 8})
            assert (
                "預算"
                in (await put(h, {**doc, "tasks": [*doc["tasks"], small]}, 422))[
                    "message"
                ]
            )
            many = task("t2", request={**reconstruct, "max_rounds": 1, "max_images": 8},
                        results=tuple(render("v1", "core", seed, run_id) for seed in range(9)))  # fmt: skip
            assert (
                "超過預算"
                in (await put(h, {**doc, "tasks": [*doc["tasks"], many]}, 422))[
                    "message"
                ]
            )
            no_base = task("t2", base=None)
            assert (
                "base_version_id"
                in (await put(h, {**doc, "tasks": [*doc["tasks"], no_base]}, 422))[
                    "message"
                ]
            )
            ghost = task("t2", base="v9")
            assert (await put(h, {**doc, "tasks": [*doc["tasks"], ghost]}, 422))[
                "code"
            ] == "INVALID_ARGUMENT"

            archived = await saved(h, {**doc, "archived": True})
            more = await put(
                h, {**archived, "tasks": [*archived["tasks"], task("t2")]}, 409
            )
            assert "封存" in more["message"]
            await saved(h, {**archived, "archived": False})

    asyncio.run(scenario())


# ---------------------------------------------------------------------- deletion
def write_run(h: Harness, outputs: dict[str, Any], *, state: str = "succeeded") -> str:
    run_id = str(uuid.uuid4())
    run: dict[str, Any] = {
        "run_id": run_id,
        "state": state,
        "request": {
            "pipeline": {
                "pipeline_id": "p",
                "label": "",
                "inputs": [],
                "steps": [
                    {
                        "step_id": "s",
                        "node_id": NODE_A,
                        "component_id": "gen",
                        "inputs": {},
                        "parameters": {},
                    }
                ],
                "outputs": {},
            },
            "inputs": {},
        },
        "created_at": NOW,
        "finished_at": NOW,
        "steps": {"s": {"state": state, "outputs": outputs}},
        "outputs": {},
        "recording_ids": [],
        "error": None,
    }
    contracts.validate("Run", run)
    h.ctl.runs.write(run_id, encode_run(run))
    h.ctl.runs.add(NOW, run_id)
    return run_id


def image_outputs(node: FakeNode) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """t2i 的輸出：image.asset.v1（inline 值內嵌的 FileRef，purge 一樣會刪）+一個頂層 FileRef。"""
    image = node.publish_file(b"png rgba", "image/png")
    white = node.publish_file(b"png white", "image/png")
    asset = {"asset_id": str(uuid.uuid4()), "file": image, "width": 8, "height": 8}
    return {
        "image": {"type_id": "image.asset.v1", "value": asset},
        "image_white": {"type_id": "media.image.v1", "file": white},
    }, [image, white]


def library_project(ref: dict[str, Any]) -> dict[str, Any]:
    item = {
        "item_id": "img-1", "kind": "image", "name": "白底", "file": ref, "created_at": NOW, "duration_seconds": None,
        "width": 8, "height": 8, "has_audio": None,
    }  # fmt: skip
    return {
        "project_id": "p1", "title": "專案", "revision": 0, "created_at": NOW, "updated_at": NOW,
        "format": {"width": 768, "height": 448, "fps": {"num": 24, "den": 1}},
        "defaults": {"frames": 124, "route": "route-a", "steps": None}, "shots": [], "exports": [], "library": [item],
    }  # fmt: skip


async def upload(h: Harness, data: bytes = b"\x89PNG source") -> dict[str, Any]:
    resp = await h.client.post(
        "/api/files", params={"media_type": "image/png"}, content=data
    )
    assert resp.status_code == 201, resp.text
    return dict(resp.json())


def node_with_files(tmp_path: Path) -> FakeNode:
    node = FakeNode(NODE_A, ENDPOINT_A, [descriptor(NODE_A, "gen")])
    node.files = FileStore(tmp_path / "node-a", NODE_A)
    return node


async def assert_shared_run_protected(h: Harness, other_run: str) -> None:
    # A run cited by a study cannot be purged on its own (dry run included); the 409 names the studies.
    for dry_run in ("true", "false"):
        refused = await h.client.delete(
            f"/api/runs/{other_run}", params={"dry_run": dry_run}
        )
        assert (
            refused.status_code == 409 and refused.json()["code"] == "STATE_CONFLICT"
        ), refused.text
        cited = refused.json()["details"]["prompt_studies"]
        assert sorted(item["study_id"] for item in cited) == ["s1", "s2"]
    assert (await h.client.get(f"/api/runs/{other_run}")).status_code == 200


async def assert_deletion_needs_revision_and_mode(h: Harness, revision: int) -> None:
    stale = await h.client.delete(f"{URL}/s1", params={"mode": "all", "revision": 0})
    assert stale.status_code == 409 and stale.json()["code"] == "REVISION_CONFLICT"
    assert (
        await h.client.delete(f"{URL}/s1", params={"revision": revision})
    ).status_code == 422


def assert_exclusive_files_deleted(
    node: FakeNode, files: list[dict[str, Any]], shared_files: list[dict[str, Any]]
) -> None:
    assert node.files is not None
    for ref in files:  # 包含 image.asset.v1 內嵌的檔案
        assert node.files.meta(ref["file_id"]) is None
    for ref in shared_files:
        assert node.files.meta(ref["file_id"]) is not None


def test_deletion_modes_preview_scope_and_execute(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = node_with_files(tmp_path)
            await h.add_node(node)
            source = await upload(h)
            analysis = write_run(
                h,
                {
                    "result": {
                        "type_id": "prompt.vision.result.v1",
                        "value": {"op": "caption"},
                    }
                },
            )
            outputs, files = image_outputs(node)
            image_run = write_run(h, outputs)
            shared_outputs, shared_files = image_outputs(node)
            studio_run = write_run(h, shared_outputs)
            other_run = write_run(
                h, {"result": {"type_id": "prompt.vision.result.v1", "value": {}}}
            )
            ghost = str(uuid.uuid4())
            resp = await h.client.put(
                "/api/studio/projects/p1", json=library_project(shared_files[1])
            )
            assert resp.status_code == 200, resp.text
            v1 = version("v1", 1, scene(), run_ids=(analysis,))
            finished = task(
                "t1",
                state="succeeded",
                run_ids=(image_run, studio_run, other_run, ghost),
                results=(
                    render("v1", "core", 1, image_run),
                    render("v1", "detailed", 1, studio_run),
                ),
            )
            doc = await saved(h, study("s1", source, versions=[v1], tasks=[finished]))
            other = await saved(h, study("s2", source=SOURCE, versions=[version("v1", 1, scene())],
                                         tasks=[task("t9", state="failed", run_ids=(other_run,))]))  # fmt: skip

            keep = (
                await h.client.get(
                    f"{URL}/s1/deletion-preview", params={"mode": "keep_images"}
                )
            ).json()
            contracts.validate("PromptStudyDeletionPlan", keep)
            actions = {
                row["run_id"]: (row["role"], row["action"]) for row in keep["runs"]
            }
            assert actions == {
                image_run: ("image", "keep"),
                studio_run: ("image", "shared"),
                other_run: ("analysis", "shared"),
                ghost: ("unknown", "missing"),
                analysis: ("analysis", "delete"),
            }
            assert (
                keep["dry_run"] is True
                and keep["can_delete"] is True
                and keep["counts"]["runs_delete"] == 1
            )
            assert (
                keep["source"]["action"] == "delete"
                and keep["source"]["file"] == source
            )
            everything = (
                await h.client.get(f"{URL}/s1/deletion-preview", params={"mode": "all"})
            ).json()
            assert {row["run_id"]: row["action"] for row in everything["runs"]}[
                image_run
            ] == "delete"
            assert everything["counts"] == {
                "versions": 1, "tasks": 1, "evaluations": 0, "images": 0, "runs_delete": 2, "runs_keep": 2,
            }  # fmt: skip
            assert (
                await h.client.get(f"{URL}/s1/deletion-preview", params={"mode": "x"})
            ).status_code == 422

            await assert_shared_run_protected(h, other_run)

            await assert_deletion_needs_revision_and_mode(h, doc["revision"])

            resp = await h.client.delete(
                f"{URL}/s1", params={"mode": "all", "revision": doc["revision"]}
            )
            assert resp.status_code == 200, resp.text
            result = resp.json()
            contracts.validate("PromptStudyDeletionPlan", result)
            assert result["deleted"] is True and result["dry_run"] is False
            statuses = {row["run_id"]: row["status"] for row in result["runs"]}
            assert statuses == {image_run: "deleted", analysis: "deleted", studio_run: "kept", other_run: "kept",
                                ghost: "missing"}  # fmt: skip
            assert result["source"]["status"] == "deleted"
            assert (await h.client.get(f"{URL}/s1")).status_code == 404
            for gone in (image_run, analysis):
                assert (await h.client.get(f"/api/runs/{gone}")).status_code == 404
            for kept in (studio_run, other_run):
                assert (await h.client.get(f"/api/runs/{kept}")).status_code == 200
            assert_exclusive_files_deleted(node, files, shared_files)
            with pytest.raises(ComponentError):
                h.ctl.files.fileref(source["file_id"])
            assert (await h.client.get(f"{URL}/s2")).json() == other
            still_cited = await h.client.delete(f"/api/runs/{other_run}")
            assert still_cited.status_code == 409
            assert [
                item["study_id"]
                for item in still_cited.json()["details"]["prompt_studies"]
            ] == ["s2"]

    asyncio.run(scenario())


def test_deletion_blocks_running_work_and_stops_on_partial_failure(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = node_with_files(tmp_path)
            await h.add_node(node)
            source = await upload(h)
            outputs, files = image_outputs(node)
            image_run = write_run(h, outputs)
            v1 = version("v1", 1, scene())
            doc = await saved(
                h,
                study(
                    "s1",
                    source,
                    versions=[v1],
                    tasks=[task("t1", run_ids=(image_run,))],
                ),
            )
            plan = (
                await h.client.get(
                    f"{URL}/s1/deletion-preview", params={"mode": "keep_images"}
                )
            ).json()
            assert (
                plan["can_delete"] is False
                and plan["blocking"][0]["code"] == "TASK_RUNNING"
            )
            blocked = await h.client.delete(
                f"{URL}/s1", params={"mode": "keep_images", "revision": doc["revision"]}
            )
            assert (
                blocked.status_code == 409
                and blocked.json()["details"]["blocking"][0]["task_id"] == "t1"
            )

            stopped = copy.deepcopy(doc)
            stopped["tasks"][0].update(
                state="interrupted", stop_reason="interrupted", finished_at=NOW
            )
            doc = await saved(h, stopped)
            node.file_delete_errors["*"] = ComponentError(
                "RUNTIME_ERROR", "假 Node：磁碟唯讀"
            )
            failed = await h.client.delete(
                f"{URL}/s1", params={"mode": "all", "revision": doc["revision"]}
            )
            assert failed.status_code == 502, failed.text
            body = failed.json()
            assert "已停止" in body["message"] and "不自動重試" in body["message"]
            rows = {row["run_id"]: row for row in body["details"]["runs"]}
            assert (
                rows[image_run]["status"] == "failed"
                and body["details"]["deleted"] is False
            )
            assert body["details"]["source"]["status"] == "planned"  # 原圖還沒動
            assert (await h.client.get(f"{URL}/s1")).status_code == 200  # 研究文件保留
            assert (await h.client.get(f"/api/runs/{image_run}")).status_code == 200
            h.ctl.files.fileref(source["file_id"])  # 仍在

            node.file_delete_errors.clear()
            retried = await h.client.delete(
                f"{URL}/s1", params={"mode": "all", "revision": doc["revision"]}
            )
            assert retried.status_code == 200, retried.text
            assert {row["run_id"]: row["status"] for row in retried.json()["runs"]} == {
                image_run: "deleted"
            }
            assert node.files is not None and all(
                node.files.meta(ref["file_id"]) is None for ref in files
            )

    asyncio.run(scenario())
