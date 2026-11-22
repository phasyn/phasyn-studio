"""A Node-local, bounded LRU for complete encoder bundles. One writer per component directory."""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import stat
import struct
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from phasyn_components.provider import RunContext

from .bundle import (
    BUNDLE_MEDIA_TYPE,
    BUNDLE_SCHEMA,
    MAX_BUNDLE_DOC_BYTES,
    PAYLOAD_MEDIA_TYPE,
)


_HEADER = struct.Struct(">8s32sQQQ32s")
_MAGIC = b"QENCv001"
_NAME = re.compile(r"[a-f0-9]{64}\.enc")
_TEMP = re.compile(r"[a-f0-9]{32}\.part")
_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
_READ = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
MAX_ENTRY = 64 << 20
MAX_ENTRIES = 4096


@contextlib.contextmanager
def directory(path: Path) -> Iterator[int]:
    """Open each directory relative to its parent without traversing symlinks."""
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("expected absolute local directory")
    fd = os.open("/", _DIR)
    try:
        for part in path.parts[1:]:
            child = os.open(part, _DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def regular(fd: int, name: str) -> Iterator[BinaryIO]:
    """Open a single regular file relative to a verified directory descriptor."""
    with os.fdopen(os.open(name, _READ, dir_fd=fd), "rb") as src:
        s = os.fstat(src.fileno())
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
            raise ValueError("expected single-link regular file")
        yield src


@contextlib.contextmanager
def locked(data: Path, component: str, check: Callable[[], None]) -> Iterator[int]:
    """Lock the component cache while allowing cancellation of lock acquisition."""
    name = "qimg-encode-cache-" + hashlib.sha256(component.encode()).hexdigest()[:24]
    with directory(data) as parent:
        with contextlib.suppress(FileExistsError):
            os.mkdir(name, 0o700, dir_fd=parent)
        fd = os.open(name, _DIR, dir_fd=parent)
    try:
        s = os.fstat(fd)
        if s.st_uid != os.geteuid() or s.st_mode & 0o077:
            raise ValueError("cache directory ownership or permissions")
        while True:
            check()
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.05)
        yield fd
    finally:
        os.close(fd)


@dataclass(frozen=True)
class Encoded:
    """Store the two immutable parts of an encoder output with its compute time."""

    main: bytes
    payload: bytes
    compute_ns: int

    @property
    def size(self) -> int:
        """Return the total serialized entry size, including its header."""
        return len(self.main) + len(self.payload) + _HEADER.size

    def checksum(self, key: bytes) -> bytes:
        """Bind the encoded content, lengths and timing to the cache key."""
        h = hashlib.sha256(
            key
            + struct.pack(">QQQ", self.compute_ns, len(self.main), len(self.payload))
        )
        h.update(self.main)
        h.update(self.payload)
        return h.digest()


def lookup(fd: int, key: str, budget: int, kind: str) -> Encoded | None:
    """Read and verify a complete cache entry for the requested bundle type."""
    try:
        with regular(fd, key + ".enc") as handle:
            size = os.fstat(handle.fileno()).st_size
            if not _HEADER.size <= size <= min(MAX_ENTRY, budget):
                return None
            entry = _read_entry(handle, key, size)
            if entry is None:
                return None
            if not _valid_payload(entry, kind, len(entry.payload)):
                return None
            os.utime(handle.fileno())
            return entry
    except (FileNotFoundError, ValueError):
        return None


def _read_entry(handle: BinaryIO, key: str, size: int) -> Encoded | None:
    header = handle.read(_HEADER.size)
    if len(header) != _HEADER.size:
        return None
    magic, key_bytes, ns, n, m, checksum = _HEADER.unpack(header)
    if (
        magic != _MAGIC
        or key_bytes != bytes.fromhex(key)
        or not 0 < n <= MAX_BUNDLE_DOC_BYTES
        or size != _HEADER.size + n + m
    ):
        return None
    entry = Encoded(handle.read(n), handle.read(m), ns)
    if entry.size != size or entry.checksum(key_bytes) != checksum:
        return None
    return entry


def _valid_payload(entry: Encoded, kind: str, payload_size: int) -> bool:
    doc = json.loads(entry.main)
    if (
        not isinstance(doc, dict)
        or doc.get("kind") != kind
        or doc.get("schema") != BUNDLE_SCHEMA
    ):
        return False
    payload = doc.get("payload")
    return (
        isinstance(payload, dict)
        and payload.get("media_type") == PAYLOAD_MEDIA_TYPE
        and payload.get("size_bytes") == payload_size
        and payload.get("sha256") == hashlib.sha256(entry.payload).hexdigest()
    )


def _evict(fd: int, budget: int, incoming: int) -> None:
    entries = []
    for name in os.listdir(fd):
        if not (_NAME.fullmatch(name) or _TEMP.fullmatch(name)):
            continue
        s = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
            continue
        if _TEMP.fullmatch(name):
            os.unlink(name, dir_fd=fd)
        else:
            entries.append((s.st_mtime_ns, name, s.st_size))
    total = sum(size for _, _, size in entries) + incoming
    count = len(entries) + int(bool(incoming))
    for _, name, size in sorted(entries):
        if total <= budget and count <= MAX_ENTRIES:
            break
        os.unlink(name, dir_fd=fd)
        total -= size
        count -= 1


def trim(fd: int, budget: int) -> None:
    """Evict stale or over-budget entries before attempting a lookup."""
    _evict(fd, budget, 0)


def store(fd: int, key: str, entry: Encoded, budget: int) -> None:
    """Publish a complete cache entry through an atomic replacement."""
    _evict(fd, budget, entry.size)
    tmp = uuid.uuid4().hex + ".part"
    key_bytes = bytes.fromhex(key)
    flags = os.O_WRONLY | os.O_EXCL | os.O_CREAT | os.O_NOFOLLOW
    with os.fdopen(os.open(tmp, flags, 0o600, dir_fd=fd), "wb") as dst:
        try:
            dst.write(
                _HEADER.pack(
                    _MAGIC,
                    key_bytes,
                    entry.compute_ns,
                    len(entry.main),
                    len(entry.payload),
                    entry.checksum(key_bytes),
                )
            )
            dst.write(entry.main)
            dst.write(entry.payload)
            dst.flush()
            os.fsync(dst.fileno())
            os.replace(tmp, key + ".enc", src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(tmp, dir_fd=fd)


def capture(ctx: RunContext, port: str, compute_ns: int, budget: int) -> Encoded | None:
    """Read the finished encoder outputs into a bounded cache entry."""
    files = ctx.pending_files()
    main = next(
        (f for f in files if f.port == port and f.media_type == BUNDLE_MEDIA_TYPE), None
    )
    payload = next((f for f in files if f.media_type == PAYLOAD_MEDIA_TYPE), None)
    if main is None or payload is None or not (main.finished and payload.finished):
        return None
    if (
        main.size + payload.size + _HEADER.size > min(MAX_ENTRY, budget)
        or main.size > MAX_BUNDLE_DOC_BYTES
    ):
        return None
    parts = []
    for file in (main, payload):
        with directory(file.path.parent) as fd, regular(fd, file.path.name) as src:
            b = src.read(file.size + 1)
        if len(b) != file.size or hashlib.sha256(b).hexdigest() != file.sha256:
            return None
        parts.append(b)
    return Encoded(parts[0], parts[1], compute_ns)


def publish(ctx: RunContext, port: str, kind: str, entry: Encoded) -> None:
    """Allocate fresh FileRefs; cached bytes never contain a Node-private location."""
    ctx.check_cancelled()
    payload = ctx.new_file(
        None,
        PAYLOAD_MEDIA_TYPE,
        {"role": f"{kind}.payload", "kind": kind},
        type_id="file.attachment.v1",
    )
    payload.write(entry.payload)
    payload.finish()
    main = ctx.new_file(
        port,
        BUNDLE_MEDIA_TYPE,
        {
            "kind": kind,
            "schema": BUNDLE_SCHEMA,
            "payload_sha256": payload.sha256,
            "links": {"payload": ctx.file_ref(payload)},
        },
    )
    main.write(entry.main)
    ctx.set_file_output(port, main)
