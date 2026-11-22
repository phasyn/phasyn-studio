"""Place weights of the pinned native Wan denoiser one transformer block at a time."""

from __future__ import annotations

import json
from collections import defaultdict
from contextlib import contextmanager
from importlib import import_module
from pathlib import Path
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from collections.abc import Iterator


_GROUPS = (
    "blocks",
    "audio_injector.injector",
    "audio_injector.injector_adain_layers",
    "audio_injector.injector_pre_norm_feat",
    "face_adapter.fuser_blocks",
)


@contextmanager
def _replace(module: Any, name: str, replacement: Any) -> Iterator[None]:
    # Only executed in the private one-job process. Restore even if construction fails.
    original = getattr(module, name)
    setattr(module, name, replacement)
    try:
        yield
    finally:
        setattr(module, name, original)


def _mapped_t5(**kwargs: Any) -> Any:
    """Instantiate Wan's CPU encoder without allocating its full randomized FP32 weights."""
    torch = import_module("torch")
    native = import_module("wan.modules.t5")
    if kwargs["shard_fn"] is not None or kwargs["device"].type != "cpu":
        raise ValueError("streamed T5 requires a single CPU encoder")
    model = native.umt5_xxl(encoder_only=True, dtype=kwargs["dtype"], device="meta")
    state = torch.load(
        kwargs["checkpoint_path"], mmap=True, map_location="cpu", weights_only=True
    )
    model.load_state_dict(state, assign=True, strict=True)
    model.eval().requires_grad_(requires_grad=False).to(dtype=kwargs["dtype"])
    encoder = native.T5EncoderModel.__new__(native.T5EncoderModel)
    encoder.model = model
    encoder.tokenizer = native.HuggingfaceTokenizer(
        name=kwargs["tokenizer_path"],
        seq_len=kwargs["text_len"],
        clean="whitespace",
    )
    return encoder


class _Checkpoint:
    def __init__(self, root: Path) -> None:
        self.root = root
        index = root / "diffusion_pytorch_model.safetensors.index.json"
        self.shards: dict[str, str] = json.loads(index.read_bytes())["weight_map"]
        if any(
            Path(filename).name != filename or not filename.endswith(".safetensors")
            for filename in self.shards.values()
        ):
            raise ValueError("invalid native checkpoint index")

    def tensors(self, names: list[str]) -> Iterator[tuple[str, Any]]:
        by_shard: dict[str, list[str]] = defaultdict(list)
        for name in names:
            by_shard[self.shards[name]].append(name)
        safe_open = import_module("safetensors").safe_open
        for shard, keys in by_shard.items():
            with safe_open(self.root / shard, framework="pt", device="cpu") as handle:
                for name in keys:
                    yield name, handle.get_tensor(name)


class _WeightGroup:
    """Keep only the active group's tensors live on the GPU."""

    def __init__(self, model: Any, checkpoint: _Checkpoint, device: Any) -> None:
        self.model = model
        self.checkpoint = checkpoint
        self.device = device
        self.cpu: dict[str, Any] = {}
        self.from_disk: list[str] = []
        self.names: list[str] = []
        self.put = import_module("accelerate.utils").set_module_tensor_to_device

    def install(self, module: Any) -> None:
        if self.names:
            module.register_forward_pre_hook(self.onload)
            module.register_forward_hook(self.offload, always_call=True)
            self.offload()

    def onload(self, *_args: Any) -> None:
        for name, tensor in self.cpu.items():
            self.put(self.model, name, self.device, value=tensor)
        for name, tensor in self.checkpoint.tensors(self.from_disk):
            self.put(self.model, name, self.device, value=tensor)

    def offload(self, *_args: Any) -> None:
        for name in self.names:
            self.put(self.model, name, "meta")


def _groups(
    model: Any, checkpoint: _Checkpoint, device: Any
) -> dict[str, _WeightGroup]:
    group_names = [""]
    for name, module in model.named_modules():
        if name in _GROUPS:
            group_names.extend(f"{name}.{index}" for index in range(len(module)))
    if not any(name.startswith("blocks.") for name in group_names):
        raise ValueError("no native transformer blocks")
    return {name: _WeightGroup(model, checkpoint, device) for name in group_names}


def _group_for(name: str, groups: dict[str, _WeightGroup]) -> _WeightGroup:
    prefix = name.rpartition(".")[0]
    while prefix and prefix not in groups:
        prefix = prefix.rpartition(".")[0]
    return groups[prefix]


def attach_blocks(model: Any, root: Path, device: Any, mode: str) -> None:
    """Attach weight-only hooks while leaving native activation arguments and metadata intact."""
    checkpoint = _Checkpoint(root)
    state = model.state_dict(keep_vars=True)
    if set(checkpoint.shards) != set(state) or mode not in (
        "disk_blocks",
        "cpu_blocks",
    ):
        raise ValueError("checkpoint and native module parameter inventories differ")
    groups = _groups(model, checkpoint, device)
    for name, parameter in state.items():
        group = _group_for(name, groups)
        group.names.append(name)
        if mode == "disk_blocks":
            group.from_disk.append(name)
        else:
            group.cpu[name] = parameter.detach()
    for name, buffer in model.named_buffers():
        if name in state:
            continue
        group = _group_for(name, groups)
        group.names.append(name)
        group.cpu[name] = buffer.detach()
    for name, group in groups.items():
        group.install(model.get_submodule(name))


class _StreamedDenoiser:
    """Satisfy Wan's per-segment device moves while the hooks own tensor placement."""

    def __init__(self, model: Any, device: Any) -> None:
        self.model = model
        self.device = device

    def to(self, device: Any) -> _StreamedDenoiser:
        """Accept Wan's request to begin a CUDA segment."""
        if device != self.device:
            raise ValueError("unexpected streamed denoiser device")
        return self

    def cpu(self) -> _StreamedDenoiser:
        """Weights have already been released by post-forward hooks."""
        return self

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.model(*args, **kwargs)


def construct(constructor: Any, mode: str, kwargs: dict[str, Any]) -> Any:
    """Use the native pipeline, VAE, conditioning, solver and weights with a streamed DiT."""
    native = import_module(constructor.__module__)
    name = "WanModel_S2V" if constructor.__name__ == "WanS2V" else "WanAnimateModel"
    cls = getattr(native, name)
    root = Path(kwargs["checkpoint_dir"])

    class LocalDenoiser:
        @staticmethod
        def from_pretrained(path: str, *, torch_dtype: Any, device_map: Any) -> Any:
            if Path(path) != root or device_map.type != "cuda":
                raise ValueError("unexpected native placement")
            if mode == "cpu_blocks":
                return cls.from_pretrained(
                    path,
                    torch_dtype=torch_dtype,
                    low_cpu_mem_usage=True,
                    local_files_only=True,
                    use_safetensors=True,
                )
            # Allocate only module structure and derived buffers. Disk hooks read the
            # verified original shards directly on demand without a second scratch copy.
            with import_module("accelerate").init_empty_weights(include_buffers=False):
                return cls.from_config(cls.load_config(path)).to(dtype=torch_dtype)

    with (
        _replace(native, name, LocalDenoiser),
        _replace(native, "T5EncoderModel", _mapped_t5),
    ):
        pipeline = constructor(**kwargs)
    attach_blocks(pipeline.noise_model, root, pipeline.device, mode)
    pipeline.noise_model = _StreamedDenoiser(pipeline.noise_model, pipeline.device)
    return pipeline
