"""Portable project data integrity and the publication boundary across Controllers."""

from __future__ import annotations

import asyncio
import io
import shutil
import zipfile
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
    step,
)
from phasyn_components.ids import new_id
from test_ctl_studio import project


_HEADERS = {"content-type": "application/zip"}


def _alter(
    archive: bytes,
    *,
    drop: str | None = None,
    corrupt: str | None = None,
    extra: str | None = None,
) -> bytes:
    output = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(archive)) as src,
        zipfile.ZipFile(output, "w") as dst,
    ):
        for name in src.namelist():
            if name != drop:
                payload = src.read(name)
                dst.writestr(
                    name, (b"!" * len(payload)) if name == corrupt else payload
                )
        if extra:
            dst.writestr(extra, b"outside")
    return output.getvalue()


async def _source_package(
    tmp_path: Path,
) -> tuple[bytes, dict[str, Any], dict[str, Any], str]:
    async with Harness(tmp_path / "source") as source:
        await source.add_node(
            FakeNode(
                NODE_A, ENDPOINT_A, [descriptor(NODE_A, "a", resource_group="cpu")]
            )
        )
        run = await source.start_run(pipeline([step("create", NODE_A, "a")]))
        run = await source.wait_run(run["run_id"])
        doc = project()
        doc["shots"][0]["takes"][0]["run_id"] = run["run_id"]
        files = source.ctl.files
        child = files.new_writer("application/octet-stream")
        child.write(b"attached")
        link = child.commit()
        parent = files.new_writer("image/png", {"links": {"data": link}})
        parent.write(b"pixels")
        img = parent.commit()
        doc["library"] = [
            {
                "item_id": "image-a",
                "kind": "image",
                "name": "A",
                "file": img,
                "created_at": doc["created_at"],
                "duration_seconds": None,
                "width": 1,
                "height": 1,
                "has_audio": False,
            }
        ]
        project_response = await source.client.put("/api/studio/projects/p1", json=doc)
        assert project_response.status_code == 200, project_response.text
        revision = project_response.json()["revision"]
        source.ctl.studio.creative.write(
            "p1",
            "entry",
            "hero",
            {
                "project_revision": revision,
                "expected_revision": 0,
                "name": "Hero",
                "kind": "character",
                "fields": {"coat": "red"},
                "reference_items": ["image-a"],
            },
        )
        archived = await source.client.get(
            f"/api/studio/projects/p1/portable?revision={revision}"
        )
        assert archived.status_code == 200, archived.text
        return archived.content, img, link, run["run_id"]


def test_cross_controller_archive_preserves_assets_and_never_dispatches(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        raw, img, link, rid = await _source_package(tmp_path)
        async with Harness(tmp_path / "destination", instance_id=new_id()) as target:
            client = target.client
            check = await client.post(
                "/api/studio/portable/inspect", content=raw, headers=_HEADERS
            )
            assert check.status_code == 200, check.text
            report = check.json()
            assert (
                report["file_count"],
                report["run_count"],
                report["take_count"],
                report["importable"],
            ) == (2, 1, 1, True)
            name = f"media/{link['sha256']}"
            for damaged in (
                _alter(raw, drop=name),
                _alter(raw, corrupt=name),
                _alter(raw, extra="../unexpected"),
            ):
                result = await client.post(
                    "/api/studio/portable/import/new", content=damaged, headers=_HEADERS
                )
                assert result.status_code >= 400
                assert target.ctl.studio.project_revision("new") is None
                assert target.ctl.files.meta(img["file_id"]) is None
            loaded = await client.post(
                "/api/studio/portable/import/new", content=raw, headers=_HEADERS
            )
            assert loaded.status_code == 200, loaded.text
            saved = loaded.json()["project"]
            local = saved["library"][0]["file"]
            assert (
                local["node_id"]
                == local["metadata"]["links"]["data"]["node_id"]
                == target.ctl.instance_id
            )
            assert (
                target.ctl.files.payload_path(link["file_id"]).read_bytes()
                == b"attached"
            )
            version = target.ctl.studio.creative.read("new", "entry", "hero", 1)[
                "version"
            ]
            assert version["references"][0]["file"] == local
            historical = (
                await client.get("/api/studio/projects/new/portable/history")
            ).json()["runs"]
            assert [r["run_id"] for r in historical] == [rid]
            assert not target.ctl.runs.page(None, 10)[0]
            assert not target.ctl.studio.run_references(rid)
            assert target.ctl.studio.remove_run_refs("new", rid) is None
            assert (
                target.ctl.instance_id,
                link["file_id"],
            ) in target.ctl.studio.library_file_keys()
            again = await client.post(
                "/api/studio/portable/import/new", content=raw, headers=_HEADERS
            )
            assert again.status_code == 409
            assert target.ctl.studio.get("new") == saved

    asyncio.run(scenario())


def test_an_import_takes_the_title_the_studio_gives_it(tmp_path: Path) -> None:
    async def scenario() -> None:
        raw, _img, _link, _rid = await _source_package(tmp_path)
        async with Harness(tmp_path / "destination", instance_id=new_id()) as target:
            client = target.client
            for bad in ("", "   ", "x" * 201):
                refused = await client.post(
                    "/api/studio/portable/import/blank",
                    params={"title": bad},
                    content=raw,
                    headers=_HEADERS,
                )
                assert refused.status_code == 422, refused.text
                assert target.ctl.studio.project_revision("blank") is None
            loaded = await client.post(
                "/api/studio/portable/import/renamed",
                params={"title": " 測試（匯入） "},
                content=raw,
                headers=_HEADERS,
            )
            assert loaded.status_code == 200, loaded.text
            assert loaded.json()["project"]["title"] == "測試（匯入）"
            assert target.ctl.studio.get("renamed")["title"] == "測試（匯入）"
            kept = await client.post(
                "/api/studio/portable/import/kept", content=raw, headers=_HEADERS
            )
            assert kept.status_code == 200, kept.text
            assert kept.json()["project"]["title"] == project()["title"]

    asyncio.run(scenario())


@pytest.mark.parametrize("lost", ["directory", "content"])
def test_an_export_missing_a_media_file_is_refused_with_its_digest(
    tmp_path: Path, lost: str
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "source") as source:
            doc = project()
            writer = source.ctl.files.new_writer("image/png")
            writer.write(b"pixels")
            img = writer.commit()
            doc["library"] = [
                {
                    "item_id": "image-a",
                    "kind": "image",
                    "name": "A",
                    "file": img,
                    "created_at": doc["created_at"],
                    "duration_seconds": None,
                    "width": 1,
                    "height": 1,
                    "has_audio": False,
                }
            ]
            put = await source.client.put("/api/studio/projects/p1", json=doc)
            assert put.status_code == 200, put.text
            payload = source.ctl.files.payload_path(img["file_id"])
            if lost == "content":
                # The record survives but its content is gone (a partial cleanup or copy)
                payload.unlink()
            else:
                # The stored file is gone (its whole directory), as after a lost disk or a purge.
                shutil.rmtree(payload.parent)
            archived = await source.client.get(
                f"/api/studio/projects/p1/portable?revision={put.json()['revision']}"
            )
            assert archived.status_code == 409, archived.text
            error = archived.json()
            assert error["code"] == "STATE_CONFLICT"
            assert error["details"]["missing"] == [
                {"sha256": img["sha256"], "reason": "FILE_NOT_FOUND"}
            ]

    asyncio.run(scenario())
