"""Host copies of component weights and timed host<->device rebinding.

A :class:`HostStore` holds one host tensor per parameter/buffer of a module
(same shape, stride and dtype).  Tensors are placed in one page-aligned arena
that is page-locked in place with ``cudaHostRegister`` at its exact size (the
torch pinned pool rounds every block up to a power of two, which would charge a
9.7 GiB VAE as 16 GiB), first-fit up to the profile's ``max_pinned_bytes``
*and* what the host can still give (``host_available_bytes``: MemAvailable minus
a reserve — page-locking memory the host does not have pushes it into swap).
A CPU tensor that does not get a pinned slot is kept as is (its own pageable or
checkpoint-mapped memory, no second copy); a device tensor without a slot gets
a pageable copy, and when even that does not fit the store is refused with
:class:`~phasyn_h3.recipe.runtime.lifecycle.HostMemoryInsufficient` before anything
is allocated.  The arena is anonymous shared memory (memfd), like the pinned
SGLang layer stores (layerwise_offload.py:404-487).

``materialize`` rebinds every tensor to a device copy (async from pinned memory)
and measures the transfer; ``release`` rebinds them back to the host copies, so
the device copies are dropped and their memory returns to the caching
allocator, which is then emptied.  Weights are never mutated by inference, so a
host copy taken once stays valid for every later reload.

torch is imported lazily: importing this module stays torch-free.
"""

from __future__ import annotations

import contextlib
import gc
import os
import time
import weakref
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

PAGE = 4096
# caches rebuilt on demand that hold device tensors: decode/rope caches outside parameters/buffers,
# and the DiT time embedder's lazily filled non-persistent buffer ``_frequency_cache``
# (minimax_h3.py:643-662).  The latter is created inside the denoise loop's inference_mode, so it is
# an inference tensor: parked in a host store and rebound with ``.data =``, the next forward fails
# ("Inference tensors do not track version counter") — it is dropped instead, never stored.
_CACHE_RESET_NONE = ("_rotary_pos_emb_cache", "_autocast_linear_dtype", "_frequency_cache")
_CACHE_CLEAR = ("_blend_weight_cache",)
HOST_RESERVE_BYTES = 2 * 1024**3  # never plan a host copy into the last 2 GiB of MemAvailable


def mem_available_bytes() -> int | None:
    """``MemAvailable`` from /proc/meminfo (bytes), None when unknown."""
    try:
        with open("/proc/meminfo", encoding="ascii") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def _align(nbytes: int) -> int:
    return (nbytes + PAGE - 1) // PAGE * PAGE


def _span_elements(shape: tuple[int, ...], stride: tuple[int, ...]) -> int:
    if any(d == 0 for d in shape):
        return 0
    return 1 + sum((d - 1) * s for d, s in zip(shape, stride, strict=True) if d > 0)


def _contiguous(shape: tuple[int, ...]) -> tuple[int, ...]:
    strides: list[int] = []
    acc = 1
    for d in reversed(shape):
        strides.append(acc)
        acc *= max(d, 1)
    return tuple(reversed(strides))


def host_layout(tensor: Any) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Shape/stride of the host copy: the tensor's own layout when it is dense
    (channels-last conv weights keep their strides), contiguous otherwise
    (expanded or gapped views cannot be written element-wise)."""
    shape = tuple(int(d) for d in tensor.shape)
    stride = tuple(int(s) for s in tensor.stride())
    if all(s >= 0 for s in stride) and _span_elements(shape, stride) == int(tensor.numel()):
        return shape, stride
    return shape, _contiguous(shape)


def storage_span_bytes(tensor: Any) -> int:
    """Bytes the host copy of a tensor occupies (see :func:`host_layout`)."""
    shape, stride = host_layout(tensor)
    return _span_elements(shape, stride) * int(tensor.element_size())


@dataclass
class HostStore:
    tensors: dict[str, Any]  # name -> host tensor
    kinds: dict[str, str]  # name -> "param" | "buffer"
    host_bytes: int
    pinned_bytes: int
    pageable_bytes: int
    pin_method: str
    build_seconds: float
    arena: Any = None
    storage: Any = None
    notes: list[str] = field(default_factory=list)
    # bytes kept in the source tensors' own CPU memory (pageable or checkpoint
    # mapping) instead of a new copy: no extra host memory, unpinned transfers
    reused_bytes: int = 0

    def facts(self) -> dict[str, Any]:
        return {
            "host_bytes": self.host_bytes,
            "pinned_bytes": self.pinned_bytes,
            "pageable_bytes": self.pageable_bytes,
            "reused_cpu_bytes": self.reused_bytes,
            "pin_method": self.pin_method,
            "tensors": len(self.tensors),
            "build_seconds": round(self.build_seconds, 6),
            **({"notes": list(self.notes)} if self.notes else {}),
        }


def module_tensors(module: Any, *, exclude: Iterable[str] = ()) -> list[tuple[str, str, Any]]:
    """(name, kind, tensor) of every parameter and buffer, minus ``exclude``."""
    skip = set(exclude)
    out: list[tuple[str, str, Any]] = []
    for name, param in module.named_parameters():
        if name not in skip:
            out.append((name, "param", param))
    for name, buf in module.named_buffers():
        if buf is not None and name not in skip:
            out.append((name, "buffer", buf))
    return out


def _memfd_arena(nbytes: int) -> Any:
    import torch

    if hasattr(os, "memfd_create"):
        try:
            fd = os.memfd_create("phasyn-h3-host-store", 0)
        except OSError:
            fd = -1
        if fd >= 0:
            storage = None
            try:
                os.ftruncate(fd, nbytes)
                storage = torch.UntypedStorage.from_file(f"/proc/self/fd/{fd}", shared=True, nbytes=nbytes)
            except Exception:
                storage = None  # no memfd mapping: anonymous memory below
            finally:
                os.close(fd)
            if storage is not None:
                arena = torch.empty(0, dtype=torch.uint8)
                arena.set_(storage, 0, (nbytes,), (1,))
                return arena
    return torch.empty(nbytes, dtype=torch.uint8)


def _unregister(data_ptr: int) -> None:
    with contextlib.suppress(Exception):  # finalizer: the process may be shutting CUDA down
        import torch

        torch.cuda.cudart().cudaHostUnregister(data_ptr)


def _register(arena: Any) -> bool:
    import torch

    if not torch.cuda.is_available():
        return False
    storage = arena.untyped_storage()
    try:
        if int(torch.cuda.cudart().cudaHostRegister(storage.data_ptr(), storage.nbytes(), 0)) != 0:
            return False
    except Exception:
        return False
    weakref.finalize(storage, _unregister, storage.data_ptr())
    return True


def build_host_store(
    items: Sequence[tuple[str, str, Any]],
    *,
    pinned_cap_bytes: int,
    pin: bool = True,
    host_available_bytes: int | None = None,
) -> HostStore:
    """Host copies of ``items``: pinned first-fit up to the cap and the host's room,
    CPU tensors kept as they are beyond that, device tensors copied to pageable memory.

    ``host_available_bytes`` bounds every *new* host allocation (pinned arena and
    pageable copies); None means unknown (no bound).  Raises
    ``HostMemoryInsufficient`` before allocating when device tensors cannot be held.
    """
    import torch

    from .lifecycle import HostMemoryInsufficient

    started = time.perf_counter()
    room = float("inf") if host_available_bytes is None else max(0, int(host_available_bytes))
    offsets: dict[str, int] = {}
    reuse: set[str] = set()
    arena_bytes = 0
    copies = 0  # pageable copies of device tensors
    total = 0
    for name, _kind, tensor in items:
        span = storage_span_bytes(tensor)
        total += span
        size = _align(span)
        fits = arena_bytes + size <= pinned_cap_bytes and arena_bytes + size + copies <= room
        if pin and span > 0 and fits:
            offsets[name] = arena_bytes
            arena_bytes += size
        elif tensor.device.type == "cpu":
            reuse.add(name)
        else:
            copies += span
    if arena_bytes + copies > room:
        raise HostMemoryInsufficient(
            "HOST_MEMORY_INSUFFICIENT",
            f"host 副本需要 {arena_bytes + copies} bytes（pinned {arena_bytes}＋pageable {copies}），"
            f"可用 {int(room)} bytes",
        )
    arena = None
    storage = None
    pin_method = "none"
    notes: list[str] = []
    if arena_bytes > 0:
        arena = _memfd_arena(arena_bytes)
        if _register(arena):
            pin_method = "cudaHostRegister"
            storage = arena.untyped_storage()
        else:
            notes.append("cudaHostRegister 失敗，host 副本改用一般（pageable）記憶體")
            arena = None
            offsets.clear()
    if pin and reuse:
        notes.append("pinned 上限或 host 可用記憶體不足：部分 CPU 權重留在原本的 pageable／checkpoint 映射（不另複製）")
    tensors: dict[str, Any] = {}
    kinds: dict[str, str] = {}
    pinned = 0
    reused = 0
    with torch.inference_mode(False), torch.no_grad():
        for name, kind, tensor in items:
            src = tensor.detach()
            if name in reuse or (name not in offsets and src.device.type == "cpu"):
                tensors[name] = src  # its own host memory: no second copy
                kinds[name] = kind
                reused += storage_span_bytes(src)
                continue
            shape, stride = host_layout(src)
            off = offsets.get(name)
            if off is not None and arena is not None:
                span = storage_span_bytes(src)
                flat = arena[off : off + span].view(src.dtype)
                host = flat.as_strided(shape, stride)
                pinned += span
            else:
                host = torch.empty_strided(shape, stride, dtype=src.dtype, device="cpu")
            host.copy_(src)
            tensors[name] = host
            kinds[name] = kind
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    return HostStore(
        tensors=tensors,
        kinds=kinds,
        host_bytes=total,
        pinned_bytes=pinned,
        pageable_bytes=total - pinned,
        pin_method=pin_method,
        build_seconds=time.perf_counter() - started,
        arena=arena,
        storage=storage,
        notes=notes,
        reused_bytes=reused,
    )


def host_room_bytes() -> int | None:
    """New host memory a store may take: MemAvailable minus the reserve (None: unknown)."""
    available = mem_available_bytes()
    return None if available is None else max(0, available - HOST_RESERVE_BYTES)


def _target(module: Any, name: str, kind: str) -> Any:
    return module.get_parameter(name) if kind == "param" else module.get_buffer(name)


def reset_device_caches(module: Any) -> None:
    """Drop caches that hold device tensors (rope tables, tile blend weights, the decoder's
    persisted autocast dtype, the time embedder's frequency buffer); the model rebuilds them."""
    for sub in module.modules():
        buffers = sub.__dict__.get("_buffers") or {}
        for attr in _CACHE_RESET_NONE:
            if attr in sub.__dict__ or attr in buffers:
                setattr(sub, attr, None)
        for attr in _CACHE_CLEAR:
            cache = sub.__dict__.get(attr)
            if isinstance(cache, dict):
                cache.clear()


def materialize(module: Any, store: HostStore, device: Any) -> dict[str, Any]:
    """Rebind every stored tensor to a fresh device copy; measured H2D transfer."""
    import torch

    started = time.perf_counter()
    moved = 0
    with torch.inference_mode(False), torch.no_grad():
        for name, host in store.tensors.items():
            target = _target(module, name, store.kinds[name])
            target.data = host.to(device, non_blocking=bool(host.is_pinned()))
            moved += storage_span_bytes(host)
    if getattr(device, "type", str(device)) == "cuda":
        torch.cuda.synchronize(device)
    reset_device_caches(module)
    seconds = time.perf_counter() - started
    return {
        "direction": "h2d",
        "bytes": moved,
        "seconds": round(seconds, 6),
        "gbps": round(moved / seconds / 1e9, 3) if seconds > 0 else None,
        "pinned_bytes": store.pinned_bytes,
        "pageable_bytes": store.pageable_bytes,
    }


def rebind_to_host(module: Any, store: HostStore) -> None:
    """Point every stored tensor back at its host copy (drops the device copies)."""
    import torch

    with torch.inference_mode(False), torch.no_grad():
        for name, host in store.tensors.items():
            _target(module, name, store.kinds[name]).data = host
    reset_device_caches(module)


def empty_device_cache(device: Any) -> bool:
    """gc + synchronize + empty the caching allocator; True when CUDA synchronized."""
    import torch

    gc.collect()
    if getattr(device, "type", str(device)) != "cuda" or not torch.cuda.is_available():
        return False
    torch.cuda.synchronize(device)
    torch.cuda.empty_cache()
    return True


def free_host_store(store: HostStore | None, *, collect: bool = True) -> None:
    """Drop a host store; the arena is unregistered by its storage finalizer (once the tensors
    rebound to it are gone too).  ``collect=False``: the caller runs ``release_host_memory`` later."""
    if store is None:
        return
    store.tensors.clear()
    store.kinds.clear()
    store.arena = None
    store.storage = None
    if collect:
        release_host_memory()


def release_host_memory() -> int:
    """gc, then hand freed host memory back to the OS: torch's cached pinned blocks and the C heap
    (glibc ``malloc_trim``: pageable copies below the mmap threshold were freed into the heap, not
    unmapped).  Returns the objects collected.

    Call it from a frame that no longer references what is being released: a ``gc.collect()``
    while a local still points into a module's reference cycle (module <-> layerwise managers,
    ``_offload_root``) frees nothing, and on an evict outside a stage nothing collects later."""
    collected = gc.collect()
    with contextlib.suppress(Exception):  # best effort: torch's own pinned pool (small blocks)
        import torch

        empty_host = getattr(torch._C, "_host_emptyCache", None)
        if callable(empty_host):
            empty_host()
    _malloc_trim()
    return collected


_LIBC: list[Any] = []


def _malloc_trim() -> bool:
    """glibc ``malloc_trim(0)``; False where there is none (musl, macOS) or it released nothing."""
    try:
        if not _LIBC:
            import ctypes

            _LIBC.append(ctypes.CDLL("libc.so.6"))
        return bool(_LIBC[0].malloc_trim(0))
    except (OSError, AttributeError):
        return False


# nn.Module bookkeeping the scrub empties in place instead of replacing
_MODULE_HOOK_DICTS = (
    "_forward_hooks",
    "_forward_hooks_with_kwargs",
    "_forward_hooks_always_called",
    "_forward_pre_hooks",
    "_forward_pre_hooks_with_kwargs",
    "_backward_hooks",
    "_backward_pre_hooks",
    "_state_dict_hooks",
    "_state_dict_pre_hooks",
    "_load_state_dict_pre_hooks",
    "_load_state_dict_post_hooks",
)
_MODULE_INTERNALS = frozenset(
    {"_parameters", "_buffers", "_modules", "_non_persistent_buffers_set", *_MODULE_HOOK_DICTS}
)


def _holds_tensors(value: Any, tensor_type: type, module_type: type, depth: int = 0) -> bool:
    """A tensor, or a container / plain object (e.g. the AdaLN cache's host tier) holding tensors
    within two levels; submodules are scrubbed on their own and never count."""
    if isinstance(value, tensor_type):
        return True
    if depth > 2 or isinstance(value, (module_type, type, str, bytes)):
        return False
    if isinstance(value, dict):
        items: Any = value.values()
    elif isinstance(value, (list, tuple)):
        items = value
    elif hasattr(value, "__dict__"):
        items = vars(value).values()
    else:
        return False
    return any(_holds_tensors(v, tensor_type, module_type, depth + 1) for v in list(items)[:256])


def drop_module_tensors(module: Any) -> int:
    """Unload: a discarded module keeps no tensor memory, whatever still references the module.

    Every parameter is rebound to an empty tensor and removed, buffers removed, tensor-valued
    attributes outside parameters/buffers (LoRA ``cpu_weight`` snapshots, PDD ``_pdd_heads``, AdaLN
    plans, caches) set to None and hooks cleared — so the host stores (pinned memfd arenas,
    pageable copies) and device copies are freed by reference counting right here instead of
    waiting for the cyclic GC to find the module.  Returns how many tensors were dropped."""
    import torch

    if not isinstance(module, torch.nn.Module):  # tokenizer / processor handles hold no tensors
        return 0
    dropped = 0
    empty: dict[Any, Any] = {}
    with torch.inference_mode(False), torch.no_grad():
        for sub in list(module.modules()):
            state = sub.__dict__
            params = state.get("_parameters") or {}
            for name, param in list(params.items()):
                if param is None:
                    continue
                with contextlib.suppress(Exception):  # an inference tensor cannot be rebound: removing it is enough
                    param.data = empty.setdefault(param.dtype, torch.empty(0, dtype=param.dtype))
                params[name] = None
                dropped += 1
            buffers = state.get("_buffers") or {}
            for name, buf in list(buffers.items()):
                if buf is not None:
                    buffers[name] = None
                    dropped += 1
            for key, value in list(state.items()):
                if key not in _MODULE_INTERNALS and _holds_tensors(value, torch.Tensor, torch.nn.Module):
                    state[key] = None
                    dropped += 1
            for key in _MODULE_HOOK_DICTS:
                hooks = state.get(key)
                if isinstance(hooks, dict):
                    hooks.clear()
    return dropped


__all__ = [
    "HOST_RESERVE_BYTES",
    "HostStore",
    "build_host_store",
    "drop_module_tensors",
    "empty_device_cache",
    "free_host_store",
    "host_layout",
    "host_room_bytes",
    "materialize",
    "mem_available_bytes",
    "module_tensors",
    "rebind_to_host",
    "release_host_memory",
    "reset_device_caches",
    "storage_span_bytes",
]
