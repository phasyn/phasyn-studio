"""Opt-in, native H3 FP8 cold loading without a full BF16 CPU state dict.

The original pinned per-parameter loader and per-linear postprocessor remain
the numerical oracle. No weights are saved or downloaded.
Only CPU checkpoint tensors are grouped; a whole linear row is quantized at once.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib
import inspect
import json
import os
import threading
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from phasyn_h3.recipe.abi.tensors import TensorInfo, read_header_from_file

from . import pins
from .errors import UnsupportedCombination

ENV = "PHASYN_H3_BOUNDED_FP8_LOAD"
ALGORITHM = "h3_native_fp8_leaf_load.v1"
MAX_LEAF_BYTES = 512 * 1024 * 1024
MAX_TENSORS = 2048
_LOCK = threading.RLock()


def _refuse(reason: str) -> UnsupportedCombination:
    return UnsupportedCombination("BOUNDED_FP8_LOAD_REFUSED", reason)


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _refuse(f"duplicate JSON key: {key}")
        result[key] = value
    return result


@dataclass(frozen=True)
class SourceTensor:
    path: Path
    info: TensorInfo


@dataclass(frozen=True)
class NativeCheckpoint:
    index_path: Path
    tensors: Mapping[str, SourceTensor]
    identities: Mapping[Path, tuple[int, int, int, int]]
    header_sha256: Mapping[str, str]

    @classmethod
    def inspect(cls, directory: Path) -> NativeCheckpoint:
        """Bounded header-only preflight; indexed shards only, exact key coverage."""
        directory = directory.resolve()
        index = directory / "model.safetensors.index.json"
        index_stat = index.stat()
        if index_stat.st_size > 16 * 1024 * 1024:
            raise _refuse("checkpoint index exceeds 16 MiB")
        with index.open("rb") as handle:
            index_bytes = handle.read(16 * 1024 * 1024 + 1)
        if len(index_bytes) != index_stat.st_size:
            raise _refuse("checkpoint index changed during read")
        document = json.loads(index_bytes, object_pairs_hook=_unique_pairs)
        if not isinstance(document, dict):
            raise _refuse("checkpoint index must be an object")
        weight_map = document.get("weight_map")
        if not isinstance(weight_map, dict) or not 0 < len(weight_map) <= MAX_TENSORS:
            raise _refuse("checkpoint needs a bounded native weight_map")
        if any(not isinstance(k, str) or not isinstance(v, str) for k, v in weight_map.items()):
            raise _refuse("checkpoint weight_map must contain string names and filenames")
        tensors: dict[str, SourceTensor] = {}
        identities = {index: (index_stat.st_dev, index_stat.st_ino, index_stat.st_size, index_stat.st_mtime_ns)}
        hashes = {index.name: hashlib.sha256(index_bytes).hexdigest()}
        for filename in sorted(set(weight_map.values())):
            path = (directory / filename).resolve()
            if path.parent != directory or path.suffix != ".safetensors":
                raise _refuse("checkpoint shard must be a local safetensors file in its component directory")
            stat = path.stat()
            header = read_header_from_file(path)
            identities[path] = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
            with path.open("rb") as handle:
                hashes[path.name] = hashlib.sha256(handle.read(header.data_offset)).hexdigest()
            for name, info in header.tensors.items():
                if name in tensors or weight_map.get(name) != filename:
                    raise _refuse(f"duplicate or misindexed checkpoint tensor: {name}")
                if info.dtype not in {"BF16", "F32"}:
                    raise _refuse(f"native BF16/F32 checkpoint required: {name} has {info.dtype}")
                tensors[name] = SourceTensor(path, info)
        if set(tensors) != set(weight_map):
            raise _refuse("checkpoint index and actual header keys differ")
        result = cls(index, tensors, identities, hashes)
        for path in identities:
            result.verify_file(path)
        return result

    def verify_file(self, path: Path) -> None:
        stat = path.stat()
        if (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns) != self.identities[path]:
            raise _refuse(f"checkpoint changed after header preflight: {path.name}")
        length = stat.st_size if path == self.index_path else read_header_from_file(path).data_offset
        with path.open("rb") as handle:
            digest = hashlib.sha256(handle.read(length)).hexdigest()
        if digest != self.header_sha256[path.name]:
            raise _refuse(f"checkpoint header/index changed: {path.name}")


class _ModulesView:
    def __init__(self, modules: list[Any]) -> None:
        self._modules = modules

    def modules(self) -> Iterator[Any]:
        yield from self._modules


class _LeafView:
    """Expose original fully-qualified names while assign=True writes to the owner."""

    def __init__(self, owner: Any, prefix: str, state: dict[str, Any], parameters: dict[str, Any]) -> None:
        self.owner = owner
        self.prefix = prefix + "." if prefix else ""
        self.state = state
        self.parameters = parameters
        self.reverse_param_names_mapping: dict[str, Any] = {}

    def state_dict(self) -> dict[str, Any]:
        return self.state

    def named_parameters(self) -> Iterator[tuple[str, Any]]:
        yield from self.parameters.items()

    def load_state_dict(self, state: dict[str, Any], *, strict: bool, assign: bool) -> Any:
        if any(not name.startswith(self.prefix) for name in state):
            raise _refuse("parameter escaped its direct-state group")
        local = {name[len(self.prefix) :]: value for name, value in state.items()}
        result = self.owner.load_state_dict(local, strict=False, assign=assign)
        # Child state is outside this group's scope; unexpected local keys are not.
        if result.unexpected_keys:
            raise _refuse(f"unexpected assigned parameters: {result.unexpected_keys}")
        return result


def _groups(model: Any, checkpoint: NativeCheckpoint, mapper: Callable[..., Any]) -> tuple[list[Any], dict[str, Any]]:
    state = model.state_dict()
    params = dict(model.named_parameters())
    if len(state) > MAX_TENSORS or not state:
        raise _refuse("model state is empty or exceeds tensor bound")
    all_values = list(model.named_parameters(remove_duplicate=False)) + list(
        model.named_buffers(remove_duplicate=False)
    )
    if len({id(value) for _, value in all_values}) != len(all_values):
        raise _refuse("tied or aliased parameters/buffers are not supported")
    for name, tensor in state.items():
        if tensor.device.type != "meta" or hasattr(tensor, "device_mesh"):
            raise _refuse(f"unsharded meta initialization required: {name}")
        if str(tensor.dtype) not in {"torch.bfloat16", "torch.float32"}:
            raise _refuse(f"unsupported target dtype: {name}")
    for name in checkpoint.tensors:
        if name not in state:
            if ".adaln_proj.linear." not in name:
                raise _refuse(f"unexpected checkpoint key: {name}")
            continue  # fixed AdaLN only; gated before installing the hook
        if mapper(name) != (name, None, None):
            raise _refuse(f"native identity mapping required: {name}")
        info = checkpoint.tensors[name].info
        if tuple(state[name].shape) != info.shape:
            raise _refuse(f"checkpoint shape mismatch: {name}")
    by_owner: dict[str, dict[str, Any]] = {}
    for name, tensor in state.items():
        if name not in checkpoint.tensors and getattr(params.get(name), "missing_param_init", None) not in {
            "ones",
            "zeros",
        }:
            raise _refuse(f"required checkpoint tensor missing: {name}")
        prefix = name.rpartition(".")[0]
        by_owner.setdefault(prefix, {})[name] = tensor
    groups = []
    for prefix, subset in by_owner.items():
        owner = model.get_submodule(prefix) if prefix else model
        source_bytes = sum(checkpoint.tensors[n].info.byte_length for n in subset if n in checkpoint.tensors)
        target_bytes = sum(t.numel() * t.element_size() for t in subset.values())
        if max(source_bytes, target_bytes) > MAX_LEAF_BYTES:
            raise _refuse(f"direct-state group exceeds {MAX_LEAF_BYTES} bytes: {prefix}")
        groups.append(
            (owner, prefix, subset, {n: params[n] for n in subset if n in params}, source_bytes, target_bytes)
        )
    return groups, state


def stream_load(
    model: Any,
    checkpoint: NativeCheckpoint,
    *,
    mapper: Callable[..., Any],
    original_load: Callable[..., Any],
    original_process: Callable[..., Any],
    checkpoint_device: Any,
    param_dtype: Any,
    strict: bool,
    cpu_offload: bool,
    facts: dict[str, Any],
    processed: set[int],
) -> Any:
    """Load whole direct-state groups, using the original CPU loader and quantizer."""
    from safetensors import safe_open

    groups, _state = _groups(model, checkpoint, mapper)
    snapshots = [(owner, dict(owner._parameters), dict(owner._buffers)) for owner, *_ in groups]
    reverse: dict[str, Any] = {}
    facts.update(
        algorithm=ALGORITHM,
        groups=len(groups),
        max_group_source_bytes=max(g[4] for g in groups),
        max_group_target_bytes=max(g[5] for g in groups),
        checkpoint_header_sha256=dict(checkpoint.header_sha256),
        quantization="unchanged original whole-linear postprocess; not column chunked",
        completed_groups=0,
    )
    result = None
    try:
        for owner, prefix, subset, parameters, _source_bytes, _target_bytes in groups:
            checkpoint.verify_file(checkpoint.index_path)
            view = _LeafView(owner, prefix, subset, parameters)
            with contextlib.ExitStack() as stack:
                handles: dict[Path, Any] = {}
                loaded = {}
                for name in subset:
                    source = checkpoint.tensors.get(name)
                    if source is None:
                        continue
                    if source.path not in handles:
                        checkpoint.verify_file(source.path)
                        handles[source.path] = stack.enter_context(
                            safe_open(str(source.path), framework="pt", device="cpu")
                        )
                    loaded[name] = handles[source.path].get_tensor(name)
                for path in handles:
                    checkpoint.verify_file(path)
                reverse_subset = {name: (name, None, None) for name in loaded}
                result = original_load(
                    view,
                    iter(()),
                    checkpoint_device,
                    param_dtype,
                    strict=strict,
                    cpu_offload=cpu_offload,
                    param_names_mapping=mapper,
                    preconverted_state_dict=(loaded, reverse_subset),
                )
                reverse.update(view.reverse_param_names_mapping)
                loaded.clear()  # Drop checkpoint views before quantization allocates output.
            original_process(_ModulesView([owner]))
            processed.add(id(owner))
            facts["completed_groups"] += 1
        model.reverse_param_names_mapping = reverse
        checkpoint.verify_file(checkpoint.index_path)
        facts["complete"] = True
        return result
    except BaseException:
        # All originals were meta. Do not retain a partially loaded component on failure.
        for owner, parameters, buffers in snapshots:
            owner._parameters.clear()
            owner._parameters.update(parameters)
            owner._buffers.clear()
            owner._buffers.update(buffers)
        processed.clear()
        facts["complete"] = False
        raise


@contextlib.contextmanager
def bounded_fp8_load_context(policy: Any, directory: Path) -> Iterator[dict[str, Any]]:
    """Disabled by default; enable only for the reviewed native fixed-AdaLN TP1 path."""
    raw = os.environ.get(ENV, "0")
    if raw == "0":
        yield {"enabled": False}
        return
    if raw != "1":
        raise _refuse(f"{ENV} must be 0 or 1")
    comp = policy.components.get("transformer")
    parallel = policy.effective_profile.get("parallelism", {})
    if (
        comp is None
        or comp.quant_scheme != "fp8_e4m3"
        or comp.quant_provider != "sglang_native"
        or comp.offload != "block"
        or policy.adaln_mode != "fixed"
        or parallel.get("tensor_degree") != 1
        or parallel.get("fsdp_inference") is not False
    ):
        raise _refuse("bounded loader requires native online FP8, block offload, fixed AdaLN, TP1, no FSDP")
    checkpoint = NativeCheckpoint.inspect(directory)
    with _LOCK:
        source_sha256 = pins.check("bounded_fp8_load", what="bounded FP8 載入")
        fsdp: Any = importlib.import_module("sglang.multimodal_gen.runtime.loader.fsdp_load")
        original_load = fsdp.load_model_from_full_model_state_dict
        original_process = fsdp.process_model_weights_after_loading
        facts: dict[str, Any] = {"enabled": True, "algorithm": ALGORITHM, "source_sha256": source_sha256}
        processed: set[int] = set()
        called = False
        owner_thread = threading.get_ident()

        def load(*args: Any, **kwargs: Any) -> Any:
            nonlocal called
            if threading.get_ident() != owner_thread:
                return original_load(*args, **kwargs)
            bound = inspect.signature(original_load).bind(*args, **kwargs)
            bound.apply_defaults()
            values = bound.arguments
            model = values["model"]
            iterator = values["full_sd_iterator"]
            if called or type(model).__name__ != "MiniMaxH3DiTModel":
                raise _refuse("unexpected or repeated model load in bounded scope")
            called = True
            if (
                values["checkpoint_load_device"].type != "cpu"
                or values["preconverted_state_dict"] is not None
                or values["allow_device_tensor_assignment"]
                or values["host_spill"] is not None
                or not callable(values["param_names_mapping"])
            ):
                raise _refuse("bounded loader cannot replace this checkpoint placement or mapping")
            try:
                return stream_load(
                    model,
                    checkpoint,
                    mapper=values["param_names_mapping"],
                    original_load=original_load,
                    original_process=original_process,
                    checkpoint_device=values["checkpoint_load_device"],
                    param_dtype=values["param_dtype"],
                    strict=values["strict"],
                    cpu_offload=values["cpu_offload"],
                    facts=facts,
                    processed=processed,
                )
            finally:
                close = getattr(iterator, "close", None)
                if callable(close):
                    close()

        def process(model: Any, *args: Any, **kwargs: Any) -> int:
            if threading.get_ident() != owner_thread:
                return int(original_process(model, *args, **kwargs))
            return int(
                original_process(_ModulesView([m for m in model.modules() if id(m) not in processed]), *args, **kwargs)
            )

        fsdp.load_model_from_full_model_state_dict = load
        fsdp.process_model_weights_after_loading = process
        try:
            yield facts
            if not called or not facts.get("complete"):
                raise _refuse("bounded path was requested but did not complete")
            facts["component_load_complete"] = True
        except BaseException:
            facts["complete"] = False
            facts["component_load_complete"] = False
            raise
        finally:
            fsdp.load_model_from_full_model_state_dict = original_load
            fsdp.process_model_weights_after_loading = original_process
