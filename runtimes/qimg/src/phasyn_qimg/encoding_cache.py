"""Content-addressed Qwen pre-encoding. The opt-in cache only covers the two deterministic encoder ports."""

from __future__ import annotations

import contextlib
import hashlib
import os
import platform
import stat
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.provider import LoadContext, LoadResult, ProviderHost, RunContext

from . import KIND_CONDITIONING, KIND_REF_LATENTS
from .config import MODEL_SUBDIRS, model_dir, resolve_params
from .encoding_store import (
    capture,
    directory,
    locked,
    lookup,
    publish,
    regular,
    store,
    trim,
)
from .weights import image_set


_PORTS = {
    "conditioning": ("conditioning", KIND_CONDITIONING),
    "vae_encode": ("ref_latents", KIND_REF_LATENTS),
}
_SIGNATURE_SOURCES = (
    "__init__.py",
    "bundle.py",
    "config.py",
    "imaging.py",
    "instrument.py",
    "latents.py",
)
_DIGEST_CHUNK = 2 << 20
type Stamps = dict[str, tuple[int, int, int, int, int]]


def _stamp(s: os.stat_result) -> tuple[int, int, int, int, int]:
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        raise ValueError("unexpected model file")
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def _inventory(base: Path, role: str) -> Stamps:
    expected = {f.path for f in image_set().files}
    files = {}
    for folder in MODEL_SUBDIRS[role]:
        with directory(base / folder) as fd:
            with os.scandir(fd) as entries:
                names = [entry.name for entry in entries]
            if not names or {folder + "/" + n for n in names} != {
                f for f in expected if f.startswith(folder + "/")
            }:
                raise ValueError("unrecognized model layout")
            for name in names:
                files[folder + "/" + name] = _stamp(
                    os.stat(name, dir_fd=fd, follow_symlinks=False)
                )
    return files


def _content_hash(file: BinaryIO) -> str:
    content = hashlib.sha256()
    while chunk := file.read(_DIGEST_CHUNK):
        content.update(chunk)
    return content.hexdigest()


def _model_hash(base: Path, role: str, before: Stamps) -> str:
    hashes = {}
    for name, previous in before.items():
        path = base / name
        with directory(path.parent) as fd, regular(fd, path.name) as file:
            if _stamp(os.fstat(file.fileno())) != previous:
                raise ValueError("model changed during load")
            hashes[name] = _content_hash(file)
    if _inventory(base, role) != before:
        raise ValueError("model changed during verification")
    return digest(hashes)


def _source_hash(role: str) -> str:
    names = (
        *_SIGNATURE_SOURCES,
        "conditioning.py" if role == "conditioning" else "vae.py",
    )
    with directory(Path(__file__).parent) as fd:
        result = {}
        for name in names:
            with regular(fd, name) as f:
                result[name] = _content_hash(f)
    return digest(result)


@dataclass(frozen=True)
class EncoderCache:
    """Identify one verified encoder and its Node-local cache budget."""

    role: str
    model_sha256: str
    namespace: str
    budget: int
    host: ProviderHost


def configure(
    host: ProviderHost,
    role: str,
    ctx: LoadContext,
    load: Callable[[LoadContext], LoadResult],
) -> tuple[EncoderCache | None, LoadResult]:
    """Bind the cache namespace to the verified encoder and its execution settings."""
    budget = (
        int((ctx.load.get("provider_options") or {}).get("encoding_cache_mib", 0)) << 20
    )
    if not budget:
        return None, load(ctx)
    base = model_dir(ctx.load)
    start = time.perf_counter_ns()
    try:
        before = _inventory(base, role)
        before_digest = _model_hash(base, role, before)
    except (OSError, ValueError):
        before = {}
        before_digest = None
    result = load(ctx)
    if not before:
        result.observed["encoding_cache"] = {"enabled": False, "reason": "ValueError"}
        return None, result
    try:
        identity = _model_hash(base, role, before)
        if identity != before_digest:
            result.observed["encoding_cache"] = {
                "enabled": False,
                "reason": "model_contents_changed_during_load",
            }
            return None, result
        import torch

        settings = {
            k: v
            for k, v in result.effective_load.items()
            if k not in {"model_path", "provider_options"}
        }
        numerical = {
            "role": role,
            "version": 1,
            "model": identity,
            "source": _source_hash(role),
            "identity": result.model_identity,
            "libraries": result.observed.get("libraries"),
            "diffusers_source": result.observed.get("diffusers_source"),
            "load": settings,
            "runtime": result.runtime_identity,
            "backend": result.observed.get("backend_flags"),
            "cpu_arch": platform.machine(),
            "cpu_capability": torch.backends.cpu.get_cpu_capability(),
            "cpu_threads": torch.get_num_threads(),
            "deterministic": torch.are_deterministic_algorithms_enabled(),
        }
        cache = EncoderCache(role, identity, digest(numerical), budget, host)
    except (OSError, ValueError) as error:
        result.observed["encoding_cache"] = {
            "enabled": False,
            "reason": type(error).__name__,
        }
        return None, result
    result.observed["encoding_cache"] = {
        "enabled": True,
        "limit_bytes": budget,
        "model_content_sha256": identity,
        "namespace_sha256": cache.namespace,
        "load_and_verify_ms": (time.perf_counter_ns() - start) / 1e6,
    }
    return cache, result


def _input_hash(path: Path, ref: dict[str, Any], ctx: RunContext) -> tuple[str, int]:
    with directory(path.parent) as fd, regular(fd, path.name) as src:
        h = hashlib.sha256()
        total = 0
        while chunk := src.read(_DIGEST_CHUNK):
            ctx.check_cancelled()
            h.update(chunk)
            total += len(chunk)
    sha = h.hexdigest()
    if total != ref.get("size_bytes") or sha != ref.get("sha256"):
        raise ComponentError("FILE_HASH_MISMATCH", "前置編碼輸入內容與 FileRef 不符")
    return sha, total


def _key(cache: EncoderCache, ctx: RunContext) -> tuple[str, int]:
    inputs: dict[str, Any] = {}
    verified_bytes = 0
    for name, item in ctx.inputs.items():
        if item.file is None:
            inputs[name] = {"type": item.type_id, "value": item.value}
        else:
            sha, n = _input_hash(item.require_path(name), item.file, ctx)
            verified_bytes += n
            links = {}
            for link_name, (ref, path) in item.links.items():
                link_sha, n = _input_hash(path, ref, ctx)
                verified_bytes += n
                links[link_name] = link_sha
            inputs[name] = {
                "type": item.type_id,
                "media_type": item.file.get("media_type"),
                "kind": (item.file.get("metadata") or {}).get("kind"),
                "sha256": sha,
                "links": links,
            }
    return digest(
        {
            "namespace": cache.namespace,
            "inputs": inputs,
            "parameters": resolve_params(cache.role, ctx.parameters),
        }
    ), verified_bytes


def invoke(
    cache: EncoderCache | None, ctx: RunContext, compute: Callable[[RunContext], None]
) -> None:
    """Restore a complete bundle or compute and publish the encoder output."""
    if cache is None:
        compute(ctx)
        return
    start = time.perf_counter_ns()
    ctx.check_cancelled()
    port, kind = _PORTS[cache.role]
    with contextlib.ExitStack() as stack:
        try:
            key, verified = _key(cache, ctx)
            fd = stack.enter_context(
                locked(
                    cache.host.data_dir, cache.host.component_id, ctx.check_cancelled
                )
            )
            trim(fd, cache.budget)
            entry = lookup(fd, key, cache.budget, kind)
        except (ValueError, OSError) as error:
            ctx.log(
                "info",
                "Qwen encoding cache",
                code="QIMG_ENCODING_CACHE",
                status="bypass",
                reason=type(error).__name__,
            )
            compute(ctx)
            return
        lookup_ms = (time.perf_counter_ns() - start) / 1e6
        fields = {
            "code": "QIMG_ENCODING_CACHE",
            "key_sha256": key,
            "model_content_sha256": cache.model_sha256,
            "verified_input_bytes": verified,
            "lookup_ms": lookup_ms,
        }
        if entry is not None:
            publish(ctx, port, kind, entry)
            ctx.log(
                "info",
                "Qwen encoding cache",
                **fields,
                status="hit",
                cached_bytes=entry.size,
                previous_compute_ms=entry.compute_ns / 1e6,
                restore_ms=(time.perf_counter_ns() - start) / 1e6 - lookup_ms,
            )
            return
        begin_compute = time.perf_counter_ns()
        compute(ctx)
        ns = time.perf_counter_ns() - begin_compute
        ctx.check_cancelled()
        begin_store = time.perf_counter_ns()
        status = "uncached"
        nbytes = 0
        try:
            entry = capture(ctx, port, ns, cache.budget)
            if entry is not None:
                store(fd, key, entry, cache.budget)
                nbytes = entry.size
                status = "miss"
        except (ValueError, OSError):
            pass
        ctx.log(
            "info",
            "Qwen encoding cache",
            **fields,
            status=status,
            cached_bytes=nbytes,
            compute_ms=ns / 1e6,
            store_ms=(time.perf_counter_ns() - begin_store) / 1e6,
        )
