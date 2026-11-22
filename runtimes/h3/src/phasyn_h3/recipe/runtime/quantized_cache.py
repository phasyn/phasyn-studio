"""Opt-in cache of the convrot_int8 DiT as built (``provider_options.quantized_cache``, off by default).

An ``int8_convrot`` load reads the 37.4 GiB BF16 checkpoint and quantizes every selected linear on the
device (``ConvRotInt8JitLinearMethod.process_weights_after_loading``, convrot_int8_jit.py:228-248). With
the cache on, the first load saves the model state as it stands right after
``process_model_weights_after_loading`` (INT8 weights + FP32 row scales of the quantized linears, every
other tensor as loaded, BF16 for the excluded modules) to ``<dir>/<key>/weights.safetensors`` with a
``manifest.json`` beside it. A later load with the same key hands those tensors to the unchanged upstream
``load_model_from_full_model_state_dict`` as a pre-converted state dict, after re-declaring each
quantized linear's ``weight`` as INT8 and its ``weight_scale`` on the meta device: the loader assigns
them, the unchanged post-processing sees INT8 weights and skips the quantization
(``elif weight.dtype != torch.int8``), and ``post_load_weights`` runs as before. The BF16 shards are
never read on a hit.

Key = sha256 of the canonical JSON of: this format and its version, the checkpoint identity (index
sha256; per shard size, mtime, inode, device, header sha256 and the LFS sha256 the bundled weight
manifest records), the quantization plan (scheme, group size, backend, ignored/excluded modules) and
``load_signature`` (AdaLN mode), the pinned upstream sources, the SGLang revision, torch/CUDA/arch/compute
capability, and the load facts only known inside the loader (model class, parameter dtype, checkpoint
device, cpu offload, the meta model's names/shapes/dtypes). Any difference is a miss. A hit is checked
again before anything is read: manifest key == recomputed key, file sizes, header sha256, tensor table
against the meta model. A manifest or data file that fails a check, or a read that fails half way, is
logged and ignored: the load continues as a fresh quantization (and rewrites nothing in place: a new
entry is written only under a new key). Writes go to a temporary directory that is renamed into place.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib
import inspect
import itertools
import json
import logging
import os
import shutil
import stat
import struct
import tempfile
import threading
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NamedTuple, TypedDict, Unpack

from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.abi.tensors import read_header_from_file
from phasyn_h3.recipe.adapter.constants import SGLANG_REVISION

from . import pins
from ._arguments import validate_keywords
from ._observations import RuntimeObservation
from .accel_load import load_signature
from .acceleration import quant_plan
from .errors import UnsupportedCombination


class _CacheDescription(TypedDict):
    header: bytes
    data_size: int
    tensors: int
    strides: Mapping[str, Sequence[int]]
    quantized_layers: Sequence[str]
    reverse_mapping: Mapping[str, Any] | None


class _CachePublicationRequired(TypedDict):
    quantized_layers: Sequence[str]
    reverse_mapping: Mapping[str, Any] | None


class _CachePublication(_CachePublicationRequired, total=False):
    replace_invalid: bool


_ST_HEADER_SIZE = 8


LOG = logging.getLogger(__name__)

ENV_DIR = "PHASYN_H3_QUANTIZED_CACHE_DIR"
FORMAT = "phasyn_h3.convrot_int8_quantized_cache"
# Bump with any change to what is saved, how it is laid out or how a hit is put back.
FORMAT_VERSION = 1
PIN_GROUP = "quantized_cache"
DATA_FILE = "weights.safetensors"
MANIFEST_FILE = "manifest.json"
CONVROT_METHOD = "ConvRotInt8JitLinearMethod"
MODEL_CLASS = "MiniMaxH3DiTModel"
MAX_HEADER_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_INDEX_BYTES = 16 * 1024 * 1024
FREE_SPACE_MARGIN = 1 << 30
DTYPE_BYTES: Mapping[str, int] = {
    "BOOL": 1,
    "U8": 1,
    "I8": 1,
    "F8_E4M3": 1,
    "F8_E5M2": 1,
    "I16": 2,
    "F16": 2,
    "BF16": 2,
    "I32": 4,
    "F32": 4,
    "I64": 8,
    "F64": 8,
}
_BUNDLED_WEIGHTS = (
    Path(__file__).resolve().parents[2] / "weight_manifests" / "minimax-h3.json"
)
_LOCK = threading.RLock()


class CacheInvalidError(Exception):
    """A cache entry that must not be used (logged; the load quantizes afresh)."""


CacheInvalidError.__name__ = "CacheInvalid"
CacheInvalidError.__qualname__ = "CacheInvalid"
CacheInvalid = CacheInvalidError


# ------------------------------------------------------------------------------------------- key parts


def configured_root(environ: Mapping[str, str] | None = None) -> Path | None:
    """Resolve the configured quantized-weight cache directory."""
    raw = (os.environ if environ is None else environ).get(ENV_DIR, "")
    return Path(raw) if raw else None


def _read_bounded(path: Path, limit: int) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise CacheInvalid(f"{path.name}: not a regular file within {limit} bytes")
        data = handle.read(limit + 1)
    if len(data) != info.st_size:
        raise CacheInvalid(f"{path.name} changed while it was read")
    return data


def _recorded_sha256() -> dict[tuple[str, int], str]:
    """``(variant/transformer/<file>, size) -> LFS sha256`` from the bundled weight manifest (absent: empty)."""
    try:
        document = json.loads(_BUNDLED_WEIGHTS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out: dict[tuple[str, int], str] = {}
    for entry in document.get("files") or []:
        sha, path, size = entry.get("sha256"), entry.get("path"), entry.get("size")
        if isinstance(sha, str) and isinstance(path, str) and isinstance(size, int):
            out[(path, size)] = sha
    return out


def source_identity(directory: Path) -> dict[str, Any]:
    """What identifies the BF16 checkpoint without reading its 37 GiB (header bytes + file identity)."""
    index = directory / "model.safetensors.index.json"
    index_bytes = _read_bounded(index, MAX_INDEX_BYTES)
    weight_map = json.loads(index_bytes).get("weight_map")
    if not isinstance(weight_map, dict) or not weight_map:
        raise CacheInvalid("checkpoint index has no weight_map")
    recorded = _recorded_sha256()
    shards = []
    for name in sorted({str(v) for v in weight_map.values()}):
        path = directory / name
        if Path(name).name != name or path.suffix != ".safetensors":
            raise CacheInvalid(f"checkpoint shard outside its directory: {name}")
        info = Path(path).lstat()
        if not stat.S_ISREG(info.st_mode):
            raise CacheInvalid(f"checkpoint shard is not a regular file: {name}")
        header = read_header_from_file(path)
        with path.open("rb") as handle:
            header_sha = hashlib.sha256(handle.read(header.data_offset)).hexdigest()
        relative = f"{directory.parent.name}/{directory.name}/{name}"
        shards.append(
            {
                "name": name,
                "size": info.st_size,
                "mtime_ns": info.st_mtime_ns,
                "inode": info.st_ino,
                "device": info.st_dev,
                "header_sha256": header_sha,
                "recorded_sha256": recorded.get((relative, info.st_size)),
            }
        )
    return {"index_sha256": hashlib.sha256(index_bytes).hexdigest(), "shards": shards}


def cache_key(parts: Mapping[str, Any]) -> str:
    """Build the identity for compatible cached weights."""
    return canonical_digest(
        {"format": FORMAT, "format_version": FORMAT_VERSION, **parts}
    )


# ----------------------------------------------------------------------------- safetensors (stdlib side)


@dataclass(frozen=True)
class TensorEntry:
    name: str
    dtype: str
    shape: tuple[int, ...]
    begin: int  # offset inside the data section
    end: int
    stride: tuple[int, ...] | None  # None: row-major contiguous


@dataclass(frozen=True)
class CacheEntry:
    """Locate an existing set of quantized weight files."""

    directory: Path
    key: str
    manifest: Mapping[str, Any]
    data_offset: int  # absolute offset of the data section in DATA_FILE
    tensors: tuple[TensorEntry, ...]

    @property
    def quantized_layers(self) -> tuple[str, ...]:
        """Return the layers stored in the quantized cache."""
        return tuple(self.manifest["quantized_layers"])

    @property
    def data_path(self) -> Path:
        """Locate the cached weight payload."""
        return self.directory / DATA_FILE


def _numel(shape: Sequence[int]) -> int:
    n = 1
    for d in shape:
        n *= int(d)
    return n


def build_header(
    specs: Sequence[tuple[str, str, Sequence[int]]], metadata: Mapping[str, str]
) -> bytes:
    """Safetensors header for ``(name, dtype, shape)`` in order, data packed back to back (8-byte padded)."""
    table: dict[str, Any] = {"__metadata__": dict(metadata)}
    offset = 0
    for name, dtype, shape in specs:
        size = _numel(shape) * DTYPE_BYTES[dtype]
        table[name] = {
            "dtype": dtype,
            "shape": [int(d) for d in shape],
            "data_offsets": [offset, offset + size],
        }
        offset += size
    raw = json.dumps(table, separators=(",", ":"), sort_keys=False).encode("utf-8")
    raw += b" " * (-len(raw) % 8)
    return struct.pack("<Q", len(raw)) + raw


def parse_header(data: bytes, file_size: int) -> tuple[int, list[TensorEntry]]:
    """``(data_offset, tensors)``; raises :class:`CacheInvalid` unless the table exactly tiles the file."""
    if len(data) < _ST_HEADER_SIZE:
        raise CacheInvalid("data file shorter than its header length")
    (length,) = struct.unpack("<Q", data[:8])
    if length > MAX_HEADER_BYTES or 8 + length > len(data):
        raise CacheInvalid("header length out of bounds")
    try:
        table = json.loads(data[8 : 8 + length])
    except ValueError as exc:
        raise CacheInvalid(f"header is not JSON: {exc}") from None
    if not isinstance(table, dict):
        raise CacheInvalid("header is not an object")
    table.pop("__metadata__", None)
    entries = []
    for name, info in table.items():
        entries.append(_header_tensor(name, info))
    entries.sort(key=lambda e: e.begin)
    cursor = 0
    for entry in entries:
        if entry.begin != cursor:
            raise CacheInvalid(f"data section has a gap or overlap at {entry.name}")
        cursor = entry.end
    if 8 + length + cursor != file_size:
        raise CacheInvalid(
            f"data file size {file_size} != header {8 + length + cursor}"
        )
    return 8 + length, entries


def make_manifest(
    key: str, parts: Mapping[str, Any], **arguments: Unpack[_CacheDescription]
) -> dict[str, Any]:
    """The ``manifest.json`` written next to the data: the key, the parts it is the digest of, the sizes."""
    validate_keywords(arguments, _CacheDescription)
    header = arguments["header"]
    data_size = arguments["data_size"]
    tensors = arguments["tensors"]
    strides = arguments["strides"]
    quantized_layers = arguments["quantized_layers"]
    reverse_mapping = arguments["reverse_mapping"]
    return {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "key": key,
        "parts": dict(parts),
        "data_file": DATA_FILE,
        "data_size": data_size,
        "header_sha256": hashlib.sha256(header).hexdigest(),
        "tensors": tensors,
        "strides": {name: list(stride) for name, stride in strides.items()},
        "quantized_layers": list(quantized_layers),
        "reverse_param_names_mapping": None
        if reverse_mapping is None
        else dict(reverse_mapping),
        "created_unix": int(time.time()),
    }


def _entry_dir(root: Path, key: str) -> Path:
    return root / key


def _check_root(root: Path) -> None:
    if not root.is_absolute() or os.path.realpath(root) != str(root):
        raise CacheInvalid("cache dir must be an absolute path without symlinks")


def lookup(root: Path, key: str) -> tuple[CacheEntry | None, str]:
    """The verified entry for ``key`` or ``(None, reason)``. Never trusts anything it cannot check."""
    directory = _entry_dir(root, key)
    try:
        _check_root(root)
        info = Path(directory).lstat()
    except FileNotFoundError:
        return None, "miss: no entry"
    except (OSError, CacheInvalid) as exc:
        return None, f"invalid: {exc}"
    try:
        manifest = _read_entry_manifest(directory, key, info)
        data_offset, entries = _read_entry_header(directory, manifest)
        strides = manifest.get("strides") or {}
        tensors = tuple(
            TensorEntry(
                e.name,
                e.dtype,
                e.shape,
                e.begin,
                e.end,
                tuple(strides[e.name]) if e.name in strides else None,
            )
            for e in entries
        )
        _check_entry_layers(manifest)
        return CacheEntry(directory, key, manifest, data_offset, tensors), "hit"
    except (OSError, ValueError, CacheInvalid) as exc:
        return None, f"invalid: {exc}"


# ------------------------------------------------------------------------------------ torch side (lazy)

_TORCH_DTYPES = {
    "BOOL": "bool",
    "U8": "uint8",
    "I8": "int8",
    "F8_E4M3": "float8_e4m3fn",
    "F8_E5M2": "float8_e5m2",
    "I16": "int16",
    "F16": "float16",
    "BF16": "bfloat16",
    "I32": "int32",
    "F32": "float32",
    "I64": "int64",
    "F64": "float64",
}


def _torch_dtype(code: str) -> Any:
    import torch

    return getattr(torch, _TORCH_DTYPES[code])


def _dtype_code(dtype: Any) -> str:
    name = str(dtype).removeprefix("torch.")
    for code, torch_name in _TORCH_DTYPES.items():
        if torch_name == name:
            return code
    raise CacheInvalid(f"dtype {dtype} has no safetensors code")


def _byte_view(tensor: Any) -> Any:
    """A writable/readable uint8 numpy view of a contiguous CPU tensor (no copy)."""
    import torch

    return tensor.reshape(-1).view(torch.uint8).numpy()


def _write_all(fd: int, view: memoryview) -> None:
    while view:
        written = os.write(fd, view)
        view = view[written:]


def _read_into(fd: int, view: memoryview) -> None:
    while view:
        got = os.readv(fd, [view])
        if got <= 0:
            raise CacheInvalid("data file ended early")
        view = view[got:]


def _contiguous_strides(shape: Sequence[int]) -> tuple[int, ...]:
    out: list[int] = []
    acc = 1
    for d in reversed(shape):
        out.append(acc)
        acc *= max(int(d), 1)
    return tuple(reversed(out))


def _dense(shape: Sequence[int], stride: Sequence[int]) -> bool:
    """Whether the strides are a permutation of a row-major layout (no gaps, no overlap)."""
    expected = 1
    for size, step in sorted(
        ((int(n), int(s)) for n, s in zip(shape, stride, strict=True) if n != 1),
        key=lambda x: x[1],
    ):
        if step != expected:
            return False
        expected *= size
    return True


def capture_items(model: Any) -> list[tuple[str, Any]]:
    """The model state to save, refused when two entries share memory (a hit would not restore aliasing)."""
    items = list(model.state_dict(keep_vars=True).items())
    spans = sorted(
        (str(t.device), t.data_ptr(), t.data_ptr() + t.numel() * t.element_size(), name)
        for name, t in items
        if t.numel()
    )
    for (dev_a, _b, end_a, name_a), (dev_b, begin_b, _e, name_b) in itertools.pairwise(
        spans
    ):
        if dev_a == dev_b and begin_b < end_a:
            raise CacheInvalid(f"aliased tensors cannot be cached: {name_a}, {name_b}")
    for name, tensor in items:
        if tensor.device.type == "meta":
            raise CacheInvalid(f"meta tensor after post-processing: {name}")
        if not _dense(tensor.shape, tensor.stride()):
            raise CacheInvalid(f"tensor layout cannot be restored: {name}")
    return items


def write_entry(
    root: Path,
    key: str,
    parts: Mapping[str, Any],
    items: Sequence[tuple[str, Any]],
    **arguments: Unpack[_CachePublication],
) -> dict[str, Any]:
    """Stream ``items`` (name, tensor) to ``<root>/<key>``: one tensor host copy at a time, atomic rename.

    ``replace_invalid``: the entry under ``key`` failed its checks; it is moved aside and removed first.
    """
    validate_keywords(arguments, _CachePublication)
    quantized_layers = arguments["quantized_layers"]
    reverse_mapping = arguments["reverse_mapping"]
    replace_invalid = arguments.get("replace_invalid", False)
    _check_root(root)
    final = _entry_dir(root, key)
    if os.path.lexists(final):
        if not replace_invalid:
            return {"written": False, "reason": "entry exists"}
        aside = root / f".invalid-{key[:16]}-{os.getpid()}-{time.time_ns()}"
        final.rename(aside)
        shutil.rmtree(aside, ignore_errors=True)
    strides, header, data_size = _cache_file_layout(items, key)
    root.mkdir(parents=True, exist_ok=True)
    _check_root(root)
    _remove_stale_temporaries(root)
    free = shutil.disk_usage(root).free
    if free < data_size + FREE_SPACE_MARGIN:
        return {
            "written": False,
            "reason": f"not enough free space ({free} < {data_size} + 1 GiB)",
        }
    manifest = make_manifest(
        key,
        parts,
        header=header,
        data_size=data_size,
        tensors=len(items),
        strides=strides,
        quantized_layers=quantized_layers,
        reverse_mapping=reverse_mapping,
    )
    manifest_bytes = json.dumps(manifest, indent=1, sort_keys=True).encode(
        "utf-8"
    )  # fails before any write
    started = time.perf_counter()
    tmp = Path(tempfile.mkdtemp(prefix=f".tmp-{key[:16]}-", dir=root))
    try:
        _write_tensor_file(tmp, header, items, data_size)
        fd = os.open(
            tmp / MANIFEST_FILE,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
        )
        try:
            _write_all(fd, memoryview(manifest_bytes))
            os.fsync(fd)
        finally:
            os.close(fd)
        tmp.rename(
            final
        )  # atomic; fails when another load published the same key first
        dir_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return {
        "written": True,
        "bytes": data_size,
        "seconds": round(time.perf_counter() - started, 3),
    }


def _remove_stale_temporaries(root: Path, older_than_seconds: float = 6 * 3600) -> None:
    """Half-written entries a crashed load left behind (never one another load is still writing)."""
    now = time.time()
    for child in root.iterdir():
        if not child.name.startswith((".tmp-", ".invalid-")):
            continue
        info = Path(child).lstat()
        if stat.S_ISDIR(info.st_mode) and now - info.st_mtime > older_than_seconds:
            shutil.rmtree(child, ignore_errors=True)


def read_tensors(entry: CacheEntry, device: Any) -> dict[str, Any]:
    """Every tensor of ``entry`` as written (dtype, shape, strides), on ``device``; streaming reads."""
    import torch

    out: dict[str, Any] = {}
    fd = os.open(entry.data_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if os.fstat(fd).st_size != entry.manifest["data_size"]:
            raise CacheInvalid("data file changed after it was checked")
        os.lseek(fd, entry.data_offset, os.SEEK_SET)
        for item in entry.tensors:  # sorted by offset: one sequential pass
            tensor = torch.empty(item.shape, dtype=_torch_dtype(item.dtype))
            if tensor.numel():
                _read_into(fd, memoryview(_byte_view(tensor)))
            if item.stride is not None:
                strided = torch.empty_strided(
                    item.shape, item.stride, dtype=tensor.dtype
                )
                strided.copy_(tensor)
                tensor = strided
            if getattr(device, "type", str(device)) != "cpu":
                tensor = tensor.to(device)
            out[item.name] = tensor
    finally:
        os.close(fd)
    return out


def convrot_layers(model: Any) -> list[str]:
    """Modules whose online convrot_int8 method quantizes in post-processing (sorted)."""
    return sorted(
        name
        for name, module in model.named_modules()
        if type(getattr(module, "quant_method", None)).__name__ == CONVROT_METHOD
        and not getattr(module.quant_method, "is_checkpoint_serialized", True)
    )


def meta_signature(model: Any) -> str:
    return canonical_digest(
        sorted(
            [name, [int(d) for d in t.shape], str(t.dtype)]
            for name, t in model.state_dict().items()
        )
    )


def prepare_hit(model: Any, entry: CacheEntry) -> list[tuple[Any, dict[str, Any]]]:
    """Check the entry against the meta model, then re-declare each quantized linear as upstream leaves it.

    Returns the parameter snapshots that undo the re-declaration. Raises :class:`CacheInvalid` before
    touching the model when anything differs.
    """
    import torch

    layers = list(entry.quantized_layers)
    if layers != convrot_layers(model):
        raise CacheInvalid(
            "quantized layers differ from the model's convrot_int8 layers"
        )
    meta = model.state_dict()
    cached = {t.name: t for t in entry.tensors}
    weights = {f"{q}.weight" for q in layers}
    scales = {f"{q}.weight_scale" for q in layers}
    if set(cached) != set(meta) | scales or scales & set(meta):
        raise CacheInvalid("cached tensor names differ from the model")
    for name, info in cached.items():
        if name in scales:
            if info.dtype != "F32":
                raise CacheInvalid(f"weight scale is not FP32: {name}")
            continue
        target = meta[name]
        if tuple(target.shape) != info.shape:
            raise CacheInvalid(f"shape differs: {name}")
        if info.dtype != (
            _dtype_code(torch.int8) if name in weights else _dtype_code(target.dtype)
        ):
            raise CacheInvalid(f"dtype differs: {name}")
    snapshots = []
    for q in layers:
        module = model.get_submodule(q)
        snapshots.append((module, dict(module._parameters)))
        module.weight = torch.nn.Parameter(
            torch.empty(cached[f"{q}.weight"].shape, dtype=torch.int8, device="meta"),
            requires_grad=False,
        )
        module.register_parameter(
            "weight_scale",
            torch.nn.Parameter(
                torch.empty(
                    cached[f"{q}.weight_scale"].shape,
                    dtype=torch.float32,
                    device="meta",
                ),
                requires_grad=False,
            ),
        )
    return snapshots


def undo_hit(snapshots: Sequence[tuple[Any, dict[str, Any]]]) -> None:
    for module, parameters in snapshots:
        module._parameters.clear()
        module._parameters.update(parameters)


def _reverse_mapping(entry: CacheEntry) -> dict[str, Any]:
    raw = entry.manifest.get("reverse_param_names_mapping")
    if not isinstance(raw, dict):
        return {}
    return {k: tuple(v) if isinstance(v, list) else v for k, v in raw.items()}


def _json_mapping(model: Any) -> dict[str, Any] | None:
    raw = getattr(model, "reverse_param_names_mapping", None)
    if not isinstance(raw, Mapping):
        return None
    mapping = {str(k): list(v) if isinstance(v, tuple) else v for k, v in raw.items()}
    json.dumps(mapping)  # TypeError: not recordable -> not cached
    return mapping


# ------------------------------------------------------------------------------------------ the scope


@dataclass
class _Load:
    model_id: int
    key: str
    parts: dict[str, Any]
    hit: CacheEntry | None = None
    replace: bool = (
        False  # the entry under this key is unusable: the fresh result takes its place
    )


def _is_dtensor_model(model: Any) -> bool:
    return any(hasattr(t, "device_mesh") for t in model.state_dict().values())


@contextlib.contextmanager
def cache_scope(
    root: Path, parts: Mapping[str, Any], *, fsdp: Any = None
) -> Iterator[dict[str, Any]]:
    """Patch the pinned loader pair (``fsdp_load``) for one DiT load; ``parts`` = the key parts known up front."""
    if fsdp is None:
        fsdp = importlib.import_module("sglang.multimodal_gen.runtime.loader.fsdp_load")
    facts: dict[str, Any] = {
        "enabled": True,
        "status": "not_reached",
        "format_version": FORMAT_VERSION,
    }
    with _LOCK:
        original_load: Callable[..., Any] = fsdp.load_model_from_full_model_state_dict
        original_process: Callable[..., Any] = fsdp.process_model_weights_after_loading
        owner_thread = threading.get_ident()
        state: dict[str, _Load | None] = {"load": None}

        def load(*args: Any, **kwargs: Any) -> Any:
            if threading.get_ident() != owner_thread or state["load"] is not None:
                return original_load(*args, **kwargs)
            bound = inspect.signature(original_load).bind(*args, **kwargs)
            bound.apply_defaults()
            values = bound.arguments
            model = values["model"]
            if type(model).__name__ != MODEL_CLASS:
                return original_load(*args, **kwargs)
            if (
                values["preconverted_state_dict"] is not None
                or values["allow_device_tensor_assignment"]
                or not callable(values["param_names_mapping"])
                or _is_dtensor_model(model)
                or not convrot_layers(model)
            ):
                facts["status"] = (
                    "bypassed: unsupported placement, mapping, FSDP or no convrot layer"
                )
                return original_load(*args, **kwargs)
            device, load_parts, key = _load_identity(values, model, parts)
            current = _Load(id(model), key, load_parts)
            state["load"] = current
            facts["key"] = key
            entry, reason = lookup(root, key)
            facts["lookup"] = reason
            if reason.startswith("invalid"):
                LOG.warning(
                    "quantized cache entry %s ignored (%s); quantizing afresh",
                    key,
                    reason,
                )
            if entry is not None:
                hit, result = _load_cached_weights(
                    _CachedLoadRequest(
                        model, entry, device, facts, key, values, original_load, current
                    )
                )
                if hit:
                    return result
            if facts["status"] == "not_reached":
                facts["status"] = "miss"
            current.replace = entry is not None or reason.startswith("invalid")
            return original_load(*args, **kwargs)

        process = _cache_postprocessor(
            original_process, state, owner_thread, root, facts
        )

        fsdp.load_model_from_full_model_state_dict = load
        fsdp.process_model_weights_after_loading = process
        try:
            yield facts
        finally:
            fsdp.load_model_from_full_model_state_dict = original_load
            fsdp.process_model_weights_after_loading = original_process


def applicability(policy: Any, directory: Path) -> str | None:
    """Why the cache cannot serve this load, or None."""
    comp = policy.components.get("transformer")
    parallel = policy.effective_profile.get("parallelism", {})
    if (
        comp is None
        or comp.quant_scheme != "int8_convrot"
        or comp.quant_provider != "sglang_native"
    ):
        return "only int8_convrot/sglang_native is cached"
    if (
        parallel.get("tensor_degree", 1) != 1
        or parallel.get("fsdp_inference", False) is not False
    ):
        return "only TP1 without FSDP is cached"
    if not (directory / "model.safetensors.index.json").is_file():
        return "only an indexed native safetensors checkpoint is cached"
    return None


def prefix_parts(
    policy: Any, directory: Path, facts: Any, upstream: Mapping[str, str]
) -> dict[str, Any]:

    plan = quant_plan(
        (policy.effective_profile.get("components") or {}).get("transformer") or {}
    )
    comp = policy.components["transformer"]
    return {
        "source": source_identity(directory),
        "quantization": None if plan is None else plan.as_dict(),
        "excluded_modules": sorted(comp.excluded_modules),
        "load_signature": load_signature(policy),
        "upstream": dict(sorted(upstream.items())),
        "sglang_revision": SGLANG_REVISION,
        "runtime": {
            "arch": facts.arch,
            "sm": None if facts.sm is None else list(facts.sm),
            "torch": facts.torch,
            "cuda_runtime": facts.cuda_runtime,
            "sglang": (facts.packages or {}).get("sglang"),
        },
    }


@contextlib.contextmanager
def quantized_cache_context(
    policy: Any, directory: Path, facts: Any
) -> Iterator[dict[str, Any]]:
    """Off (no ``PHASYN_H3_QUANTIZED_CACHE_DIR``): yields ``{"enabled": False}`` and patches nothing."""
    root = configured_root()
    if root is None:
        yield {"enabled": False}
        return
    parts: dict[str, Any] | None = None
    reason = applicability(policy, directory)
    if reason is None:
        with RuntimeObservation() as cache_check:
            _check_root(root)
            upstream = pins.check(PIN_GROUP, what="量化權重快取")
            parts = prefix_parts(policy, directory, facts, upstream)
        if (exc := cache_check.error) is not None:
            reason = str(exc)[:500]
    if reason is not None or parts is None:
        LOG.warning("quantized cache not used: %s", reason)
        yield {"enabled": True, "status": "not_applicable", "reason": reason}
        return
    with cache_scope(root, parts) as scope_facts:
        yield scope_facts


__all__ = [
    "DATA_FILE",
    "ENV_DIR",
    "FORMAT",
    "FORMAT_VERSION",
    "MANIFEST_FILE",
    "CacheEntry",
    "CacheInvalid",
    "applicability",
    "build_header",
    "cache_key",
    "cache_scope",
    "capture_items",
    "configured_root",
    "lookup",
    "make_manifest",
    "parse_header",
    "quantized_cache_context",
    "read_tensors",
    "source_identity",
    "write_entry",
]


def _header_tensor(name: str, info: Mapping[str, Any]) -> TensorEntry:
    try:
        dtype, shape, (begin, end) = (
            info["dtype"],
            tuple(int(d) for d in info["shape"]),
            info["data_offsets"],
        )
    except (KeyError, TypeError, ValueError):
        raise CacheInvalid(f"header entry malformed: {name}") from None
    if (
        dtype not in DTYPE_BYTES
        or end - begin != _numel(shape) * DTYPE_BYTES[dtype]
        or begin < 0
    ):
        raise CacheInvalid(f"header entry inconsistent: {name}")
    return TensorEntry(str(name), dtype, shape, int(begin), int(end), None)


def _read_entry_manifest(
    directory: Path, key: str, info: os.stat_result
) -> dict[str, Any]:
    if not stat.S_ISDIR(info.st_mode):
        raise CacheInvalid("entry is not a directory")
    manifest = json.loads(_read_bounded(directory / MANIFEST_FILE, MAX_MANIFEST_BYTES))
    if not isinstance(manifest, dict):
        raise CacheInvalid("manifest is not an object")
    if (
        manifest.get("format") != FORMAT
        or manifest.get("format_version") != FORMAT_VERSION
    ):
        raise CacheInvalid("manifest format/version differ")
    if manifest.get("key") != key or cache_key(manifest.get("parts") or {}) != key:
        raise CacheInvalid("manifest key does not match its parts or the requested key")
    return manifest


def _read_entry_header(
    directory: Path, manifest: Mapping[str, Any]
) -> tuple[int, list[TensorEntry]]:
    data_path = directory / DATA_FILE
    fd = os.open(data_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as handle:
        data_info = os.fstat(handle.fileno())
        if not stat.S_ISREG(data_info.st_mode) or data_info.st_nlink != 1:
            raise CacheInvalid("data file is not a single-link regular file")
        if data_info.st_size != manifest.get("data_size"):
            raise CacheInvalid(
                f"data file size {data_info.st_size} != manifest {manifest.get('data_size')}"
            )
        head = handle.read(8)
        if len(head) != _ST_HEADER_SIZE:
            raise CacheInvalid("data file truncated")
        (length,) = struct.unpack("<Q", head)
        if length > MAX_HEADER_BYTES:
            raise CacheInvalid("header length out of bounds")
        header = head + handle.read(length)
    if hashlib.sha256(header).hexdigest() != manifest.get("header_sha256"):
        raise CacheInvalid("header sha256 differs from the manifest")
    return parse_header(header, data_info.st_size)


def _check_entry_layers(manifest: Mapping[str, Any]) -> None:
    layers = manifest.get("quantized_layers")
    if (
        not isinstance(layers, list)
        or not layers
        or not all(isinstance(x, str) for x in layers)
    ):
        raise CacheInvalid("manifest lists no quantized layers")


def _verify_written_size(tmp: Path, data_size: int) -> None:
    if (tmp / DATA_FILE).stat().st_size != data_size:
        raise CacheInvalid("written data file has the wrong size")


def _cache_file_layout(
    items: Sequence[tuple[str, Any]], key: str
) -> tuple[dict[str, list[int]], bytes, int]:
    specs = [(name, _dtype_code(t.dtype), tuple(t.shape)) for name, t in items]
    strides = {
        name: list(t.stride())
        for name, t in items
        if t.dim() and tuple(t.stride()) != _contiguous_strides(t.shape)
    }
    header = build_header(specs, {"format": FORMAT, "key": key})
    data_size = len(header) + sum(_numel(s) * DTYPE_BYTES[d] for _n, d, s in specs)
    return strides, header, data_size


def _load_identity(
    values: Any, model: Any, parts: Mapping[str, Any]
) -> tuple[Any, Any, Any]:
    device = values["checkpoint_load_device"]
    load_parts = {
        **parts,
        "load": {
            "model_class": type(model).__name__,
            "param_dtype": str(values["param_dtype"]),
            "checkpoint_load_device": str(getattr(device, "type", device)),
            "cpu_offload": bool(values["cpu_offload"]),
            "keep_checkpoint_mapping": bool(values["keep_checkpoint_mapping"]),
            "strict": bool(values["strict"]),
            "meta_signature": meta_signature(model),
            "convrot_layers": canonical_digest(convrot_layers(model)),
        },
    }
    key = cache_key(load_parts)
    return device, load_parts, key


def _publish_quantized_weights(
    model: Any, layers: Any, current: _Load, root: Path, facts: dict[str, Any]
) -> None:
    params = dict(model.named_parameters())
    if any(
        str(params[f"{q}.weight"].dtype) != "torch.int8"
        or f"{q}.weight_scale" not in params
        for q in layers
    ):
        raise CacheInvalid("post-processing left a convrot layer unquantized")
    facts["write"] = write_entry(
        root,
        current.key,
        current.parts,
        capture_items(model),
        quantized_layers=layers,
        reverse_mapping=_json_mapping(model),
        replace_invalid=current.replace,
    )


def _write_tensor_file(
    tmp: Any, header: Any, items: Sequence[tuple[str, Any]], data_size: Any
) -> None:
    fd = os.open(
        tmp / DATA_FILE,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
    )
    try:
        _write_all(fd, memoryview(header))
        for _name, tensor in items:
            if not tensor.numel():
                continue
            host = (
                tensor.detach().to("cpu").contiguous()
            )  # a copy only for device / strided tensors
            _write_all(fd, memoryview(_byte_view(host)))
            del host
        os.fsync(fd)
    finally:
        os.close(fd)
    _verify_written_size(tmp, data_size)


def _cache_postprocessor(
    original_process: Any,
    state: dict[str, _Load | None],
    owner_thread: int,
    root: Path,
    facts: dict[str, Any],
) -> Any:
    def process(model: Any, *args: Any, **kwargs: Any) -> Any:
        result = original_process(model, *args, **kwargs)
        current = state["load"]
        if (
            threading.get_ident() != owner_thread
            or current is None
            or current.model_id != id(model)
        ):
            return result
        layers = convrot_layers(model)
        if current.hit is not None:
            params = dict(model.named_parameters())
            for q in layers:
                if (
                    str(params[f"{q}.weight"].dtype) != "torch.int8"
                    or f"{q}.weight_scale" not in params
                ):
                    raise UnsupportedCombination(
                        "QUANTIZED_CACHE_NOT_APPLIED",
                        f"cached layer {q} was changed by post-processing",
                    )
            return result
        with RuntimeObservation() as cache_write:
            _publish_quantized_weights(model, layers, current, root, facts)
        if (exc := cache_write.error) is not None:
            facts["write"] = {"written": False, "reason": str(exc)[:500]}
            LOG.warning("quantized cache not written for %s: %s", current.key, exc)
        return result

    return process


class _CachedLoadRequest(NamedTuple):
    model: Any
    entry: CacheEntry
    device: Any
    facts: dict[str, Any]
    key: str
    values: Mapping[str, Any]
    original_load: Callable[..., Any]
    current: _Load


def _load_cached_weights(request: _CachedLoadRequest) -> tuple[bool, Any]:
    model, entry, device, facts, key, values, original_load, current = request
    snapshots: list[tuple[Any, dict[str, Any]]] = []
    with RuntimeObservation() as cache_read:
        started = time.perf_counter()
        snapshots = prepare_hit(model, entry)
        tensors = read_tensors(entry, device)
        facts["read_seconds"] = round(time.perf_counter() - started, 3)
        facts["read_bytes"] = int(entry.manifest["data_size"])
    if (exc := cache_read.error) is not None:
        undo_hit(snapshots)
        facts["status"] = "fallback"
        facts["fallback_reason"] = str(exc)[:500]
        LOG.warning(
            "quantized cache entry %s unusable (%s); quantizing afresh",
            key,
            exc,
        )
    else:
        try:
            result = original_load(
                **{
                    **values,
                    "full_sd_iterator": iter(()),
                    "preconverted_state_dict": (
                        tensors,
                        _reverse_mapping(entry),
                    ),
                }
            )
        except BaseException:
            undo_hit(snapshots)
            raise
        current.hit = entry
        facts["status"] = "hit"
        close = getattr(values["full_sd_iterator"], "close", None)
        if callable(close):
            close()  # the BF16 shards are never read
        return True, result
    return False, None
