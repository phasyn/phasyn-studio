"""Plugin packages on the Controller: the boundaries of installing, serving and removing data from strangers.

Upload limits and what a refused or stalled upload leaves behind, browser origins, built-in and development packages,
the file route, the config switch, start-up clean-up, and that removing a package never edits a project document.
"""

from __future__ import annotations

import asyncio
import errno
import hashlib
import io
import json
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from controller_support import CONTROLLER_HOST, Harness
from phasyn_components import contracts
from phasyn_components.canonical import canonical_json, sha256_hex

from phasyn_controller.plugins import api as plugin_api, store as plugin_store


URL = "/api/studio/plugins"
PACKAGE = {"Content-Type": "application/octet-stream"}
PLUGIN = "com.example.pack"
RESERVED = "phasyn.example"  # the phasyn. prefix is reserved for built-in packages
BUILTINS: list[str] = []  # this build ships no built-in packages
EMPTY_STORE = [
    "packages",
    "registry.json",
    "staging",
]  # what a store holds while nothing is installed
PNG = b"\x89PNG\r\n\x1a\n" + bytes(24)
README = b"# Example\n"
RULES = {
    "rules": [
        {
            "id": "no-side-view",
            "kind": "constraint",
            "label": {"en": "No side view"},
            "forbid": [
                {
                    "id": "side",
                    "terms": ["side view"],
                    "word": True,
                    "message": {"en": "side view"},
                }
            ],
        }
    ]
}


def manifest(files: dict[str, bytes], **changes: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "manifest_version": 1,
        "id": PLUGIN,
        "version": "1.0.0",
        "name": {"en": "Pack"},
        "engines": {"phasyn": ">=0.0.0 <1000.0.0"},
        "contributes": RULES,
        "integrity": {
            "algorithm": "sha256",
            "files": {
                path: hashlib.sha256(data).hexdigest() for path, data in files.items()
            },
        },
    }
    doc.update(changes)
    return doc


def package(files: dict[str, bytes] | None = None, **changes: Any) -> bytes:
    files = {"README.md": README, "assets/icon.png": PNG} if files is None else files
    target = io.BytesIO()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("plugin.json", json.dumps(manifest(files, **changes)))
        for path, data in files.items():
            bundle.writestr(path, data)
    return target.getvalue()


def code_package() -> bytes:
    code = {
        "main": "main.js",
        "permissions": ["project:read"],
        "engines": {"phasyn": ">=0.0.0 <1000.0.0", "plugin_api": 1},
    }
    return package(
        {
            "README.md": README,
            "assets/icon.png": PNG,
            "main.js": b"fetch('/api/runs')\n",
        },
        **code,
    )


def tree(root: Path) -> list[str]:
    return sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))


def registered(data_dir: Path) -> dict[str, Any]:
    """What the store's registry file names as installed."""
    registry = json.loads(
        (data_dir / "plugins" / "registry.json").read_text(encoding="utf-8")
    )
    return dict(registry["plugins"])


def plugin_ids(listing: dict[str, Any]) -> list[str]:
    contracts.validate("StudioPluginList", listing)
    return [item["plugin_id"] for item in listing["items"]]


async def install(h: Harness, data: bytes, query: str = "") -> httpx.Response:
    return await h.client.post(f"{URL}{query}", content=data, headers=PACKAGE)


def refused(
    response: httpx.Response, status: int, code: str, root: Path
) -> dict[str, Any]:
    """An error of the contract shape that names no path of this host."""
    assert response.status_code == status, response.text
    body = dict(response.json())
    contracts.validate("Error", body)
    assert body["code"] == code, body
    assert str(root) not in response.text
    return body


def test_oversized_and_invalid_uploads_leave_nothing(tmp_path: Path) -> None:
    async def chunks() -> AsyncIterator[bytes]:
        for _ in range(8):
            yield b"x" * 1024

    async def scenario() -> None:
        async with Harness(tmp_path, plugins={"max_package_bytes": 4096}) as h:
            store = tmp_path / "plugins"
            declared = await install(
                h, b"x" * 5000
            )  # refused on Content-Length, before any byte is read
            assert refused(declared, 413, "PAYLOAD_TOO_LARGE", tmp_path)["details"] == {
                "limit_bytes": 4096
            }
            streamed = await h.client.post(
                URL, content=chunks(), headers=PACKAGE
            )  # no length: counted as it arrives
            refused(streamed, 413, "PAYLOAD_TOO_LARGE", tmp_path)
            invalid = refused(
                await install(h, package(id="phasyn.evil")),
                422,
                "STUDIO_PLUGIN_INVALID",
                tmp_path,
            )
            assert [found["code"] for found in invalid["details"]["errors"]] == [
                "reserved_id"
            ]
            for found in invalid["details"]["errors"]:
                contracts.validate("StudioPluginIssue", found)
            refused(
                await install(h, b"not a zip archive"),
                422,
                "STUDIO_PLUGIN_INVALID",
                tmp_path,
            )
            refused(
                await h.client.post(URL, content=package()),
                415,
                "UNSUPPORTED_MEDIA_TYPE",
                tmp_path,
            )
            assert (
                tree(store) == EMPTY_STORE and registered(tmp_path) == {}
            )  # no upload, no content, no entry
            assert plugin_ids((await h.client.get(URL)).json()) == BUILTINS

    asyncio.run(scenario())


def test_a_second_write_is_refused_while_an_upload_is_in_progress(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            data = package()
            receiving, finish = asyncio.Event(), asyncio.Event()

            async def slow() -> AsyncIterator[bytes]:
                yield data[:64]
                receiving.set()
                await finish.wait()
                yield data[64:]

            first = asyncio.create_task(
                h.client.post(URL, content=slow(), headers=PACKAGE)
            )
            await receiving.wait()
            assert (
                len(tree(tmp_path / "plugins" / "staging")) == 2
            )  # one staging directory with one upload
            refused(
                await install(h, package(id="com.example.other")),
                409,
                "STATE_CONFLICT",
                tmp_path,
            )
            removal = await h.client.delete(
                f"{URL}/com.example.absent?digest={'0' * 64}"
            )  # 404 when nothing runs
            refused(removal, 409, "STATE_CONFLICT", tmp_path)
            assert (
                len(tree(tmp_path / "plugins" / "staging")) == 2
            )  # the refused upload was never written
            finish.set()
            assert (await first).status_code == 201
            assert plugin_ids((await h.client.get(URL)).json()) == [*BUILTINS, PLUGIN]
            assert tree(tmp_path / "plugins" / "staging") == []

    asyncio.run(scenario())


def test_a_stalled_upload_is_ended_and_leaves_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(plugin_api, "UPLOAD_IDLE_SECONDS", 0.05)

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            never = asyncio.Event()

            async def stalled() -> AsyncIterator[bytes]:
                yield package()[:64]
                await never.wait()  # a connection that died without closing

            ended = await asyncio.wait_for(
                h.client.post(URL, content=stalled(), headers=PACKAGE), 10
            )
            assert refused(ended, 422, "FILE_TRUNCATED", tmp_path)["details"] == {
                "idle_seconds": 0.05
            }
            assert (
                tree(tmp_path / "plugins") == EMPTY_STORE and registered(tmp_path) == {}
            )
            installed = await install(h, package())  # the single writer is free again
            assert installed.status_code == 201, installed.text

    asyncio.run(scenario())


def test_writes_from_another_site_or_an_opaque_origin_are_refused(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            installed = await install(h, package())
            assert installed.status_code == 201, installed.text
            digest = installed.json()["detail"]["plugin"]["digest"]
            hostile = [
                {"Origin": "null"},
                {"Origin": "http://evil.example"},
                {"Sec-Fetch-Site": "cross-site"},
            ]
            for headers in hostile:
                attempts = [
                    await h.client.post(
                        f"{URL}?replace=true",
                        content=package(version="2.0.0"),
                        headers={**PACKAGE, **headers},
                    ),
                    await h.client.delete(
                        f"{URL}/{PLUGIN}?digest={digest}", headers=headers
                    ),
                    await h.client.patch(
                        f"{URL}/{PLUGIN}",
                        json={"disabled": True, "expected_revision": 1},
                        headers=headers,
                    ),
                    await h.client.post(f"{URL}/{PLUGIN}/reload", headers=headers),
                ]
                for attempt in attempts:
                    refused(attempt, 400, "BAD_REQUEST", tmp_path)
                    assert "access-control-allow-origin" not in attempt.headers
            detail = (await h.client.get(f"{URL}/{PLUGIN}")).json()
            contracts.validate("StudioPluginDetail", detail)
            assert (
                detail["plugin"]["version"],
                detail["plugin"]["revision"],
                detail["plugin"]["disabled"],
            ) == (
                "1.0.0",
                1,
                False,
            )
            same_origin = {**PACKAGE, "Origin": CONTROLLER_HOST}
            update = await h.client.post(
                f"{URL}?replace=true",
                content=package(version="2.0.0"),
                headers=same_origin,
            )
            assert update.status_code == 201 and update.json()["replaces"] == {
                "version": "1.0.0",
                "digest": digest,
            }

    asyncio.run(scenario())


def test_reserved_ids_cannot_be_installed(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            for query in ("", "?replace=true", "?dry_run=true"):
                impostor = refused(
                    await install(h, package(id=RESERVED), query),
                    422,
                    "STUDIO_PLUGIN_INVALID",
                    tmp_path,
                )
                assert [found["code"] for found in impostor["details"]["errors"]] == [
                    "reserved_id"
                ]
            assert (
                tree(tmp_path / "plugins") == EMPTY_STORE and registered(tmp_path) == {}
            )

    asyncio.run(scenario())


def test_package_files_are_served_as_inert_data_by_listed_key_only(
    tmp_path: Path,
) -> None:
    (tmp_path / "secret.txt").write_text("outside", encoding="utf-8")

    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            installed = await install(h, code_package())
            assert installed.status_code == 201, installed.text
            plugin = installed.json()["detail"]["plugin"]
            # A package with code installs and can be inspected, but this version neither runs nor serves the code.
            assert plugin["status"] == "incompatible" and plugin["has_code"] is True
            assert [found["code"] for found in plugin["problems"]] == [
                "code_unsupported"
            ]
            for path, media_type, content in (
                ("README.md", "application/octet-stream", README),
                ("assets/icon.png", "image/png", PNG),
            ):
                served = await h.client.get(f"{URL}/{PLUGIN}/files/{path}")
                assert served.status_code == 200 and served.content == content
                assert served.headers["content-type"] == media_type
                assert served.headers["x-content-type-options"] == "nosniff"
                assert served.headers["content-security-policy"] == "sandbox"
                assert served.headers["cross-origin-resource-policy"] == "same-origin"
            unlisted = (
                "main.js",  # listed, but code is not served
                "plugin.json",
                "assets",
                "ASSETS/icon.png",
                "assets//icon.png",
                "..%2F..%2Fregistry.json",
                "assets%2F..%2F..%2F..%2Fregistry.json",
                "..%2F..%2F..%2F..%2Fsecret.txt",
                "%2Fetc%2Fpasswd",
                "README.md%00.png",
            )
            for path in unlisted:
                refused(
                    await h.client.get(f"{URL}/{PLUGIN}/files/{path}"),
                    404,
                    "NOT_FOUND",
                    tmp_path,
                )
            refused(
                await h.client.get(f"{URL}/com.example.other/files/README.md"),
                404,
                "NOT_FOUND",
                tmp_path,
            )
            refused(
                await h.client.get(f"{URL}/..%2F..%2Fconfig/files/README.md"),
                404,
                "NOT_FOUND",
                tmp_path,
            )
            exported = await h.client.get(f"{URL}/{PLUGIN}/package")
            assert (
                exported.status_code == 200
                and exported.headers["content-type"] == "application/octet-stream"
            )
            assert (
                exported.headers["content-disposition"]
                == f'attachment; filename="{PLUGIN}-1.0.0.phasynplugin"'
            )
            assert exported.headers["x-content-type-options"] == "nosniff"
            again = await install(
                h, exported.content, "?dry_run=true"
            )  # an export is the validated content
            assert (
                again.status_code == 200
                and again.json()["detail"]["plugin"]["digest"] == plugin["digest"]
            )

    asyncio.run(scenario())


def test_install_switch_refuses_installation_and_removal(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            digest = (await install(h, package())).json()["detail"]["plugin"]["digest"]
        async with Harness(tmp_path, plugins={"install": "disabled"}) as h:
            listing = (await h.client.get(URL)).json()
            assert (
                plugin_ids(listing) == [*BUILTINS, PLUGIN]
                and listing["install"] == "disabled"
            )
            for query in ("?replace=true", "?dry_run=true"):
                refused(
                    await install(h, package(version="2.0.0"), query),
                    409,
                    "STUDIO_PLUGIN_INSTALL_DISABLED",
                    tmp_path,
                )
            removal = await h.client.delete(f"{URL}/{PLUGIN}?digest={digest}")
            refused(removal, 409, "STUDIO_PLUGIN_INSTALL_DISABLED", tmp_path)
            preview = (await h.client.get(f"{URL}/{PLUGIN}/removal-preview")).json()
            assert preview["can_remove"] is False and [
                item["code"] for item in preview["blocking"]
            ] == ["install_disabled"]
            assert (await h.client.get(f"{URL}/{PLUGIN}")).json()["plugin"][
                "version"
            ] == "1.0.0"
            assert tree(tmp_path / "plugins" / "staging") == []

    asyncio.run(scenario())


def test_update_needs_an_explicit_replace_and_the_expected_digest(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            first = (await install(h, package())).json()["detail"]["plugin"]
            packages = tmp_path / "plugins" / "packages" / PLUGIN
            newer = package(version="2.0.0", permissions=[])
            exists = refused(await install(h, newer), 409, "STATE_CONFLICT", tmp_path)
            assert exists["details"] == {
                "plugin_id": PLUGIN,
                "installed_version": "1.0.0",
                "installed_digest": first["digest"],
            }
            preview = (await install(h, newer, "?dry_run=true")).json()
            contracts.validate("StudioPluginInstallResult", preview)
            assert preview["dry_run"] is True and preview["replaces"] == {
                "version": "1.0.0",
                "digest": first["digest"],
            }
            refused(
                await install(h, newer, f"?replace=true&digest={first['digest']}"),
                409,
                "STATE_CONFLICT",
                tmp_path,
            )
            assert [path.name for path in packages.iterdir()] == [
                f"1.0.0-{first['digest']}"
            ]  # still only the first
            expected = preview["detail"]["plugin"]["digest"]
            updated = (
                await install(h, newer, f"?replace=true&digest={expected}")
            ).json()["detail"]["plugin"]
            assert (updated["version"], updated["revision"], updated["digest"]) == (
                "2.0.0",
                2,
                expected,
            )
            assert [path.name for path in packages.iterdir()] == [
                f"2.0.0-{expected}"
            ]  # one version per id
            stale = await h.client.patch(
                f"{URL}/{PLUGIN}", json={"disabled": True, "expected_revision": 1}
            )
            refused(stale, 409, "REVISION_CONFLICT", tmp_path)
            off = await h.client.patch(
                f"{URL}/{PLUGIN}", json={"disabled": True, "expected_revision": 2}
            )
            assert (
                off.status_code == 200 and off.json()["plugin"]["status"] == "disabled"
            )

    asyncio.run(scenario())


def test_a_copy_changed_on_disk_is_not_served_and_the_same_package_repairs_it(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            digest = (await install(h, package())).json()["detail"]["plugin"]["digest"]
            readme = (
                tmp_path
                / "plugins"
                / "packages"
                / PLUGIN
                / f"1.0.0-{digest}"
                / "README.md"
            )
            readme.write_bytes(b"<script>changed after it was validated</script>\n")
            refused(
                await h.client.get(f"{URL}/{PLUGIN}/files/README.md"),
                409,
                "STATE_CONFLICT",
                tmp_path,
            )
            refused(
                await h.client.get(f"{URL}/{PLUGIN}/package"),
                409,
                "STATE_CONFLICT",
                tmp_path,
            )
        async with Harness(
            tmp_path
        ) as h:  # at the next start the copy no longer passes the package rules
            broken = (await h.client.get(f"{URL}/{PLUGIN}")).json()
            contracts.validate("StudioPluginDetail", broken)
            assert (
                broken["plugin"]["status"] == "invalid"
                and broken["manifest"] is None
                and broken["files"] == []
            )
            assert [found["code"] for found in broken["plugin"]["problems"]] == [
                "integrity_mismatch"
            ]
            assert (
                broken["plugin"]["digest"] == digest
            )  # what was installed is still known, so it can be removed
            repaired = await install(h, package(), f"?replace=true&digest={digest}")
            assert (
                repaired.status_code == 201
                and repaired.json()["detail"]["plugin"]["status"] == "ok"
            )
            assert readme.read_bytes() == README
            assert (
                await h.client.get(f"{URL}/{PLUGIN}/files/README.md")
            ).content == README

    asyncio.run(scenario())


def test_a_failed_registry_write_leaves_the_installation_as_it_was(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = tmp_path / "plugins"

    def disk_full(path: Path, *_args: Any, **_kwargs: Any) -> None:
        raise OSError(errno.ENOSPC, "No space left on device", str(path))

    def content() -> dict[str, bytes | None]:
        return {
            path: (store / path).read_bytes() if (store / path).is_file() else None
            for path in tree(store)
        }

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            first = (await install(h, package())).json()["detail"]
            before = content()
            monkeypatch.setattr(plugin_store, "atomic_write_json", disk_full)
            refused(
                await install(h, package(version="2.0.0"), "?replace=true"),
                507,
                "DISK_FULL",
                tmp_path,
            )
            refused(
                await install(h, package(id="com.example.other")),
                507,
                "DISK_FULL",
                tmp_path,
            )
            removal = await h.client.delete(
                f"{URL}/{PLUGIN}?digest={first['plugin']['digest']}"
            )
            refused(removal, 507, "DISK_FULL", tmp_path)
            switch = await h.client.patch(
                f"{URL}/{PLUGIN}", json={"disabled": True, "expected_revision": 1}
            )
            refused(switch, 507, "DISK_FULL", tmp_path)
            monkeypatch.undo()
            assert content() == before  # same directories, same files, same bytes
            assert (await h.client.get(f"{URL}/{PLUGIN}")).json() == first
            assert plugin_ids((await h.client.get(URL)).json()) == [*BUILTINS, PLUGIN]

    asyncio.run(scenario())


def test_removing_a_package_never_edits_project_documents(tmp_path: Path) -> None:
    refs = ["an-unknown-rule", f"{PLUGIN}/no-side-view"]
    project = {
        "project_id": "p1",
        "title": "Rooftop",
        "revision": 0,
        "created_at": "2026-01-01T00:00:00.000Z",
        "updated_at": "2026-01-01T00:00:00.000Z",
        "format": {"width": 768, "height": 448, "fps": {"num": 24, "den": 1}},
        "prompt_plugins": refs,
        "defaults": {"frames": 124, "route": "route-a", "steps": None},
        "shots": [],
        "exports": [],
    }

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            digest = (await install(h, package())).json()["detail"]["plugin"]["digest"]
            assert (
                await h.client.put("/api/studio/projects/p1", json=project)
            ).status_code == 200
            studio = tmp_path / "config" / "studio"
            # A document that no longer satisfies the contract is still a project that refers to the package.
            (studio / "broken.json").write_text(
                json.dumps({"project_id": "broken", "prompt_plugins": refs}),
                encoding="utf-8",
            )
            before = {
                path.name: path.read_bytes()
                for path in studio.iterdir()
                if path.is_file()
            }
            uses = [
                {
                    "project_id": "broken",
                    "title": "",
                    "refs": [f"{PLUGIN}/no-side-view"],
                },
                {
                    "project_id": "p1",
                    "title": "Rooftop",
                    "refs": [f"{PLUGIN}/no-side-view"],
                },
            ]
            preview = (await h.client.get(f"{URL}/{PLUGIN}/removal-preview")).json()
            contracts.validate("StudioPluginRemovalPreview", preview)
            assert preview["can_remove"] is True and preview["projects"] == uses
            refused(
                await h.client.delete(f"{URL}/{PLUGIN}?digest={'0' * 64}"),
                409,
                "STATE_CONFLICT",
                tmp_path,
            )
            refused(
                await h.client.delete(f"{URL}/{PLUGIN}"),
                422,
                "INVALID_ARGUMENT",
                tmp_path,
            )
            removed = await h.client.delete(f"{URL}/{PLUGIN}?digest={digest}")
            assert removed.status_code == 200, removed.text
            contracts.validate("StudioPluginRemoval", removed.json())
            assert removed.json()["projects"] == uses
            assert {
                path.name: path.read_bytes()
                for path in studio.iterdir()
                if path.is_file()
            } == before  # not one byte changed
            saved = (await h.client.get("/api/studio/projects/p1")).json()
            assert (
                saved["prompt_plugins"] == refs and saved["revision"] == 1
            )  # the reference stays and reads as missing
            assert plugin_ids((await h.client.get(URL)).json()) == BUILTINS
            assert (
                tree(tmp_path / "plugins") == EMPTY_STORE and registered(tmp_path) == {}
            )

    asyncio.run(scenario())


def test_start_up_sets_leftovers_aside_only_when_the_registry_is_readable(
    tmp_path: Path,
) -> None:
    store = tmp_path / "plugins"

    def leftovers() -> None:
        (store / "packages" / "com.example.orphan" / "1.0.0-abc").mkdir(parents=True)
        (store / "packages" / PLUGIN / "0.9.0-old").mkdir()
        (store / "staging" / "interrupted").mkdir(parents=True)
        (store / "staging" / "interrupted" / "upload").write_bytes(b"partial")

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            digest = (await install(h, package())).json()["detail"]["plugin"]["digest"]
        kept = f"packages/{PLUGIN}/1.0.0-{digest}"
        leftovers()
        async with (
            Harness(tmp_path) as h
        ):  # what the registry does not name is a leftover of an interrupted request
            assert plugin_ids((await h.client.get(URL)).json()) == [*BUILTINS, PLUGIN]
            assert [
                path for path in tree(store / "packages") if path.count("/") <= 1
            ] == [PLUGIN, kept[9:]]
            # ...or a package of a registry that was restored from an older copy: it can be put back until the next start
            assert sorted(path.name for path in (store / "trash").iterdir()) == [
                "000-com.example.orphan",
                f"001-{PLUGIN}-0.9.0-old",
            ]
            assert tree(store / "staging") == []
        async with Harness(tmp_path):
            assert not (store / "trash").exists()
        registry = store / "registry.json"

        async def nothing_is_removed_or_written(reason: str) -> None:
            async with Harness(tmp_path) as h:
                listing = (await h.client.get(URL)).json()
                assert plugin_ids(listing) == BUILTINS
                faults = [
                    (found["code"], found["details"]) for found in listing["problems"]
                ]
                assert faults == [("registry_unreadable", {"reason": reason})]
                assert str(tmp_path) not in json.dumps(listing)
                for path in (
                    kept,
                    f"packages/{PLUGIN}/0.9.0-old",
                    "packages/com.example.orphan/1.0.0-abc",
                ):
                    assert (store / path).is_dir(), path
                refused(
                    await install(h, package(id="com.example.other")),
                    409,
                    "STATE_CONFLICT",
                    tmp_path,
                )
                assert tree(store / "staging") == []

        # A registry that cannot be read, or that is gone while package directories are there, proves nothing about
        # what is a leftover.
        leftovers()
        registry.write_text("{ not json", encoding="utf-8")
        await nothing_is_removed_or_written("unreadable")
        assert registry.read_text(encoding="utf-8") == "{ not json"
        registry.unlink()
        await nothing_is_removed_or_written("missing")
        assert not registry.exists()

    asyncio.run(scenario())


def test_a_package_that_installs_still_loads_at_the_next_start(tmp_path: Path) -> None:
    """Install and start-up apply the same entry budget, and a hard-link copy of the data keeps packages valid."""
    spread = {
        f"d{n:03d}/notes.txt": b"x" for n in range(127)
    }  # 127 files + 127 directories + plugin.json = 255

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            refused(
                await install(h, package({**spread, "d127/notes.txt": b"x"})),
                422,
                "STUDIO_PLUGIN_INVALID",
                tmp_path,
            )
            assert tree(tmp_path / "plugins") == EMPTY_STORE
            installed = await install(h, package(spread))
            assert (
                installed.status_code == 201
                and installed.json()["detail"]["plugin"]["status"] == "ok"
            )
            digest = installed.json()["detail"]["plugin"]["digest"]
        # A backup made with hard links gives every installed file a second name
        (tmp_path / "copy").mkdir()
        copied = (
            tmp_path
            / "plugins"
            / "packages"
            / PLUGIN
            / f"1.0.0-{digest}"
            / "plugin.json"
        )
        (tmp_path / "copy" / "plugin.json").hardlink_to(copied)
        async with Harness(tmp_path) as h:
            again = (await h.client.get(f"{URL}/{PLUGIN}")).json()
            assert (
                again["plugin"]["status"] == "ok" and again["plugin"]["problems"] == []
            )
            assert len(again["files"]) == 127

    asyncio.run(scenario())


def test_development_directories_get_the_same_checks_and_no_api_removal(
    tmp_path: Path,
) -> None:
    good = tmp_path / "dev" / "good"
    impostor = tmp_path / "dev" / "impostor"
    for directory, plugin_id in (
        (good, "com.example.dev"),
        (impostor, "phasyn.impostor"),
    ):
        directory.mkdir(parents=True)
        (directory / "plugin.json").write_text(
            json.dumps(manifest({}, id=plugin_id)), encoding="utf-8"
        )

    async def scenario() -> None:
        async with Harness(
            tmp_path / "ctl", plugins={"dev_dirs": [str(good), str(impostor)]}
        ) as h:
            listing = (await h.client.get(URL)).json()
            assert plugin_ids(listing) == [*BUILTINS, "com.example.dev"]
            dev = listing["items"][len(BUILTINS)]
            assert dev["source"] == "dev" and dev["status"] == "ok"
            assert [
                (found["code"], found["path"]) for found in listing["problems"]
            ] == [("dev_dir_invalid", "impostor")]
            assert [
                found["code"] for found in listing["problems"][0]["details"]["errors"]
            ] == ["reserved_id"]
            assert str(tmp_path) not in json.dumps(listing)
            digest = dev["digest"]
            refused(
                await h.client.delete(f"{URL}/com.example.dev?digest={digest}"),
                409,
                "STATE_CONFLICT",
                tmp_path,
            )
            refused(
                await install(h, package(id="com.example.dev")),
                409,
                "STATE_CONFLICT",
                tmp_path,
            )
            (good / "run.html").write_text(
                "<script>fetch('/api/runs')</script>", encoding="utf-8"
            )
            reloaded = await h.client.post(f"{URL}/com.example.dev/reload")
            assert reloaded.status_code == 200, reloaded.text
            contracts.validate("StudioPluginDetail", reloaded.json())
            broken = reloaded.json()["plugin"]
            assert (
                broken["status"] == "invalid" and broken["contributes"]["rules"] == []
            )
            assert [found["code"] for found in broken["problems"]] == [
                "extension_not_allowed"
            ]
            assert (
                good.is_dir() and (good / "run.html").is_file()
            )  # a development directory is never written to

    asyncio.run(scenario())


# --------------------------------------------------------------------------- per-shot checks (a rule's shots)
SHOT_RULE: dict[str, Any] = {
    "id": "shot-staging",
    "kind": "constraint",
    "label": {"en": "Per-shot staging"},
    "shots": {
        "forbid": [
            {
                "id": "side-shot",
                "terms": ["side view"],
                "word": True,
                "message": {"en": "a side view in a shot"},
            }
        ],
        "require": [
            {
                "id": "depth",
                "any_terms": ["foreground", "background"],
                "message": {"en": "needs depth"},
            }
        ],
        "every_subject": {
            "id": "cast",
            "message": {"en": "every subject appears in a shot"},
        },
    },
}


def rev_before_per_shot_checks(rule: dict[str, Any]) -> str:
    """A rule's content revision as it was computed before rules could check shots (phrase lists only)."""
    content = {
        "kind": rule["kind"],
        "group": rule.get("group"),
        "forbid": [
            {"terms": item["terms"], "word": bool(item.get("word", False))}
            for item in rule.get("forbid") or []
        ],
        "require": [
            {"any_terms": item["any_terms"], "word": bool(item.get("word", False))}
            for item in rule.get("require") or []
        ],
        "inject": rule.get("inject") or "",
    }
    return sha256_hex(canonical_json(content))[:12]


def test_per_shot_checks_install_and_leave_the_revisions_of_other_rules_alone(
    tmp_path: Path,
) -> None:
    """A package may check each [Shot N] of a prompt; a rule without such checks keeps the revision it had, so the
    takes rendered with it stay current."""

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            installed = await install(
                h, package(contributes={"rules": [*RULES["rules"], SHOT_RULE]})
            )
            assert installed.status_code == 201, installed.text
            plugin = installed.json()["detail"]["plugin"]
            assert plugin["status"] == "ok" and plugin["problems"] == []
            entries = {entry["ref"]: entry for entry in plugin["contributes"]["rules"]}
            older = entries[f"{PLUGIN}/no-side-view"]
            assert older["rule"] == RULES["rules"][0]
            assert older["rev"] == rev_before_per_shot_checks(RULES["rules"][0])
            checked = entries[f"{PLUGIN}/shot-staging"]
            assert checked["rule"]["shots"] == SHOT_RULE["shots"]
            assert checked["rev"] != rev_before_per_shot_checks(
                SHOT_RULE
            )  # what it checks per shot is its content
            listing = (await h.client.get(URL)).json()
            contracts.validate("StudioPluginList", listing)

    asyncio.run(scenario())


def test_per_shot_checks_that_break_a_rule_are_refused_and_nothing_is_kept(
    tmp_path: Path,
) -> None:
    message = {"en": "x"}
    broken: list[tuple[dict[str, Any], str, str | None]] = [
        # a regular expression is for built-in packages only, per shot as for the whole prompt
        (
            {"forbid": [{"id": "slow", "pattern": "(a+)+$", "message": message}]},
            "regex_not_allowed",
            "shots/forbid/0/pattern",
        ),
        # one id namespace per rule: a finding names its check by id
        (
            {
                "require": [
                    {"id": "side", "any_terms": ["foreground"], "message": message}
                ]
            },
            "duplicate_id",
            "shots/require/0/id",
        ),
        (
            {"every_subject": {"id": "side", "message": message}},
            "duplicate_id",
            "shots/every_subject/id",
        ),
        ({}, "manifest_invalid", None),  # nothing to check
        (
            {
                "lines": "all",
                "require": [
                    {"id": "depth", "any_terms": ["foreground"], "message": message}
                ],
            },
            "manifest_invalid",
            None,
        ),
        ({"every_subject": {"id": "cast"}}, "manifest_invalid", None),
        (
            {
                "forbid": [
                    {"id": "far", "terms": ["far away\u2028"], "message": message}
                ]
            },
            "manifest_invalid",
            None,
        ),
    ]

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            for shots, code, path in broken:
                rule = {**RULES["rules"][0], "shots": shots}
                body = refused(
                    await install(
                        h, package(contributes={"rules": [rule]}), "?dry_run=true"
                    ),
                    422,
                    "STUDIO_PLUGIN_INVALID",
                    tmp_path,
                )
                found = body["details"]["errors"]
                assert {item["code"] for item in found} == {code}, (shots, found)
                if path is not None:
                    assert [item["path"] for item in found] == [
                        f"contributes/rules/0/{path}"
                    ]
                assert (
                    tree(tmp_path / "plugins") == EMPTY_STORE
                    and registered(tmp_path) == {}
                )
            assert plugin_ids((await h.client.get(URL)).json()) == BUILTINS

    asyncio.run(scenario())
