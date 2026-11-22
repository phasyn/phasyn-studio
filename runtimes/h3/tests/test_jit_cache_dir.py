"""Compiled kernels are loaded from the JIT cache and run inside the component process, and the cache directory
is a provider option the settings API can change: it is used only when no other account can write to it or to
a directory above it."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from phasyn_h3.recipe.runtime import toolchain
from phasyn_h3.recipe.runtime.errors import UnsupportedCombination


def test_a_jit_cache_other_accounts_can_write_to_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tmp_path.chmod(0o700)
    private = tmp_path / "private" / "jit"
    private.mkdir(parents=True)
    for directory in (private.parent, private):
        directory.chmod(0o700)
    assert toolchain.untrusted_directory(private) is None
    assert toolchain.untrusted_directory(private / "not" / "made" / "yet") is None
    usable = {"PATH": "", toolchain.JIT_CACHE_ENV: str(private)}
    assert (
        toolchain.apply_jit_environment(usable).cache_dir
        == str(private)
        == usable["SGLANG_JIT_CACHE_DIR"]
    )

    shared = tmp_path / "shared"
    shared.mkdir()
    shared.chmod(0o777)  # no sticky bit: anyone can replace what is inside
    (shared / "jit").mkdir(mode=0o700)
    link = tmp_path / "link"
    link.symlink_to(shared / "jit", target_is_directory=True)
    open_cache = tmp_path / "open"
    open_cache.mkdir()
    open_cache.chmod(
        0o777 | stat.S_ISVTX
    )  # the sticky bit protects entries, not the directory itself
    for unsafe in (shared / "jit", link, open_cache):
        assert toolchain.untrusted_directory(unsafe) is not None, unsafe

    grouped = tmp_path / "grouped"
    grouped.mkdir()
    grouped.chmod(0o770)
    monkeypatch.setattr(toolchain, "_private_group", lambda gid: gid == os.getgid())
    assert (
        toolchain.untrusted_directory(grouped) is None
    )  # a user-private group may write
    monkeypatch.setattr(toolchain, "_private_group", lambda _gid: False)
    assert toolchain.untrusted_directory(grouped) is not None

    # a sticky directory above the cache (the system's /tmp: root's group and everyone may write) is fine, because
    # nobody else can replace the entry in it; a directory in between that others can write to is still refused
    sticky = tmp_path / "sticky"
    (sticky / "mine" / "jit").mkdir(parents=True)
    sticky.chmod(0o777 | stat.S_ISVTX)
    for directory in (sticky / "mine", sticky / "mine" / "jit"):
        directory.chmod(0o700)
    assert toolchain.untrusted_directory(sticky / "mine" / "jit") is None
    (sticky / "mine").chmod(0o770)
    assert toolchain.untrusted_directory(sticky / "mine" / "jit") is not None
    (sticky / "mine").chmod(0o700)

    env = {"PATH": "", toolchain.JIT_CACHE_ENV: str(shared / "jit")}
    with pytest.raises(UnsupportedCombination) as refused:
        toolchain.apply_jit_environment(env)
    assert (
        refused.value.reason_code == "JIT_CACHE_NOT_PRIVATE"
        and "SGLANG_JIT_CACHE_DIR" not in env
    )
    assert (
        str(tmp_path) not in refused.value.message
    )  # the diagnostic names the directory, not its path
