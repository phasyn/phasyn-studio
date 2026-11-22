"""Path-free model identity shared by the GPU runtimes (identity format v2).

A model identity records *which* weights a component loaded without recording *where* they live on the
user's disk, so ``actual_settings``, bundle metadata and PNG text chunks can be shared safely:

* Every path is stored relative to ``load.model_path`` as a POSIX string (key ``path``); the identity
  carries ``"path_base": "load.model_path"`` so readers know what the paths are relative to.
* A path that is not under ``load.model_path`` (or is ``load.model_path`` itself) keeps only its basename
  (key ``name``) — the same rule the diagnostic export applies when it redacts paths.
* Weights are identified by ``path_stat`` (file count, total size, newest mtime); content hashes of
  multi-GB weights are not recomputed on every load. Small config files (``*.json``, ``*.txt``,
  ``*.jinja``, at most 16 MiB) are hashed as well, so a changed config at the same path is visible;
  a single small file is hashed whole.

Standard library only: the control plane imports this module and must never import torch.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator, Mapping
from pathlib import Path, PurePath
from typing import Any


PATH_BASE = "load.model_path"
CONFIG_SUFFIXES = (".json", ".txt", ".jinja")
SMALL_FILE_BYTES = 16 * 1024 * 1024
SHA256_REASON = "權重檔只記大小與 mtime（不在每次載入時重算 SHA-256）"
RELATIVE_NOTE = "（相對於 load.model_path）"
# POSIX "/…", Windows "C:\\…" or "C:/…", and UNC "\\\\server\\share" (a bare "a:b" is not a path)
_ABSOLUTE = re.compile(r"^(?:/|[A-Za-z]:[\\/]|\\\\)")


def location(path: Path, root: Path | None) -> dict[str, str]:
    """``{"path": <POSIX path relative to root>}`` when ``path`` is inside ``root``, else ``{"name": basename}``.

    The check is lexical (no ``resolve()``): model folders are often assembled from symlinks, and
    following them would turn a configured relative layout into the user's real disk layout.
    """
    if root is not None:
        relative: Path | None
        try:
            relative = path.relative_to(root)
        except ValueError:
            relative = None
        if relative is not None and relative.parts and ".." not in relative.parts:
            return {"path": relative.as_posix()}
    return {"name": path.name}


def display_path(path: Path, root: Path | None) -> str:
    """Path for user-facing messages: relative to ``load.model_path`` when possible, otherwise the basename."""
    place = location(path, root)
    return f"{place['path']}{RELATIVE_NOTE}" if "path" in place else place["name"]


def _sha256_file(path: Path) -> str:
    with path.open("rb") as fh:
        return hashlib.file_digest(fh, "sha256").hexdigest()


def path_stat(
    path: Path, root: Path | None, *, hash_configs: bool = True
) -> dict[str, Any]:
    """Identity of one file or directory: location, file count, total size, newest mtime and small-file hashes.

    * file: ``sha256`` of the content when it is at most ``SMALL_FILE_BYTES`` (else ``None``).
    * directory (recursive): ``config_files`` and ``config_sha256`` over the small config files, hashed in
      sorted relative-path order as ``rel + NUL + bytes + NUL``.
    * missing: ``missing: true`` with zero counts. Files that cannot be read are counted in
      ``unreadable_files`` instead of being skipped silently.
    """
    out: dict[str, Any] = location(path, root)
    if path.is_file():
        try:
            st = path.stat()
            digest = (
                _sha256_file(path)
                if hash_configs and st.st_size <= SMALL_FILE_BYTES
                else None
            )
        except OSError as exc:
            return {
                **out,
                "files": 1,
                "size_bytes": 0,
                "mtime_ns": 0,
                "error": type(exc).__name__,
            }
        return {
            **out,
            "files": 1,
            "size_bytes": int(st.st_size),
            "mtime_ns": int(st.st_mtime_ns),
            "sha256": digest,
        }
    if not path.is_dir():
        return {**out, "files": 0, "size_bytes": 0, "mtime_ns": 0, "missing": True}
    files = sorted(p for p in path.rglob("*") if p.is_file())
    size = 0
    mtime = 0
    hashed = 0
    unreadable = 0
    config = hashlib.sha256()
    for file in files:
        try:
            st = file.stat()
            size += st.st_size
            mtime = max(mtime, st.st_mtime_ns)
            if (
                hash_configs
                and file.suffix in CONFIG_SUFFIXES
                and st.st_size <= SMALL_FILE_BYTES
            ):
                data = file.read_bytes()
                config.update(
                    file.relative_to(path).as_posix().encode("utf-8")
                    + b"\0"
                    + data
                    + b"\0"
                )
                hashed += 1
        except OSError:
            unreadable += 1
    out.update({"files": len(files), "size_bytes": size, "mtime_ns": mtime})
    if hash_configs:
        out.update(
            {
                "config_files": hashed,
                "config_sha256": config.hexdigest() if hashed else None,
            }
        )
    if unreadable:
        out["unreadable_files"] = unreadable
    return out


def _absolute_facts(value: Any, where: str) -> Iterator[str]:
    """Where ``value`` (recursively) holds a path object or an absolute path string."""
    if isinstance(value, PurePath) or (
        isinstance(value, str) and _ABSOLUTE.match(value)
    ):
        yield where
    elif isinstance(value, Mapping):
        for key, item in value.items():
            yield from _absolute_facts(item, f"{where}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            yield from _absolute_facts(item, f"{where}[{index}]")


def model_identity(
    root: Path | None,
    components: Mapping[str, Path],
    *,
    hash_configs: bool = True,
    **facts: Any,
) -> dict[str, Any]:
    """Model identity v2 for ``LoadResult.model_identity`` and output metadata.

    ``components`` maps a component name (for example ``"vae"``) to its file or directory; ``facts`` are
    extra path-free fields (variant, architectures, …). Passing a path object or an absolute path string as a
    fact (at any depth) is a programming error, because it would bypass the relative-path rule.
    """
    leaked = [
        where for key, value in facts.items() for where in _absolute_facts(value, key)
    ]
    if leaked:
        raise TypeError(f"model_identity facts must not be paths: {', '.join(leaked)}")
    return {
        "path_base": PATH_BASE,
        "identity_strength": "path_stat+config_sha256" if hash_configs else "path_stat",
        "sha256": None,
        "sha256_reason": SHA256_REASON,
        **facts,
        "components": {
            name: path_stat(path, root, hash_configs=hash_configs)
            for name, path in components.items()
        },
    }


__all__ = [
    "CONFIG_SUFFIXES",
    "PATH_BASE",
    "RELATIVE_NOTE",
    "SHA256_REASON",
    "SMALL_FILE_BYTES",
    "display_path",
    "location",
    "model_identity",
    "path_stat",
]
