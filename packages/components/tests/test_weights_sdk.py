"""The weight-plan SDK: validated plan objects, manifest selection, identical-file
links and the two verification hashes; the runtime host's ``weights()`` for providers with and without a plan."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest

from phasyn_components.errors import ComponentError
from phasyn_components.weights import (
    WeightFile,
    WeightLicense,
    WeightSet,
    file_matches,
    new_digest,
    safe_relative,
)


REV = "a" * 40
LICENSE = WeightLicense(
    name="Test License", url="https://example.test/license", note="research only"
)


def test_paths_must_stay_relative() -> None:
    assert safe_relative("a/b.json") == "a/b.json"
    assert safe_relative("", allow_empty=True) == ""
    for bad in ("/abs", "../up", "a/../b", "a//b", "a\\b", "", "./a"):
        with pytest.raises(ComponentError):
            safe_relative(bad)


def test_sets_are_pinned_and_consistent() -> None:
    files = (WeightFile(path="a.json", size=1, git_oid="1" * 40),)
    good = WeightSet(
        set_id="s",
        label="S",
        repo="org/name",
        revision=REV,
        license=LICENSE,
        dest="",
        files=files,
    )
    assert good.total_bytes == 1
    for kwargs in (
        {"revision": "main"},
        {"repo": "no-owner"},
        {"repo": "org/a/b"},
        {"set_id": "bad id"},
        {"dest": "../x"},
    ):
        with pytest.raises(ComponentError):
            arguments: dict[str, Any] = {
                "set_id": "s",
                "label": "S",
                "repo": "org/name",
                "revision": REV,
                "license": LICENSE,
                "dest": "",
                "files": files,
                **kwargs,
            }
            WeightSet(**arguments)
    with pytest.raises(ComponentError):
        WeightSet(
            set_id="s",
            label="S",
            repo="org/name",
            revision=REV,
            license=LICENSE,
            dest="",
            files=files * 2,
        )
    with pytest.raises(ComponentError):
        WeightSet(
            set_id="s",
            label="S",
            repo="org/name",
            revision=REV,
            license=LICENSE,
            dest="",
            files=files,
            links={"other": ("x",)},
        )


def test_both_verification_hashes(tmp_path: Path) -> None:
    data = b"hello\n"
    # `git hash-object` of "hello\n"
    lfs = WeightFile(
        path="big.bin", size=len(data), sha256=hashlib.sha256(data).hexdigest()
    )
    git = WeightFile(
        path="config.json",
        size=len(data),
        git_oid="ce013625030ba8dba906f756967f9e9ca394464a",
    )
    digest = new_digest(git)
    digest.update(data)
    assert digest.hexdigest() == git.git_oid
    path = tmp_path / "f"
    path.write_bytes(data)
    assert file_matches(path, lfs) and file_matches(path, git)
    path.write_bytes(b"HELLO\n")
    assert not file_matches(path, lfs) and not file_matches(path, git)
    assert not file_matches(tmp_path / "missing", lfs)
