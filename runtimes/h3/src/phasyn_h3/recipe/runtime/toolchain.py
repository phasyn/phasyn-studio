"""JIT toolchain and kernel-cache location for the component process (torch-free).

SGLang JIT-compiles the convrot_int8 ops with ``nvcc`` driven by ``ninja``
(``sglang/kernels/jit/utils/compile/ninja.py`` runs ``ninja`` from ``PATH``;
``toolchain.cuda_home`` takes ``CUDA_HOME``/``CUDA_PATH``, then ``nvcc`` on ``PATH``,
then ``/usr/local/cuda``).  The Node starts component processes with a minimal ``PATH``
(the systemd unit's), so the runtime resolves both tools itself, exports
``CUDA_HOME`` and prepends their directories to ``PATH`` inside the process only,
and pins the build cache to one stable directory so the first build happens once
per machine instead of once per process:

* ``PHASYN_JIT_CACHE_DIR`` when set (``provider_options.jit_cache_dir`` or the node config ``runtimes[].env``),
* else ``$XDG_CACHE_HOME/phasyn-studio/jit`` or ``~/.cache/phasyn-studio/jit``.

The SGLang build key covers sources, flags and toolchain, so sharing the cache
between actors of one runtime tuple is safe.

Compiled kernels are loaded from the cache and run inside the process, and
``provider_options.jit_cache_dir`` can be changed through the settings API, so the
directory is used only when no other account can write to it or replace any directory
above it (:func:`untrusted_directory`); otherwise the load fails with
``JIT_CACHE_NOT_PRIVATE``.
"""

from __future__ import annotations

import grp
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass
from pathlib import Path

from .errors import UnsupportedCombination

JIT_CACHE_ENV = "PHASYN_JIT_CACHE_DIR"
DEFAULT_CUDA_HOMES = ("/usr/local/cuda",)


@dataclass(frozen=True)
class JitToolchain:
    cuda_home: str | None
    nvcc: str | None
    nvcc_version: str | None
    ninja: str | None
    cache_dir: str

    @property
    def complete(self) -> bool:
        return bool(self.nvcc and self.ninja)

    def missing(self) -> list[str]:
        return [name for name, path in (("nvcc", self.nvcc), ("ninja", self.ninja)) if not path]

    def as_dict(self) -> dict[str, str | None]:
        return {
            "cuda_home": self.cuda_home,
            "nvcc": self.nvcc,
            "nvcc_version": self.nvcc_version,
            "ninja": self.ninja,
            "cache_dir": self.cache_dir,
        }


def jit_cache_dir(env: Mapping[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    explicit = env.get(JIT_CACHE_ENV)
    if explicit:
        return Path(explicit)
    xdg = env.get("XDG_CACHE_HOME")
    base = Path(xdg) if xdg else Path(env.get("HOME") or Path.home()) / ".cache"
    return base / "phasyn-studio" / "jit"


def _private_group(gid: int) -> bool:
    """Whether ``gid`` is this account's own group with no other member (a user-private group)."""
    if gid != os.getgid():
        return False
    uid = os.getuid()
    try:
        me = pwd.getpwuid(uid).pw_name
        members = grp.getgrgid(gid).gr_mem
        primaries = [entry for entry in pwd.getpwall() if entry.pw_gid == gid and entry.pw_uid != uid]
    except KeyError:
        return False
    return not primaries and all(name == me for name in members)


def untrusted_directory(path: Path) -> str | None:
    """Why native code must not be loaded from ``path``; ``None`` when only this account or root can change it.

    The directory (symlinks resolved; a part that does not exist yet is skipped) and every directory above it
    must belong to this account or to root and must not be writable by anyone else. A user-private group may
    write. A directory with the sticky bit (``/tmp``) may sit above even when its group or everyone can write
    to it, because only an entry's owner can replace the entry there; the cache directory itself gets no such
    exemption, since the sticky bit does not stop anyone from adding files to it.
    """
    uid = os.getuid()
    resolved = Path(os.path.realpath(path))
    for directory in (resolved, *resolved.parents):
        try:
            info = directory.stat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            return f"{directory.name or '/'}：無法讀取（{exc.strerror or type(exc).__name__}）"
        name = directory.name or "/"
        if info.st_uid not in (0, uid):
            return f"{name} 屬於另一個帳號"
        if info.st_mode & stat.S_ISVTX and directory != resolved:
            continue  # entries of a sticky directory are replaceable only by their owner, checked one level down
        if info.st_mode & stat.S_IWOTH:
            return f"{name} 開放所有人寫入"
        if info.st_mode & stat.S_IWGRP and not _private_group(info.st_gid):
            return f"{name} 開放群組寫入"
    return None


def _executable(path: Path) -> str | None:
    return str(path) if path.is_file() and os.access(path, os.X_OK) else None


def _find_nvcc(env: Mapping[str, str]) -> tuple[str | None, str | None]:
    """(cuda_home, nvcc) resolved the way SGLang's JIT resolves it, plus /usr/local/cuda."""
    for key in ("CUDA_HOME", "CUDA_PATH"):
        home = env.get(key)
        if home:
            return home, _executable(Path(home) / "bin" / "nvcc")
    on_path = shutil.which("nvcc", path=env.get("PATH"))
    if on_path:
        return str(Path(on_path).parent.parent), on_path
    for home in DEFAULT_CUDA_HOMES:
        nvcc = _executable(Path(home) / "bin" / "nvcc")
        if nvcc:
            return home, nvcc
    return None, None


def _find_ninja(env: Mapping[str, str]) -> str | None:
    on_path = shutil.which("ninja", path=env.get("PATH"))
    if on_path:
        return on_path
    # the runtime env ships the `ninja` wheel (uv.lock); `python -I` does not put
    # its bin directory on PATH
    for candidate in (Path(sys.prefix) / "bin" / "ninja", Path("/usr/bin/ninja"), Path("/usr/local/bin/ninja")):
        found = _executable(candidate)
        if found:
            return found
    return None


def _nvcc_version(nvcc: str | None) -> str | None:
    if not nvcc:
        return None
    try:
        output = subprocess.run([nvcc, "--version"], capture_output=True, text=True, timeout=30, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"release (\d+\.\d+)", output or "")
    return match.group(1) if match else None


def resolve_jit_toolchain(env: Mapping[str, str] | None = None) -> JitToolchain:
    env = os.environ if env is None else env
    cuda_home, nvcc = _find_nvcc(env)
    return JitToolchain(
        cuda_home=cuda_home,
        nvcc=nvcc,
        nvcc_version=_nvcc_version(nvcc),
        ninja=_find_ninja(env),
        cache_dir=str(jit_cache_dir(env)),
    )


def apply_jit_environment(env: MutableMapping[str, str] | None = None) -> JitToolchain:
    """Export the resolved toolchain and cache dir into this (actor) process."""
    target = os.environ if env is None else env
    toolchain = resolve_jit_toolchain(target)
    path_parts = [p for p in (target.get("PATH") or "").split(os.pathsep) if p]
    prepend = []
    for tool in (toolchain.nvcc, toolchain.ninja):
        if tool:
            folder = str(Path(tool).parent)
            if folder not in path_parts and folder not in prepend:
                prepend.append(folder)
    if prepend:
        target["PATH"] = os.pathsep.join([*prepend, *path_parts])
    if toolchain.cuda_home and not target.get("CUDA_HOME"):
        target["CUDA_HOME"] = toolchain.cuda_home
    Path(toolchain.cache_dir).mkdir(parents=True, exist_ok=True)
    problem = untrusted_directory(Path(toolchain.cache_dir))
    if problem:
        raise UnsupportedCombination(
            "JIT_CACHE_NOT_PRIVATE",
            f"JIT kernel 快取目錄不能使用：{problem}。編譯好的 kernel 會從這個目錄載入並在元件程序內執行，"
            "請改用只有執行元件的帳號能寫入的目錄（provider_options.jit_cache_dir，或 node config 的 "
            "runtimes.<id>.env.PHASYN_JIT_CACHE_DIR）",
            expected="a directory only this account can write to",
            actual=problem,
        )
    target["SGLANG_JIT_CACHE_DIR"] = toolchain.cache_dir
    return toolchain


def require_jit_toolchain(feature: str, env: Mapping[str, str] | None = None) -> JitToolchain:
    """Fail with a clear diagnostic before any load when the JIT build cannot run."""
    toolchain = resolve_jit_toolchain(env)
    if not toolchain.complete:
        raise UnsupportedCombination(
            "JIT_TOOLCHAIN_MISSING",
            f"{feature} 需要 JIT 編譯（nvcc + ninja），此 actor 找不到 {toolchain.missing()}；"
            "請安裝 CUDA toolkit（/usr/local/cuda/bin/nvcc）與 ninja（apt ninja-build 或 runtime env 的 ninja wheel），"
            "或在 node config 的 runtimes.<id>.env 設定 CUDA_HOME",
            expected="nvcc,ninja",
            actual=toolchain.as_dict(),
        )
    return toolchain


__all__ = [
    "JIT_CACHE_ENV",
    "JitToolchain",
    "apply_jit_environment",
    "jit_cache_dir",
    "require_jit_toolchain",
    "resolve_jit_toolchain",
    "untrusted_directory",
]
