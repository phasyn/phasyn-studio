"""Run the verified 3B SeedVR2 standalone engine in its own supervised process."""

from __future__ import annotations

import ctypes
import hashlib
import os
import signal
import stat
import sys
from importlib import import_module
from pathlib import Path
from types import ModuleType
from typing import Any

from . import sources


_DIT = "seedvr2_ema_3b.pth"
_VAE = "ema_vae.pth"
# Sorted relative paths, each followed by NUL and its binary SHA-256, for the
# exact import tree emitted by sources.unpack_engine at revision 4490bd1.
_ENGINE_TREE = "fb2bf73fb27d3b93ab3b93384df5fee4e0e1b260a65820cebe630fed59dc8019"
_ENGINE_MAX_FILES = 93
_ENGINE_MAX_FILE_BYTES = 656_540
_PR_SET_PDEATHSIG = 1


def _bind_parent() -> None:
    parent = int(os.environ["PHASYN_SEEDVR_PARENT_PID"])
    if not sys.platform.startswith("linux") or not sys.flags.isolated:
        raise RuntimeError("SeedVR2 requires an isolated Linux interpreter")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(_PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot bind SeedVR2 runner to its parent")
    # The parent could have exited just before prctl installed the signal.
    if os.getppid() != parent:
        raise RuntimeError("SeedVR2 parent process is gone")


def _verify_tree(engine: Path) -> None:
    if engine.resolve(strict=True) != engine:
        raise ValueError("Unexpected SeedVR2 engine directory")
    members: list[tuple[str, bytes]] = []
    for directory, folders, files in engine.walk():
        if any((directory / child).is_symlink() for child in folders):
            raise ValueError("Link in SeedVR2 engine")
        for name in files:
            member = directory / name
            fd = os.open(member, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(fd)
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_nlink != 1
                    or info.st_size > _ENGINE_MAX_FILE_BYTES
                    or len(members) >= _ENGINE_MAX_FILES
                ):
                    raise ValueError("Unexpected SeedVR2 engine member")
                digest = hashlib.sha256(
                    stream.read(_ENGINE_MAX_FILE_BYTES + 1)
                ).digest()
            members.append((member.relative_to(engine).as_posix(), digest))
    aggregate = hashlib.sha256()
    for path, digest in sorted(members):
        aggregate.update(path.encode() + b"\x00" + digest)
    if aggregate.hexdigest() != _ENGINE_TREE:
        raise ValueError("SeedVR2 engine content differs from pinned archive")


def _offline(event: str, args: tuple[Any, ...]) -> None:
    if event in {"socket.getaddrinfo", "socket.gethostbyname", "urllib.Request"} or (
        event in {"socket.connect", "socket.sendto"} and isinstance(args[-1], tuple)
    ):
        raise PermissionError("Network access is disabled for SeedVR2")


class _LocalCheckpoints:
    """Provide the pinned standalone engine with verified local model callbacks."""

    def __init__(self, root: Path, torch: ModuleType) -> None:
        self.root = root
        self.torch = torch

    def _load(self, name: str) -> Any:
        with sources.verified_checkpoint(self.root, name) as stream:
            # mmap requires a pathname. procfs reopens the inode we just hashed,
            # including if the checkpoint filename is replaced during the load.
            return self.torch.load(
                f"/proc/self/fd/{stream.fileno()}",
                map_location="cpu",
                weights_only=True,
                mmap=True,
            )

    def embeddings(
        self, script_directory: str, device: Any, dtype: Any, debug: Any = None
    ) -> dict[str, list[Any]]:
        del script_directory, debug
        return {
            "texts_pos": [self._load("pos_emb.pt").to(device=device, dtype=dtype)],
            "texts_neg": [self._load("neg_emb.pt").to(device=device, dtype=dtype)],
        }

    def find_model(self, filename: str, fallback_dir: str | None = None) -> str:
        if filename not in {_DIT, _VAE} or fallback_dir != str(self.root):
            raise ValueError("Unexpected SeedVR2 model selection")
        return str(self.root / filename)

    def available(
        self, dit_model: str, vae_model: str, model_dir: str, debug: Any = None
    ) -> bool:
        del debug
        return (dit_model, vae_model, model_dir) == (_DIT, _VAE, str(self.root))

    def read_weights(
        self, checkpoint_path: str, device: Any, debug: Any = None
    ) -> dict[str, Any]:
        del debug
        if device.type != "cpu" or checkpoint_path not in {
            str(self.root / _DIT),
            str(self.root / _VAE),
        }:
            raise ValueError("SeedVR2 requires the verified CPU-offloaded checkpoints")
        state: dict[Any, Any] = self._load(Path(checkpoint_path).name)
        for key, value in state.items():
            if not isinstance(key, str) or not self.torch.is_tensor(value):
                raise ValueError("Unexpected SeedVR2 checkpoint entry")
            if value.is_floating_point():
                state[key] = value.to(self.torch.float16)
        return state


def _apply_weights(model: Any, state: dict[str, Any], *_materialization: Any) -> Any:
    expected = model.state_dict()
    if expected.keys() != state.keys():
        raise ValueError("SeedVR2 inference parameters do not match the checkpoint")
    if any(value.shape != expected[name].shape for name, value in state.items()):
        raise ValueError("SeedVR2 inference tensor shape mismatch")
    model.load_state_dict(state, strict=True, assign=True)
    return model


def _bind_weights(cli: ModuleType, weights: Path) -> None:
    registry = import_module("src.utils.model_registry")
    config = import_module("src.core.model_configuration")
    loader = import_module("src.core.model_loader")
    checkpoints = _LocalCheckpoints(weights, import_module("torch"))

    registry.MODEL_REGISTRY.clear()
    registry.MODEL_REGISTRY[_DIT] = registry.ModelInfo(size="3B", precision="fp16")
    registry.MODEL_REGISTRY[_VAE] = registry.ModelInfo(category="vae", precision="fp16")
    _replace(registry, DEFAULT_DIT=_DIT, DEFAULT_VAE=_VAE)
    _replace(
        cli,
        DEFAULT_DIT=_DIT,
        DEFAULT_VAE=_VAE,
        get_available_dit_models=lambda: [_DIT],
        download_weight=checkpoints.available,
        load_text_embeddings=checkpoints.embeddings,
    )
    _replace(config, find_model_file=checkpoints.find_model)
    _replace(
        loader,
        load_quantized_state_dict=checkpoints.read_weights,
        _load_standard_weights=_apply_weights,
    )


def _replace(module: ModuleType, **bindings: Any) -> None:
    if bindings.keys() - vars(module).keys():
        raise RuntimeError(
            "Installed SeedVR2 engine does not match its pinned interface"
        )
    vars(module).update(bindings)


def main() -> None:
    """Restore the selected video using one GPU and the verified 3B checkpoint."""
    _bind_parent()
    engine_arg, weights_arg, input_arg, output_arg, short_side, seed = sys.argv[1:]
    engine, weights = Path(engine_arg).absolute(), Path(weights_arg).absolute()
    _verify_tree(engine)
    os.environ.update(
        HF_HUB_OFFLINE="1",
        TRANSFORMERS_OFFLINE="1",
        TORCH_FORCE_WEIGHTS_ONLY_LOAD="1",
    )
    sys.addaudithook(_offline)
    sys.dont_write_bytecode = True
    sys.pycache_prefix = "/dev/null"
    sys.path.insert(0, str(engine))
    sys.argv = [
        "seedvr2",
        input_arg,
        "--output",
        output_arg,
        "--output_format",
        "mp4",
        "--video_backend",
        "ffmpeg",
        "--model_dir",
        str(weights),
        "--dit_model",
        _DIT,
        "--resolution",
        short_side,
        "--seed",
        seed,
        "--attention_mode",
        "sdpa",
        "--batch_size",
        "5",
        "--blocks_to_swap",
        "32",
        "--swap_io_components",
        "--dit_offload_device",
        "cpu",
        "--vae_offload_device",
        "cpu",
        "--tensor_offload_device",
        "cpu",
        "--vae_encode_tiled",
        "--vae_encode_tile_size",
        "512",
        "--vae_decode_tiled",
        "--vae_decode_tile_size",
        "512",
        "--chunk_size",
        "17",
        "--cache_dit",
        "--cache_vae",
    ]
    cli = import_module("inference_cli")
    _bind_weights(cli, weights)
    # The parent has probed this exact source. A published Node payload need
    # not have a filename extension, which the standalone CLI uses for lookup.
    _replace(
        cli, get_input_type=lambda path: "video" if path == input_arg else "unknown"
    )
    cli.main()


if __name__ == "__main__":
    main()
