"""Studio plugin packages: bounded validation, unpacking, loading and re-packing.

A ``.phasynplugin`` file is a zip archive (stored or deflate) with ``plugin.json`` at its root. Everything in it is
untrusted data from a stranger: nothing is ever extracted with ``extractall``, imported or executed.

- :func:`unpack_archive` checks the archive before it reads a single member (the end record and the central
  directory are bounded first), then every entry (path, links, encryption, compression, sizes, ratio, kind), then
  the manifest (:mod:`phasyn_components.plugin_manifest`), and only then writes the members one by one into a new
  directory: each is read in blocks, counted, hashed, checked against its kind and compared with the manifest's
  ``integrity.files``. Any failure removes the directory again.
- :func:`load_directory` applies the same rules to an unpacked package (a built-in package, a development
  directory, an installed package) without following a link.
- :func:`write_archive` packs a loaded package in a fixed order with fixed timestamps, so an export is exactly the
  validated content.

Paths are opened step by step relative to a directory descriptor and never through a link. Problems are
``StudioPluginIssue`` objects whose ``path`` is a path inside the package, never one of this host.
"""

from __future__ import annotations

import codecs
import contextlib
import errno
import hashlib
import os
import re
import shutil
import stat
import struct
import zipfile
import zlib
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any, BinaryIO

from .errors import ComponentError, exception_message
from .fs import fsync_dir
from .plugin_manifest import (
    LIMITS,
    MAIN_NAME,
    MANIFEST_NAME,
    PLAIN_FILE_NAMES,
    Issue,
    PluginLimits,
    invalid,
    issue,
    parse_manifest,
)


PACKAGE_SUFFIX = ".phasynplugin"
OCTET_STREAM = "application/octet-stream"
# Bitmaps whose header was checked are the only files served with their own type.
IMAGE_TYPES: Mapping[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
}
TEXT_EXTENSIONS = frozenset({".json", ".js", ".md", ".txt", ".cube"})

BLOCK_BYTES = 64 * 1024
SHOWN_NAME_CHARS = 200
_SEGMENT = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9._-]*")
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
# O_NONBLOCK: opening a FIFO that took a file's place must not hang; it is then refused as "not a regular file".
_READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
_CREATE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
# What opening a path of a package answers when the path is not (or no longer) a plain file below the root.
_NOT_A_FILE = frozenset({errno.ENOENT, errno.ENOTDIR, errno.ELOOP})

# End of central directory record: signature, this disk, directory disk, entries here, entries, size, offset, comment.
_END_RECORD = struct.Struct("<4s4H2LH")
_END_SIGNATURE = b"PK\x05\x06"
_ZIP64_LOCATOR = b"PK\x06\x07"
_ZIP64_LOCATOR_BYTES = 20
_LOCAL_SIGNATURE = b"PK\x03\x04"
_END_SEARCH_BYTES = _END_RECORD.size + 0xFFFF
# Local file header: signature, version needed, flags, method, time, date, CRC-32, compressed size, size, name
# length, extra length. A central directory record has the version it was made by after the signature, and after
# the extra length: comment length, disk, internal attributes, external attributes, offset of the local header.
_LOCAL_HEADER = struct.Struct("<4s5H3L2H")
_LOCAL_HEADER_BYTES = _LOCAL_HEADER.size
_DIRECTORY_RECORD = struct.Struct("<4s6H3L5H2L")
_DIRECTORY_SIGNATURE = b"PK\x01\x02"
_ENCRYPTION_FLAGS = (
    0x1 | 0x40 | 0x2000
)  # encrypted, strong encryption, masked local headers
_COMPRESSION = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})
# What a broken or hostile archive makes zipfile and zlib raise.
_ARCHIVE_ERRORS = (
    zipfile.BadZipFile,
    zipfile.LargeZipFile,
    zlib.error,
    struct.error,
    EOFError,
    NotImplementedError,
    RuntimeError,
    ValueError,
    OverflowError,
)
# What an export writes for every member: zip 2.0 made on Unix, 1980-01-01 00:00:00, a plain file readable by all.
_EXPORT_VERSION = 20
_EXPORT_MADE_BY = (3 << 8) | _EXPORT_VERSION
_EXPORT_DOS_TIME = 0
_EXPORT_DOS_DATE = (1 << 5) | 1
_EXPORT_MODE = (stat.S_IFREG | 0o644) << 16


_FILE_SIGNATURE_BYTES = 12
_ZIP64_ENTRY_SENTINEL = 0xFFFF
_ZIP64_OFFSET_SENTINEL = 0xFFFFFFFF


@dataclass(frozen=True)
class PackageFile:
    """One file of a package other than ``plugin.json`` (contract ``StudioPluginFile``)."""

    path: str
    size: int
    sha256: str
    media_type: str

    def to_dict(self) -> dict[str, Any]:
        """Serialize the object to its wire representation."""
        return {
            "path": self.path,
            "size_bytes": self.size,
            "sha256": self.sha256,
            "media_type": self.media_type,
        }


@dataclass(frozen=True)
class Package:
    """A validated package unpacked at ``root``: its manifest and every other file with size and hash."""

    root: Path
    manifest: dict[str, Any]
    manifest_size: int
    manifest_sha256: str
    files: tuple[PackageFile, ...]  # sorted by path
    digest: str

    @property
    def plugin_id(self) -> str:
        """Return the identifier declared by the package."""
        return str(self.manifest["id"])

    @property
    def version(self) -> str:
        """Return the version declared by the package."""
        return str(self.manifest["version"])

    @property
    def size_bytes(self) -> int:
        """Return the size of the package contents in bytes."""
        return self.manifest_size + sum(item.size for item in self.files)

    @property
    def file_count(self) -> int:
        """Return the number of files represented in the package."""
        return len(self.files) + 1

    def file(self, path: str) -> PackageFile | None:
        """The file whose path is exactly ``path`` (a string comparison with the package's own list)."""
        return next((item for item in self.files if item.path == path), None)


def package_digest(hashes: Mapping[str, str]) -> str:
    """Identity of a package's content: SHA-256 over ``path NUL sha256 LF`` of every file, sorted by path."""
    digest = hashlib.sha256()
    for path in sorted(hashes):
        digest.update(f"{path}\x00{hashes[path]}\n".encode())
    return digest.hexdigest()


def archive_name(package: Package) -> str:
    """Return the archive member name."""
    return f"{package.plugin_id}-{package.version}{PACKAGE_SUFFIX}"


# ---------------------------------------------------------------------------------------------- rules for one file
def _shown(name: str) -> str:
    """A member name as it may appear in an issue: bounded, without control characters."""
    return "".join(ch if ch.isprintable() else "?" for ch in name[:SHOWN_NAME_CHARS])


def _extension(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    return name[name.rfind(".") :] if "." in name else ""


def path_allowed(path: str, limits: PluginLimits = LIMITS) -> bool:
    """A relative path of at most ``path_depth`` segments made of ``[A-Za-z0-9._-]``, none starting with a dot."""
    parts = path.split("/")
    return (
        0 < len(path) <= limits.path_length
        and len(parts) <= limits.path_depth
        and all(_SEGMENT.fullmatch(part) for part in parts)
    )


def kind_allowed(path: str) -> bool:
    """Whether a package may carry this file: a listed extension, ``main.js`` only at the root, ``LICENSE``."""
    if path in PLAIN_FILE_NAMES:
        return True
    extension = _extension(path)
    if extension == ".js":
        return path == MAIN_NAME
    return extension in IMAGE_TYPES or extension in TEXT_EXTENSIONS


def size_limit(path: str, limits: PluginLimits) -> int:
    """Return the admitted size limit for this file."""
    return {MANIFEST_NAME: limits.manifest_bytes, MAIN_NAME: limits.main_bytes}.get(
        path, limits.file_bytes
    )


def media_type(path: str) -> str:
    """Return the declared media type."""
    return IMAGE_TYPES.get(_extension(path), OCTET_STREAM)


def _file_issue(path: str, size: int, limits: PluginLimits) -> Issue | None:
    """What is wrong with a regular file of this path and size (the rules an archive entry and a file on disk share)."""
    if not path_allowed(path, limits):
        return issue("path_not_allowed", path=_shown(path))
    if not kind_allowed(path):
        return issue("extension_not_allowed", path=path)
    limit = size_limit(path, limits)
    if size > limit:
        return issue("file_too_large", path=path, size=size, limit=limit)
    return None


class _ContentCheck:
    """Whether the bytes of a file are what its name says: a bitmap header, or UTF-8 text without NUL."""

    def __init__(self, path: str) -> None:
        self._image = _extension(path) if _extension(path) in IMAGE_TYPES else None
        self._head = b""
        self._decoder = codecs.getincrementaldecoder("utf-8")("strict")
        self._ok = True

    def feed(self, block: bytes) -> None:
        if self._image is not None:
            if len(self._head) < _FILE_SIGNATURE_BYTES:
                self._head += block[: _FILE_SIGNATURE_BYTES - len(self._head)]
            return
        if not self._ok:
            return
        try:
            self._decoder.decode(block)
        except UnicodeDecodeError:
            self._ok = False
        if b"\x00" in block:
            self._ok = False

    def finish(self) -> bool:
        if self._image == ".png":
            return self._head.startswith(b"\x89PNG\r\n\x1a\n")
        if self._image == ".jpg":
            return self._head.startswith(b"\xff\xd8\xff")
        if self._image == ".webp":
            return self._head[:4] == b"RIFF" and self._head[8:12] == b"WEBP"
        try:
            self._decoder.decode(b"", final=True)
        except UnicodeDecodeError:
            return False
        return self._ok


class _Names:
    """Paths seen so far, compared without case: a name is one file or one directory, spelled one way."""

    def __init__(self) -> None:
        self._seen: dict[str, tuple[str, bool]] = {}

    def _take(self, path: str, *, is_dir: bool) -> bool:
        known = self._seen.setdefault(path.lower(), (path, is_dir))
        return known == (path, is_dir) and is_dir

    def add(self, path: str, *, is_dir: bool) -> bool:
        """Record ``path`` and its parent directories; False when it clashes with an earlier entry."""
        parts = path.split("/")
        parents_ok = all(
            self._take("/".join(parts[:depth]), is_dir=True)
            for depth in range(1, len(parts))
        )
        if is_dir:
            return parents_ok and self._take(path, is_dir=True)
        fresh = path.lower() not in self._seen
        self._seen.setdefault(path.lower(), (path, False))
        return parents_ok and fresh


# ---------------------------------------------------------------------------------------------- file system
def _io_error(exc: OSError, what: str) -> ComponentError:
    if exc.errno == errno.ENOSPC:
        return ComponentError(
            "DISK_FULL", f"{what}：磁碟已滿", details={"errno": exc.errno}
        )
    return ComponentError(
        "RUNTIME_ERROR",
        f"{what}：{exception_message(exc)}",
        details={"errno": exc.errno},
    )


def _open_parent(root_fd: int, parts: list[str], *, create: bool) -> int:
    """Descriptor of the directory that holds the last part; each step is opened without following a link."""
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            if create:
                with contextlib.suppress(FileExistsError):
                    os.mkdir(part, 0o700, dir_fd=fd)
            below = os.open(part, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = below
    except BaseException:
        os.close(fd)
        raise
    return fd


def _open_at(root_fd: int, path: str, flags: int, mode: int = 0o600) -> int:
    parts = path.split("/")
    parent = _open_parent(root_fd, parts, create=bool(flags & os.O_CREAT))
    try:
        return os.open(parts[-1], flags, mode, dir_fd=parent)
    finally:
        os.close(parent)


def open_file(root: Path, path: str) -> BinaryIO:
    """Open one regular file of an unpacked package for reading; ``path`` is a path of the package's own list.

    No step below ``root`` follows a link, and anything that is not a regular file is refused.
    """
    missing = ComponentError("NOT_FOUND", "插件包內沒有這個檔案")
    if not path_allowed(path):
        raise missing
    try:
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fd = _open_at(root_fd, path, _READ_FLAGS)
        finally:
            os.close(root_fd)
    except OSError as exc:
        raise (
            missing
            if exc.errno in _NOT_A_FILE
            else _io_error(exc, "無法讀取插件包的檔案")
        ) from exc
    try:
        _require_regular_member(fd, missing)
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def _require_regular_member(fd: int, missing: ComponentError) -> None:
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        raise missing


def _fsync_tree(root: Path, paths: list[str]) -> None:
    """Persist the directory entries of an unpacked package (each file was synced when it was written)."""
    directories = {
        "/".join(path.split("/")[:depth])
        for path in paths
        for depth in range(len(path.split("/")))
    }
    for relative in sorted(directories):
        fsync_dir(root / relative if relative else root)


# ---------------------------------------------------------------------------------------------- archives
@contextlib.contextmanager
def _reading_archive() -> Iterator[None]:
    """Whatever zipfile or zlib raise for a broken or hostile archive is a refused package, not a server error."""
    try:
        yield
    except _ARCHIVE_ERRORS as exc:
        raise invalid([issue("archive_unreadable", reason=type(exc).__name__)]) from exc


def _check_layout(handle: BinaryIO, limits: PluginLimits) -> tuple[int, int]:
    """Refuse an archive whose end record is not plain, before zipfile reads the central directory.

    The record must be the last bytes of the file (no comment, one disk, no zip64), name at most ``limits.files``
    entries and a bounded central directory that ends exactly where the record starts, and the file must start
    with a local header. Returns the number of entries and where the central directory starts.
    """
    size = handle.seek(0, os.SEEK_END)
    handle.seek(max(0, size - _END_SEARCH_BYTES))
    tail = handle.read()
    found = tail.rfind(_END_SIGNATURE)
    if found < 0:
        raise invalid([issue("archive_unreadable", reason="no end record")])
    if found != len(tail) - _END_RECORD.size:
        raise invalid([issue("archive_layout", reason="comment or trailing data")])
    _, disk, directory_disk, here, total, directory_size, offset, comment = (
        _END_RECORD.unpack(tail[found:])
    )
    locator = tail[max(0, found - _ZIP64_LOCATOR_BYTES) : found]
    zip64 = (
        total == _ZIP64_ENTRY_SENTINEL
        or _ZIP64_OFFSET_SENTINEL in (directory_size, offset)
        or locator.startswith(_ZIP64_LOCATOR)
    )
    if zip64 or comment or disk or directory_disk or here != total:
        raise invalid(
            [issue("archive_layout", reason="zip64, comment or several disks")]
        )
    if total > limits.files:
        raise invalid([issue("too_many_files", count=total, limit=limits.files)])
    if (
        directory_size > limits.central_directory_bytes
        or offset + directory_size != size - _END_RECORD.size
    ):
        raise invalid([issue("archive_layout", reason="central directory")])
    handle.seek(0)
    if total and handle.read(len(_LOCAL_SIGNATURE)) != _LOCAL_SIGNATURE:
        raise invalid([issue("archive_layout", reason="data before the first entry")])
    handle.seek(0)
    return int(total), int(offset)


def _check_members(entries: list[zipfile.ZipInfo], directory_offset: int) -> None:
    """Refuse a directory whose members do not lie one after another inside the archive, the first at its start.

    zipfile seeks wherever a record says (a zip64 field can name any offset, which some file systems answer with an
    error and others with an empty read), only warns about two records for one member, and refuses members that
    overlap in other ways only in its recent versions.
    """
    ordered = sorted(entries, key=lambda info: info.header_offset)
    if not ordered:
        return
    if ordered[0].header_offset != 0:
        raise invalid([issue("archive_layout", reason="data before the first entry")])
    # A member takes at least its header and its compressed bytes; the next one, or the directory, starts after it.
    ends = [
        info.header_offset + _LOCAL_HEADER_BYTES + info.compress_size
        for info in ordered
    ]
    starts = [*(info.header_offset for info in ordered[1:]), directory_offset]
    if any(end > start for end, start in zip(ends, starts, strict=True)):
        raise invalid(
            [
                issue(
                    "archive_layout",
                    reason="entries overlap or lie outside the archive",
                )
            ]
        )


def _entry_issue(
    info: zipfile.ZipInfo, path: str, *, is_dir: bool, limits: PluginLimits
) -> Issue | None:
    """What is wrong with one archive entry, judged from the central directory alone."""
    shown = _shown(path)
    if info.filename != info.orig_filename or not path_allowed(path, limits):
        return issue("path_not_allowed", path=shown)
    if info.flag_bits & _ENCRYPTION_FLAGS:
        return issue("encrypted", path=path)
    if info.compress_type not in _COMPRESSION:
        return issue("compression_not_allowed", path=path, method=info.compress_type)
    kind = stat.S_IFMT(info.external_attr >> 16)
    if kind not in (0, stat.S_IFDIR if is_dir else stat.S_IFREG):
        return issue("link_not_allowed", path=path)
    if is_dir:
        return (
            issue("size_mismatch", path=path)
            if info.file_size or info.compress_size
            else None
        )
    problem = _file_issue(path, info.file_size, limits)
    if problem is None and info.file_size > limits.compression_ratio * max(
        info.compress_size, 1
    ):
        problem = issue("ratio_too_high", path=path, limit=limits.compression_ratio)
    return problem


def _archive_files(
    bundle: zipfile.ZipFile, declared: int, directory_offset: int, limits: PluginLimits
) -> dict[str, zipfile.ZipInfo]:
    """The archive's regular files by path, after every entry passed the entry rules."""
    entries = bundle.infolist()
    if len(entries) != declared or len(entries) > limits.files:
        raise invalid([issue("archive_layout", reason="entry count")])
    _check_members(entries, directory_offset)
    names = _Names()
    files: dict[str, zipfile.ZipInfo] = {}
    problems = []
    for info in entries:
        is_dir = info.orig_filename.endswith("/")
        path = info.orig_filename[:-1] if is_dir else info.orig_filename
        problem = _entry_issue(info, path, is_dir=is_dir, limits=limits)
        if problem is None and not names.add(path, is_dir=is_dir):
            problem = issue("duplicate_path", path=path)
        if problem is not None:
            problems.append(problem)
        elif not is_dir:
            files[path] = info
    total = sum(info.file_size for info in files.values())
    if total > limits.unpacked_bytes:
        problems.append(
            issue("total_too_large", size=total, limit=limits.unpacked_bytes)
        )
    if MANIFEST_NAME not in files:
        problems.append(issue("manifest_missing", path=MANIFEST_NAME))
    if problems:
        raise invalid(problems)
    # The budget an unpacked directory is read with (files and directories together): an archive need not list its
    # directories, so the ones its file paths imply count here, or a package would install and fail its next load.
    if len(files) + len(_directories(files)) > limits.files:
        raise invalid([issue("too_many_files", limit=limits.files)])
    return files


def _directories(paths: Iterable[str]) -> set[str]:
    """Every directory the file paths lie in."""
    found: set[str] = set()
    for path in paths:
        parts = path.split("/")[:-1]
        found.update("/".join(parts[: depth + 1]) for depth in range(len(parts)))
    return found


def _member_blocks(bundle: zipfile.ZipFile, info: zipfile.ZipInfo) -> Iterator[bytes]:
    """The member's bytes in blocks, never more than its declared size plus one byte."""
    remaining = info.file_size + 1
    with _reading_archive(), bundle.open(info) as source:
        while remaining > 0:
            block = source.read(min(BLOCK_BYTES, remaining))
            if not block:
                return
            remaining -= len(block)
            yield block


def _file_set_issues(manifest: Mapping[str, Any], paths: set[str]) -> list[Issue]:
    """``integrity.files`` must list exactly the files other than the manifest; ``main`` and main.js come together."""
    listed = set(manifest["integrity"]["files"])
    actual = paths - {MANIFEST_NAME}
    problems = [
        issue("integrity_files_mismatch", path=path) for path in sorted(listed ^ actual)
    ]
    if ("main" in manifest) != (MAIN_NAME in actual):
        problems.append(issue("main_mismatch", path=MAIN_NAME))
    return problems


@dataclass
class _Measured:
    size: int
    sha256: str
    content_ok: bool


def _measure(
    path: str, blocks: Iterator[bytes], sink: BinaryIO | None = None
) -> _Measured:
    """Hash, count and check a file's blocks, writing them to ``sink`` when there is one."""
    digest = hashlib.sha256()
    check = _ContentCheck(path)
    size = 0
    for block in blocks:
        size += len(block)
        digest.update(block)
        check.feed(block)
        if sink is not None:
            sink.write(block)
    return _Measured(size, digest.hexdigest(), check.finish())


def _verified(
    manifest: Mapping[str, Any],
    manifest_data: bytes,
    measured: Mapping[str, _Measured],
    declared: Mapping[str, int],
) -> tuple[tuple[PackageFile, ...], str]:
    """The package's files and digest once every file has its declared size, its kind and its listed hash."""
    listed = manifest["integrity"]["files"]
    problems = []
    for path, found in sorted(measured.items()):
        if found.size != declared[path]:
            problems.append(
                issue(
                    "size_mismatch",
                    path=path,
                    declared=declared[path],
                    actual=found.size,
                )
            )
        elif not found.content_ok:
            problems.append(issue("content_mismatch", path=path))
        elif found.sha256 != listed[path]:
            problems.append(issue("integrity_mismatch", path=path))
    if problems:
        raise invalid(problems)
    files = tuple(
        PackageFile(path, found.size, found.sha256, media_type(path))
        for path, found in sorted(measured.items())
    )
    hashes = {
        MANIFEST_NAME: hashlib.sha256(manifest_data).hexdigest(),
        **{item.path: item.sha256 for item in files},
    }
    return files, package_digest(hashes)


def _write_file(root_fd: int, path: str, blocks: Iterator[bytes]) -> _Measured:
    fd = _open_at(root_fd, path, _CREATE_FLAGS)
    with os.fdopen(fd, "wb") as sink:
        measured = _measure(path, blocks, sink)
        sink.flush()
        os.fsync(sink.fileno())
    return measured


def _unpack(handle: BinaryIO, dest: Path, limits: PluginLimits) -> Package:
    declared, directory_offset = _check_layout(handle, limits)
    with _reading_archive():
        bundle = zipfile.ZipFile(handle)
    with bundle:
        entries = _archive_files(bundle, declared, directory_offset, limits)
        manifest_data = b"".join(_member_blocks(bundle, entries[MANIFEST_NAME]))
        if len(manifest_data) != entries[MANIFEST_NAME].file_size:
            raise invalid([issue("size_mismatch", path=MANIFEST_NAME)])
        manifest = parse_manifest(manifest_data, builtin=False)
        problems = _file_set_issues(manifest, set(entries))
        if problems:
            raise invalid(problems)
        root_fd = os.open(dest, os.O_RDONLY | os.O_DIRECTORY)
        try:
            _write_file(root_fd, MANIFEST_NAME, iter([manifest_data]))
            others = sorted(set(entries) - {MANIFEST_NAME})
            measured = {
                path: _write_file(root_fd, path, _member_blocks(bundle, entries[path]))
                for path in others
            }
        finally:
            os.close(root_fd)
    files, digest = _verified(
        manifest,
        manifest_data,
        measured,
        {path: entries[path].file_size for path in measured},
    )
    _fsync_tree(dest, [MANIFEST_NAME, *measured])
    manifest_sha256 = hashlib.sha256(manifest_data).hexdigest()
    return Package(dest, manifest, len(manifest_data), manifest_sha256, files, digest)


def unpack_archive(
    archive: Path, dest: Path, *, limits: PluginLimits = LIMITS
) -> Package:
    """Validate the uploaded archive and unpack it into the new directory ``dest`` (its parent must exist).

    Raises 422 ``STUDIO_PLUGIN_INVALID`` for anything the package rules refuse. On every failure ``dest`` is
    removed again, so a refused package leaves nothing behind.
    """
    try:
        dest.mkdir(mode=0o700)
    except OSError as exc:
        raise _io_error(exc, "無法建立插件的暫存目錄") from exc
    try:
        with archive.open("rb") as handle:
            return _unpack(handle, dest, limits)
    except OSError as exc:
        shutil.rmtree(dest, ignore_errors=True)
        raise _io_error(exc, "無法解開插件包") from exc
    except BaseException:
        shutil.rmtree(dest, ignore_errors=True)
        raise


# ---------------------------------------------------------------------------------------------- directories
class _Scan:
    """The regular files below a directory, found without following a link and within the entry limit."""

    def __init__(self, limits: PluginLimits, *, single_link: bool) -> None:
        self.sizes: dict[str, int] = {}
        self.problems: list[Issue] = []
        self._limits = limits
        self._single_link = single_link
        self._budget = limits.files  # files and directories together, as in an archive

    def directory(self, fd: int, prefix: str = "") -> None:
        with os.scandir(fd) as entries:
            for entry in entries:
                self._budget -= 1
                if self._budget < 0:
                    raise invalid([issue("too_many_files", limit=self._limits.files)])
                self._entry(fd, entry, f"{prefix}{entry.name}")

    def _entry(self, fd: int, entry: os.DirEntry[str], path: str) -> None:
        if not path_allowed(path, self._limits):
            self.problems.append(issue("path_not_allowed", path=_shown(path)))
        elif entry.is_dir(follow_symlinks=False):
            below = os.open(entry.name, _DIR_FLAGS, dir_fd=fd)
            try:
                self.directory(below, f"{path}/")
            finally:
                os.close(below)
        elif not entry.is_file(follow_symlinks=False):
            self.problems.append(issue("link_not_allowed", path=path))
        else:
            self._file(path, entry.stat(follow_symlinks=False))

    def _file(self, path: str, facts: os.stat_result) -> None:
        linked = self._single_link and facts.st_nlink != 1
        problem = (
            issue("link_not_allowed", path=path)
            if linked
            else _file_issue(path, facts.st_size, self._limits)
        )
        if problem is None:
            self.sizes[path] = facts.st_size
        else:
            self.problems.append(problem)


def _file_blocks(root_fd: int, path: str, limit: int) -> Iterator[bytes]:
    """A file's bytes in blocks, never more than ``limit`` plus one byte; only a regular file is read."""
    fd = _open_at(root_fd, path, _READ_FLAGS)
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise invalid([issue("link_not_allowed", path=path)])
        remaining = limit + 1
        while remaining > 0:
            block = source.read(min(BLOCK_BYTES, remaining))
            if not block:
                return
            remaining -= len(block)
            yield block


def _load(
    root: Path, root_fd: int, limits: PluginLimits, *, builtin: bool, linked: bool
) -> Package:
    scan = _Scan(limits, single_link=not linked)
    scan.directory(root_fd)
    sizes = scan.sizes
    problems = sorted(
        scan.problems, key=lambda item: (str(item["path"]), str(item["code"]))
    )
    names = _Names()
    problems += [
        issue("duplicate_path", path=path)
        for path in sorted(sizes)
        if not names.add(path, is_dir=False)
    ]
    if sum(sizes.values()) > limits.unpacked_bytes:
        problems.append(
            issue(
                "total_too_large", size=sum(sizes.values()), limit=limits.unpacked_bytes
            )
        )
    if MANIFEST_NAME not in sizes:
        problems.append(issue("manifest_missing", path=MANIFEST_NAME))
    if problems:
        raise invalid(problems)
    manifest_data = b"".join(_file_blocks(root_fd, MANIFEST_NAME, sizes[MANIFEST_NAME]))
    if (
        len(manifest_data) != sizes[MANIFEST_NAME]
    ):  # it changed while the directory was read
        raise invalid([issue("size_mismatch", path=MANIFEST_NAME)])
    manifest = parse_manifest(manifest_data, builtin=builtin)
    problems = _file_set_issues(manifest, set(sizes))
    if problems:
        raise invalid(problems)
    others = sorted(set(sizes) - {MANIFEST_NAME})
    measured = {
        path: _measure(path, _file_blocks(root_fd, path, sizes[path]))
        for path in others
    }
    files, digest = _verified(manifest, manifest_data, measured, sizes)
    return Package(
        root,
        manifest,
        len(manifest_data),
        hashlib.sha256(manifest_data).hexdigest(),
        files,
        digest,
    )


def load_directory(
    root: Path, *, builtin: bool, limits: PluginLimits = LIMITS, linked: bool = False
) -> Package:
    """Validate an unpacked package in place: a built-in package, a development directory or an installed one.

    The rules are those of :func:`unpack_archive`. A file with several hard links is refused in a development
    directory, where a link could bring in a file from elsewhere on the host. ``linked`` accepts such files: a
    built-in package (installers may link the host's own files) and an installed copy, which the Controller wrote
    itself and checks against the digest it recorded (a hard-link backup of the data directory must not turn every
    installed package invalid). Raises 422 ``STUDIO_PLUGIN_INVALID``.
    """
    try:
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    except OSError as exc:
        raise invalid(
            [issue("file_unreadable", reason=exception_message(exc))]
        ) from exc
    try:
        return _load(root, root_fd, limits, builtin=builtin, linked=linked or builtin)
    except OSError as exc:
        raise invalid(
            [issue("file_unreadable", reason=exception_message(exc))]
        ) from exc
    finally:
        os.close(root_fd)


# ---------------------------------------------------------------------------------------------- export
def _read_verified(package: Package, path: str, size: int, sha256: str) -> bytes:
    with open_file(package.root, path) as source:
        data = source.read(size + 1)
    if len(data) != size or hashlib.sha256(data).hexdigest() != sha256:
        raise ComponentError(
            "STATE_CONFLICT", "插件包的內容在載入之後被改動；請重新載入或重新安裝"
        )
    return data


def read_file(package: Package, item: PackageFile) -> bytes:
    """The bytes of one listed file, only while they still are the bytes that were validated."""
    return _read_verified(package, item.path, item.size, item.sha256)


def _deflated(data: bytes, step: int | None = None) -> bytes:
    """Raw deflate at the best level; with ``step``, flushed after every ``step`` bytes of the data."""
    packer = zlib.compressobj(zlib.Z_BEST_COMPRESSION, zlib.DEFLATED, -zlib.MAX_WBITS)
    if step is None:
        return packer.compress(data) + packer.flush()
    parts = [
        packer.compress(data[start : start + step]) + packer.flush(zlib.Z_SYNC_FLUSH)
        for start in range(0, len(data), step)
    ]
    return b"".join(parts) + packer.flush()


def _packed(data: bytes, limits: PluginLimits) -> tuple[int, bytes]:
    """How a file goes into an export: the method and the bytes to store.

    Deflated, or stored when deflate gains nothing. A file that deflate would make more than ``compression_ratio``
    times smaller is deflated with a flush after every ``2 * compression_ratio`` bytes: each flush costs at least
    four bytes, which keeps the entry within the ratio the package rules accept on the way back in.
    """
    packed = _deflated(data)
    if len(data) > limits.compression_ratio * max(len(packed), 1):
        packed = _deflated(data, 2 * limits.compression_ratio)
    if len(packed) >= len(data):
        return zipfile.ZIP_STORED, data
    return zipfile.ZIP_DEFLATED, packed


def write_archive(
    package: Package, target: IO[bytes], *, limits: PluginLimits = LIMITS
) -> None:
    """Pack a loaded package as a ``.phasynplugin`` archive: ``plugin.json`` first, then the files by path, with fixed timestamps and modes. Each file is read again and must still have its validated size and hash.

    The archive is written here, not by zipfile: its writer cannot keep a very compressible file within the
    compression ratio (it could only store such a file, which makes an export many times larger than the upload).
    """
    members = [(MANIFEST_NAME, package.manifest_size, package.manifest_sha256)]
    members += [(item.path, item.size, item.sha256) for item in package.files]
    directory = bytearray()
    offset = 0
    for path, size, sha256 in members:
        data = _read_verified(package, path, size, sha256)
        method, packed = _packed(data, limits)
        name = path.encode("ascii")
        crc = zlib.crc32(data)
        fields = (
            0,
            method,
            _EXPORT_DOS_TIME,
            _EXPORT_DOS_DATE,
            crc,
            len(packed),
            len(data),
            len(name),
            0,
        )
        target.write(
            _LOCAL_HEADER.pack(_LOCAL_SIGNATURE, _EXPORT_VERSION, *fields) + name
        )
        target.write(packed)
        directory += _DIRECTORY_RECORD.pack(
            _DIRECTORY_SIGNATURE,
            _EXPORT_MADE_BY,
            _EXPORT_VERSION,
            *fields,
            0,
            0,
            0,
            _EXPORT_MODE,
            offset,
        )
        directory += name
        offset += _LOCAL_HEADER.size + len(name) + len(packed)
    target.write(directory)
    target.write(
        _END_RECORD.pack(
            _END_SIGNATURE, 0, 0, len(members), len(members), len(directory), offset, 0
        )
    )


__all__ = [
    "IMAGE_TYPES",
    "OCTET_STREAM",
    "PACKAGE_SUFFIX",
    "Package",
    "PackageFile",
    "archive_name",
    "kind_allowed",
    "load_directory",
    "media_type",
    "open_file",
    "package_digest",
    "path_allowed",
    "read_file",
    "size_limit",
    "unpack_archive",
    "write_archive",
]
