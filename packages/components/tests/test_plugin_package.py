"""Plugin packages are data from strangers: the boundaries of unpacking and loading one.

Every refused archive must leave nothing behind and must say why without naming a path of this host.
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
import time
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from phasyn_components.errors import ComponentError
from phasyn_components.plugin_manifest import INVALID_CODE, LIMITS, PluginLimits
from phasyn_components.plugin_package import (
    load_directory,
    open_file,
    read_file,
    unpack_archive,
    write_archive,
)


PNG = b"\x89PNG\r\n\x1a\n" + bytes(24)
README = b"# Example\n"
SMALL = PluginLimits(files=6, file_bytes=4096, unpacked_bytes=6000, manifest_bytes=4096)


@dataclass
class Entry:
    """One archive member, written exactly as given: a hostile archive is not something zipfile will produce."""

    name: str
    data: bytes = b""
    mode: int = 0o100644
    flags: int = 0
    declared: int | None = None  # the uncompressed size the headers claim
    alias: bool = (
        False  # only a directory record, pointing at the member written just before
    )
    claimed: int | None = (
        None  # where the directory record says the member is, instead of where it is
    )
    extra: bytes = b""  # the extra field of the directory record


def archive(
    entries: list[Entry], *, prefix: bytes = b"", comment: bytes = b""
) -> bytes:
    body = bytearray(prefix)
    directory = bytearray()
    offset = 0
    for entry in entries:
        name = entry.name.encode()
        packer = zlib.compressobj(9, zlib.DEFLATED, -15)
        packed = packer.compress(entry.data) + packer.flush()
        size = len(entry.data) if entry.declared is None else entry.declared
        fields = (
            20,
            entry.flags,
            8,
            0,
            0x21,
            zlib.crc32(entry.data),
            len(packed),
            size,
            len(name),
        )
        offset = offset if entry.alias else len(body)
        claimed = offset if entry.claimed is None else entry.claimed
        directory += struct.pack(
            "<4s6H3L2H", b"PK\x01\x02", 0x0314, *fields, len(entry.extra)
        )
        directory += (
            struct.pack("<3H2L", 0, 0, 0, entry.mode << 16, claimed)
            + name
            + entry.extra
        )
        if not entry.alias:
            body += struct.pack("<4s5H3L2H", b"PK\x03\x04", *fields, 0) + name + packed
    count = len(entries)
    end = struct.pack(
        "<4s4H2LH",
        b"PK\x05\x06",
        0,
        0,
        count,
        count,
        len(directory),
        len(body),
        len(comment),
    )
    return bytes(body + directory + end + comment)


def manifest(files: dict[str, bytes], **changes: Any) -> bytes:
    doc: dict[str, Any] = {
        "manifest_version": 1,
        "id": "com.example.pack",
        "version": "1.0.0",
        "name": {"en": "Pack"},
        "engines": {"phasyn": ">=0.0.0 <1000.0.0"},
        "integrity": {
            "algorithm": "sha256",
            "files": {
                path: hashlib.sha256(data).hexdigest() for path, data in files.items()
            },
        },
    }
    doc.update(changes)
    return json.dumps(doc).encode()


def package(files: dict[str, bytes], *extra: Entry, **changes: Any) -> bytes:
    """A valid package of ``files`` (plus ``extra`` entries the manifest does not know about)."""
    members = [
        Entry("plugin.json", manifest(files, **changes)),
        *(Entry(path, data) for path, data in files.items()),
    ]
    return archive([*members, *extra])


def text(seed: int, size: int) -> bytes:
    """Text that does not compress well (a size check must not be mistaken for a ratio check)."""
    blocks = (
        hashlib.sha256(bytes([seed, index])).hexdigest()
        for index in range(size // 64 + 1)
    )
    return "".join(blocks).encode()[:size]


def rule(**check: Any) -> dict[str, Any]:
    forbid = [{"id": "check", "message": {"en": "not allowed"}, **check}]
    return {
        "rules": [
            {
                "id": "rule",
                "kind": "constraint",
                "label": {"en": "Rule"},
                "forbid": forbid,
            }
        ]
    }


GOOD = {"README.md": README, "assets/icon.png": PNG}
REFUSED: list[tuple[str, bytes, str, PluginLimits]] = [
    (
        "path traversal",
        package({}, Entry("../evil.txt", b"x")),
        "path_not_allowed",
        LIMITS,
    ),
    (
        "traversal inside a path",
        package({}, Entry("assets/../../evil.txt", b"x")),
        "path_not_allowed",
        LIMITS,
    ),
    (
        "absolute path",
        package({}, Entry("/etc/evil.txt", b"x")),
        "path_not_allowed",
        LIMITS,
    ),
    (
        "backslash path",
        package({}, Entry("assets\\evil.txt", b"x")),
        "path_not_allowed",
        LIMITS,
    ),
    (
        "name cut at a NUL byte",
        package({}, Entry("evil.txt\x00.png", PNG)),
        "path_not_allowed",
        LIMITS,
    ),
    ("hidden file", package({}, Entry(".env.txt", b"x")), "path_not_allowed", LIMITS),
    (
        "five levels deep",
        package({}, Entry("a/b/c/d/e.txt", b"x")),
        "path_not_allowed",
        LIMITS,
    ),
    (
        "symbolic link",
        package({}, Entry("assets/link.png", b"/etc/passwd", mode=0o120777)),
        "link_not_allowed",
        LIMITS,
    ),
    (
        "device file",
        package({}, Entry("assets/dev.png", b"", mode=0o020644)),
        "link_not_allowed",
        LIMITS,
    ),
    (
        "names differing only in case",
        package({"README.md": README}, Entry("readme.md", README)),
        "duplicate_path",
        LIMITS,
    ),
    (
        "a file where a directory is",
        package({"data.json/x.txt": b"x"}, Entry("data.json", b"{}")),
        "duplicate_path",
        LIMITS,
    ),
    (
        "too many entries",
        package({f"f{n}.txt": b"x" for n in range(6)}),
        "too_many_files",
        SMALL,
    ),
    (
        "directories the archive does not list count as entries",
        package(
            {f"d{n}/f.txt": b"x" for n in range(3)}
        ),  # 4 files and 3 directories against a budget of 6
        "too_many_files",
        SMALL,
    ),
    (
        "file over the size limit",
        package({"big.txt": b"0123456789abcdef" * 300}),
        "file_too_large",
        SMALL,
    ),
    (
        "total over the size limit",
        package({f"f{n}.txt": text(n, 2560) for n in range(3)}),
        "total_too_large",
        SMALL,
    ),
    (
        "compression ratio bomb",
        package({"zeros.txt": b"0" * 200_000}),
        "ratio_too_high",
        LIMITS,
    ),
    (
        "declared size larger than the content",
        archive(
            [
                Entry("plugin.json", manifest({"short.txt": b"abc"})),
                Entry("short.txt", b"abc", declared=64),
            ]
        ),
        "size_mismatch",
        LIMITS,
    ),
    (
        "encrypted entry",
        package({}, Entry("secret.txt", b"x", flags=0x1)),
        "encrypted",
        LIMITS,
    ),
    (
        "HTML file",
        package({}, Entry("page.html", b"<script>alert(1)</script>")),
        "extension_not_allowed",
        LIMITS,
    ),
    (
        "SVG file",
        package({}, Entry("icon.svg", b"<svg/>")),
        "extension_not_allowed",
        LIMITS,
    ),
    (
        "WebAssembly file",
        package({}, Entry("mod.wasm", b"\x00asm")),
        "extension_not_allowed",
        LIMITS,
    ),
    (
        "script other than main.js",
        package({}, Entry("assets/extra.js", b"1")),
        "extension_not_allowed",
        LIMITS,
    ),
    (
        "bitmap without its header",
        package({"icon.png": b"<html>"}),
        "content_mismatch",
        LIMITS,
    ),
    (
        "text that is not UTF-8",
        package({"notes.txt": b"\xff\xfe\x00x"}),
        "content_mismatch",
        LIMITS,
    ),
    (
        "file the manifest does not list",
        package({}, Entry("extra.txt", b"x")),
        "integrity_files_mismatch",
        LIMITS,
    ),
    (
        "content that differs from its hash",
        archive(
            [
                Entry("plugin.json", manifest({"README.md": README})),
                Entry("README.md", b"# Changed\n"),
            ]
        ),
        "integrity_mismatch",
        LIMITS,
    ),
    (
        "main.js that the manifest does not declare",
        package({"main.js": b"1"}),
        "main_mismatch",
        LIMITS,
    ),
    ("reserved id prefix", package({}, id="phasyn.evil"), "reserved_id", LIMITS),
    (
        "regular expression in a forbid item",
        package({}, contributes=rule(pattern="(a+)+$")),
        "regex_not_allowed",
        LIMITS,
    ),
    (
        "control character in a text",
        package({}, description={"en": "bell" + chr(0x07)}),
        "text_invalid",
        LIMITS,
    ),
    (
        "invisible tag characters in a text",
        package(
            {},
            description={
                "en": "plain" + "".join(chr(0xE0000 + ord(char)) for char in "hidden")
            },
        ),
        "text_invalid",
        LIMITS,
    ),
    (
        "manifest with an unknown field",
        package({}, run="rm -rf /"),
        "manifest_invalid",
        LIMITS,
    ),
    (
        "manifest key that no encoding can carry",
        package({}, integrity={"algorithm": "sha256", "files": {chr(0xD800): 1}}),
        "manifest_invalid",
        LIMITS,
    ),
    (
        "manifest with a duplicate key",
        archive([Entry("plugin.json", b'{"id": "a.b", "id": "c.d"}')]),
        "manifest_not_json",
        LIMITS,
    ),
    ("no manifest", archive([Entry("README.md", README)]), "manifest_missing", LIMITS),
    (
        "data before the first entry",
        archive([Entry("plugin.json", manifest({}))], prefix=b"#!/bin/sh\n"),
        "archive_layout",
        LIMITS,
    ),
    (
        "data before the first entry behind an entry's signature",
        archive(
            [Entry("plugin.json", manifest({}))],
            prefix=b"PK\x03\x04" + b"#!/bin/sh\n" * 8,
        ),
        "archive_layout",
        LIMITS,
    ),
    (
        "archive comment",
        archive([Entry("plugin.json", manifest({}))], comment=b"hello"),
        "archive_layout",
        LIMITS,
    ),
    (
        "a second name for one member",
        package({"README.md": README}, Entry("copy.md", README, alias=True)),
        "archive_layout",
        LIMITS,
    ),
    (
        "a record that points into another member",
        package({"README.md": README}, Entry("copy.md", README, alias=True, claimed=1)),
        "archive_layout",
        LIMITS,
    ),
    (
        "a member that a zip64 field places far outside the archive",
        archive(
            [
                Entry("plugin.json", manifest({"notes.txt": b"x"})),
                Entry(
                    "notes.txt",
                    b"x",
                    claimed=0xFFFFFFFF,
                    extra=struct.pack("<2HQ", 1, 8, 2**62),
                ),
            ]
        ),
        "archive_layout",
        LIMITS,
    ),
    (
        "not an archive",
        b"plain text, not a zip file at all",
        "archive_unreadable",
        LIMITS,
    ),
]


@pytest.mark.parametrize(
    ("data", "code", "limits"),
    [case[1:] for case in REFUSED],
    ids=[case[0] for case in REFUSED],
)
def test_refused_archive_leaves_nothing_and_names_no_host_path(
    tmp_path: Path, data: bytes, code: str, limits: PluginLimits
) -> None:
    staging = tmp_path / "staging"
    staging.mkdir()
    upload = staging / "upload"
    upload.write_bytes(data)
    with pytest.raises(ComponentError) as refused:
        unpack_archive(upload, staging / "content", limits=limits)
    error = refused.value
    assert error.code == INVALID_CODE and error.status == 422
    assert code in [found["code"] for found in error.details["errors"]], error.details
    assert sorted(path.name for path in staging.iterdir()) == [
        "upload"
    ]  # the content directory is gone again
    assert not (tmp_path / "evil.txt").exists() and not (staging / "evil.txt").exists()
    answer = json.dumps(
        error.to_dict(), ensure_ascii=False
    ).encode()  # as a response body carries it
    assert str(tmp_path).encode() not in answer


def requirement(field: str, values: list[Any]) -> dict[str, Any]:
    check = {
        "id": "check",
        "field": field,
        "in": values,
        "message": {"en": "not allowed"},
    }
    return {
        "generation": [
            {"id": "setting", "label": {"en": "Setting"}, "require": [check]}
        ]
    }


def nested(levels: int) -> Any:
    value: Any = "x"
    for _ in range(levels):
        value = [value]
    return value


# Manifests well under the size limit that keep a stock JSON Schema validator busy for tens of seconds: it compares
# every pair of a list's values when they cannot be sorted, collects every problem of every alternative, and follows
# the nesting as deep as it goes.
FRAME_SIZES = [
    {"width": 32 * (n % 100 + 1), "height": 32 * (n // 100 + 1)} for n in range(2400)
]
COSTLY: list[tuple[str, dict[str, Any], str]] = [
    (
        "thousands of values that cannot be sorted",
        {
            "contributes": requirement(
                "frames", [value for n in range(4000) for value in (n, f"v{n}")]
            )
        },
        "is not valid under any of the given schemas",
    ),
    (
        "thousands of distinct frame sizes",
        {"contributes": requirement("format", FRAME_SIZES)},
        "is not valid under any of the given schemas",
    ),
    (
        "tens of thousands of values of the wrong kind",
        {
            "contributes": requirement(
                "format",
                [
                    byte
                    for n in range(700)
                    for byte in hashlib.sha256(bytes([n % 256, n // 256])).digest()
                ],
            )
        },
        "is not valid under any of the given schemas",
    ),
    (
        "values nested hundreds of levels deep",
        {"description": nested(400)},
        "nested deeper than 32 levels",
    ),
]


@pytest.mark.parametrize(
    ("changes", "reason"),
    [case[1:] for case in COSTLY],
    ids=[case[0] for case in COSTLY],
)
def test_costly_manifest_is_refused_in_time_that_grows_only_with_its_size(
    tmp_path: Path, changes: dict[str, Any], reason: str
) -> None:
    upload = tmp_path / "upload"
    upload.write_bytes(package({}, **changes))
    started = time.process_time()
    with pytest.raises(ComponentError) as refused:
        unpack_archive(upload, tmp_path / "content")
    spent = time.process_time() - started
    found = refused.value.details["errors"]
    assert [item["code"] for item in found] == ["manifest_invalid"] and reason in found[
        0
    ]["details"]["reason"], found
    assert spent < 3.0, (
        f"{spent:.1f} s of processor time for a {upload.stat().st_size}-byte package"
    )
    assert not (tmp_path / "content").exists()


def test_valid_archive_is_unpacked_privately_and_reloads_to_the_same_digest(
    tmp_path: Path,
) -> None:
    upload = tmp_path / "upload"
    upload.write_bytes(package(GOOD, contributes=rule(terms=["side view"], word=True)))
    unpacked = unpack_archive(upload, tmp_path / "content")
    assert [item.path for item in unpacked.files] == ["README.md", "assets/icon.png"]
    assert [item.media_type for item in unpacked.files] == [
        "application/octet-stream",
        "image/png",
    ]
    modes = {
        path.relative_to(unpacked.root).as_posix(): path.stat().st_mode & 0o777
        for path in unpacked.root.rglob("*")
    }
    assert modes == {
        "plugin.json": 0o600,
        "README.md": 0o600,
        "assets": 0o700,
        "assets/icon.png": 0o600,
    }
    assert load_directory(unpacked.root, builtin=False).digest == unpacked.digest


def test_an_archive_at_the_entry_budget_loads_again_as_a_directory(
    tmp_path: Path,
) -> None:
    upload = tmp_path / "upload"
    upload.write_bytes(
        package({"d0/f.txt": b"x", "d1/f.txt": b"y"})
    )  # 3 files and 2 directories of 6
    unpacked = unpack_archive(upload, tmp_path / "content", limits=SMALL)
    assert (
        load_directory(unpacked.root, builtin=False, limits=SMALL).digest
        == unpacked.digest
    )


@pytest.mark.parametrize(
    "char",
    [
        "\ufe0f",
        "\U000e0100",
        "\u034f",
        "\u115f",
        "\u3164",
        "\u17b5",
        "\u180b",
        "\u2800",
        "\u200b",
        "\u2028",
    ],
    ids=lambda char: f"U+{ord(char):04X}",
)
def test_text_that_cannot_be_seen_is_refused(tmp_path: Path, char: str) -> None:
    hidden = {
        "rules": [
            {
                "id": "rule",
                "kind": "style",
                "label": {"en": "Rule"},
                "inject": f"a quiet scene{char}",
            }
        ]
    }
    upload = tmp_path / "upload"
    upload.write_bytes(package(GOOD, contributes=hidden))
    with pytest.raises(ComponentError) as refused:
        unpack_archive(upload, tmp_path / "content")
    assert [found["code"] for found in refused.value.details["errors"]] == [
        "text_invalid"
    ]
    assert not (tmp_path / "content").exists()


def test_export_is_the_validated_content_within_the_rules_it_came_in_under(
    tmp_path: Path,
) -> None:
    files = {
        "README.md": README,
        "assets/icon.png": PNG,
        "assets/zeros.txt": b"0" * 300_000,
        "empty.txt": b"",
    }
    source = tmp_path / "source"
    (source / "assets").mkdir(parents=True)
    (source / "plugin.json").write_bytes(manifest(files))
    for path, data in files.items():
        (source / path).write_bytes(data)
    loaded = load_directory(source, builtin=False)
    exported = tmp_path / "exported.phasynplugin"
    with exported.open("wb") as target:
        write_archive(loaded, target)
    # A file that deflates a thousand times smaller is still deflated, only not beyond the ratio an upload may have.
    assert exported.stat().st_size < 30_000
    with zipfile.ZipFile(
        exported
    ) as reader:  # an independent reader, checksums included
        assert (
            reader.namelist() == ["plugin.json", *sorted(files)]
            and reader.testzip() is None
        )
        assert {path: reader.read(path) for path in files} == files
    assert unpack_archive(exported, tmp_path / "content").digest == loaded.digest


def test_loading_a_directory_follows_no_link_and_serves_only_validated_bytes(
    tmp_path: Path,
) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("outside the package", encoding="utf-8")
    upload = tmp_path / "upload"
    upload.write_bytes(package(GOOD))
    root = unpack_archive(upload, tmp_path / "content").root

    def refused() -> list[str]:
        with pytest.raises(ComponentError) as error:
            load_directory(root, builtin=False)
        assert str(tmp_path) not in json.dumps(
            error.value.to_dict(), ensure_ascii=False
        )
        return [found["code"] for found in error.value.details["errors"]]

    (root / "notes.txt").symlink_to(secret)  # a link to a file outside
    assert "link_not_allowed" in refused()
    (root / "notes.txt").unlink()
    (root / "more").symlink_to(tmp_path)  # a link to a directory outside
    assert "link_not_allowed" in refused()
    (root / "more").unlink()
    os.link(secret, root / "notes.txt")  # a second name for a file outside
    assert "link_not_allowed" in refused()
    (root / "notes.txt").unlink()

    loaded = load_directory(root, builtin=False)
    readme = loaded.file("README.md")
    assert (
        readme is not None
        and read_file(loaded, readme) == README
        and loaded.file("../secret.txt") is None
    )

    # A second name for one of the package's own files: refused where a link could bring in a file of the host, and
    # accepted for a copy the Controller wrote itself and checks against its recorded digest
    os.link(root / "README.md", tmp_path / "backup-of-readme")
    assert "link_not_allowed" in refused()
    assert load_directory(root, builtin=False, linked=True).digest == loaded.digest
    for path in (
        "../secret.txt",
        "assets/../../secret.txt",
        "/etc/passwd",
        "plugin.json/x",
        "",
    ):
        with pytest.raises(ComponentError) as missing:
            open_file(root, path)
        assert missing.value.code == "NOT_FOUND"
    (root / "README.md").unlink()
    (root / "README.md").symlink_to(secret)  # swapped after it was validated
    with pytest.raises(ComponentError) as swapped:
        read_file(loaded, readme)
    assert swapped.value.code == "NOT_FOUND"
    (root / "README.md").unlink()
    (root / "README.md").write_bytes(b"# Changed\n")  # edited after it was validated
    with pytest.raises(ComponentError) as edited:
        read_file(loaded, readme)
    assert edited.value.code == "STATE_CONFLICT"
