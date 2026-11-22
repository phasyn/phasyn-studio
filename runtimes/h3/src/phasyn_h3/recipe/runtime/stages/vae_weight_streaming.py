# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/models/vaes/minimax_h3_video_vae/vae_vit.py, _run_fused_transformer_blocks),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Upstream origin: the SGLang code above is itself derived from the MiniMax-H3 video VAE published by MiniMax
# (https://huggingface.co/MiniMaxAI/MiniMax-H3, revision 42ed227ee7df40d41602854ae760620d6eb651fe), whose source
# files carry "SPDX-License-Identifier: Apache-2.0" and are used here under that licence:
#   Ref2VA/video_vae/vae_vit.py:166 ViTBase.forward_transformer_blocks (the decoder-block loop) and
#   Ref2VA/video_vae/klvae.py:278 AutoencoderKL._run_tile_tasks. Original work by MiniMax.
# Modified by the Phasyn Studio authors: the block loop runs one decoder block over every tile of a pass before the next block, with each block's weights streamed into a device slot.
"""Weight-streaming video-VAE decode (``provider_options.weight_streaming`` of ``h3.video_decode``; opt-in).

The MiniMax-H3 video decoder is a 36-block ViT (dim 2048).  Its FP32 weights are 9.69 GB, 36 blocks of
256 MiB, while one decoder call (one 7x16x16-latent tile of one temporal clip, 1797 tokens) needs only
~0.2 GiB of activations.  With the option on, the loader keeps only the decoder *shell* resident
(``post_quant_conv``, ``x_embedder``, suffix tokens, ``norm_out``, ``proj_out``: ~25 MiB) and this module
replaces ``AutoencoderKL._run_tile_tasks`` (``klvae.py:371-390``) for one decode:

* every tile of a pass runs the unchanged ``ViT3DDecoder.forward`` up to ``forward_transformer_blocks``
  (``post_quant_conv``, ``x_embedder``, suffix tokens, RoPE);
* the blocks go through ``slots`` device slots: block j is read from its contiguous checkpoint range
  (``source=nvme``: ``O_DIRECT`` into page-locked staging, no page cache; ``source=pinned_host``: a
  page-locked host copy made once at load) and copied on a side stream into slot ``j % slots`` once the
  compute stream has finished block ``j - slots``; each block is applied to every tile of the pass before
  the next block (layer-major);
* every tile then runs the unchanged ``forward`` after the blocks (``norm_out``, ``proj_out``, unpack).

Per tile the op sequence is the production one — ``vae_vit._run_fused_transformer_blocks`` on CUDA,
``TransformerBlock.forward`` elsewhere, with the same modules, kernels and operands — so only the order
*across* tiles changes, never a value: the FP32 decode is bit-identical to the resident decode.  ``fp16``
holds the four block linears in FP16 like ``prepare_autocast_linear_weights``; each lands as FP32 and is
rounded on the device (round-to-nearest-even, the same rounding as the host cast of the resident recipe).

A block's ``scale2`` is consumed by the *next* block (the fused loop's ``pending_scale``) while its slot may
already be refilled, so all 36 ``scale2`` vectors (288 KiB) stay resident.  The decoder of a streaming
shell refuses ``forward_transformer_blocks`` outside this scope (``WEIGHT_STREAMING_SCOPE_REQUIRED``): it
never silently decodes without its blocks.  Every wrapped or re-stated upstream function is source-pinned
(``pins.py`` groups ``vae_fp32_tile_batch`` and ``vae_weight_streaming``).
"""

from __future__ import annotations

import contextlib
import os
import time
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any, NamedTuple

from .. import pins
from ..errors import UnsupportedCombination
from ..host_store import _register, host_room_bytes
from ..lifecycle import HostMemoryInsufficient


SOURCES = ("nvme", "pinned_host")
PRECISIONS = ("fp32", "fp16")
MIN_SLOTS, MAX_SLOTS = 1, 4
DEFAULT_SLOTS = 2
MAX_TILES_PER_PASS = 4096
BLOCK_PREFIX = "decoder.transformer_blocks."
DIRECT_IO_ALIGN = 4096  # O_DIRECT: buffer address, file offset and length aligned to the logical block size
# the decoder-block linears the fp16 recipe holds in FP16 (vae_vit.ViT3DDecoder.prepare_autocast_linear_weights)
FP16_LINEARS = ("attn.to_qkv", "attn.to_out", "ff.w1", "ff.w2")
STATE_ATTR = "_phasyn_weight_streaming"
CONFIG_KEYS = frozenset({"source", "slots", "precision", "tiles_per_pass"})


def check_sources() -> None:
    """The wrapped and re-stated SGLang functions are the pinned ones, else UPSTREAM_PATCH_SOURCE_MISMATCH."""
    pins.check("vae_fp32_tile_batch", what="weight streaming ")
    pins.check("vae_weight_streaming", what="weight streaming ")


def _invalid(message: str, **kwargs: Any) -> UnsupportedCombination:
    return UnsupportedCombination(
        "WEIGHT_STREAMING_INVALID",
        message,
        field_path="provider_options.weight_streaming",
        **kwargs,
    )


# ---------------------------------------------------------------------------- configuration (torch-free)
@dataclass(frozen=True)
class StreamingConfig:
    """The resolved option (``phasyn_h3.config.weight_streaming_settings`` builds it from provider_options)."""

    source: str = "nvme"
    slots: int = DEFAULT_SLOTS
    precision: str = "fp32"
    tiles_per_pass: int | None = (
        None  # None: every tile of a temporal clip in one weight pass
    )

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> StreamingConfig:
        """Validate the settings supplied for this streaming policy."""
        if not isinstance(raw, Mapping):
            raise _invalid("weight_streaming 必須是 object")
        unknown = sorted(set(raw) - CONFIG_KEYS)
        if unknown:
            raise _invalid(f"weight_streaming 不認得的欄位 {unknown}")
        source = raw.get("source", "nvme")
        slots = raw.get("slots", DEFAULT_SLOTS)
        precision = raw.get("precision", "fp32")
        tiles = raw.get("tiles_per_pass")
        if source not in SOURCES:
            raise _invalid(
                f"weight_streaming.source 必須是 {'／'.join(SOURCES)}", actual=source
            )
        if type(slots) is not int or not MIN_SLOTS <= slots <= MAX_SLOTS:
            raise _invalid(
                f"weight_streaming.slots 必須是 {MIN_SLOTS}..{MAX_SLOTS} 的整數",
                actual=slots,
            )
        if precision not in PRECISIONS:
            raise _invalid(
                f"weight_streaming.precision 必須是 {'／'.join(PRECISIONS)}",
                actual=precision,
            )
        if tiles is not None and (
            type(tiles) is not int or not 1 <= tiles <= MAX_TILES_PER_PASS
        ):
            raise _invalid(
                f"weight_streaming.tiles_per_pass 必須是 1..{MAX_TILES_PER_PASS} 的整數或 null",
                actual=tiles,
            )
        return cls(
            source=str(source),
            slots=int(slots),
            precision=str(precision),
            tiles_per_pass=tiles,
        )

    def as_dict(self) -> dict[str, Any]:
        """Serialize the resolved values used by the runtime."""
        return {
            "source": self.source,
            "slots": self.slots,
            "precision": self.precision,
            "tiles_per_pass": self.tiles_per_pass,
        }


# ---------------------------------------------------------------------------- checkpoint layout (torch-free)
@dataclass(frozen=True)
class BlockSpan:
    """One decoder block in the checkpoint: absolute byte range and its tensors in file order."""

    start: int
    end: int
    tensors: tuple[
        tuple[str, tuple[int, ...], int, int], ...
    ]  # (name inside the block, shape, offset, nbytes)

    @property
    def nbytes(self) -> int:
        """Return the size of the represented tensor data in bytes."""
        return self.end - self.start

    def tensor(self, local: str) -> tuple[tuple[int, ...], int, int]:
        """Read the selected tensor from this block."""
        for name, shape, offset, nbytes in self.tensors:
            if name == local:
                return shape, offset, nbytes
        raise KeyError(local)


@dataclass(frozen=True)
class BlockIndex:
    """Index the tensors and sizes of the streamed VAE blocks."""

    path: str
    file_size: int
    blocks: tuple[BlockSpan, ...]
    shell: tuple[
        str, ...
    ]  # tensors of the decode half that are not block tensors (read at load)
    shell_bytes: int

    @property
    def num_blocks(self) -> int:
        """Return the number of indexed blocks."""
        return len(self.blocks)

    @property
    def block_bytes(self) -> int:
        """Return the byte size of the selected VAE block."""
        return sum(b.nbytes for b in self.blocks)

    @property
    def max_block_bytes(self) -> int:
        """Return the largest streamed block size."""
        return max(b.nbytes for b in self.blocks)

    @property
    def local_names(self) -> tuple[str, ...]:
        """Return the names of tensors in the selected block."""
        return tuple(sorted(name for name, *_ in self.blocks[0].tensors))

    def truncated(self, count: int) -> BlockIndex:
        """The first ``count`` blocks only — for equivalence checks against a truncated resident decoder."""
        if not 1 <= count <= self.num_blocks:
            raise ValueError(f"count {count} outside 1..{self.num_blocks}")
        return BlockIndex(
            self.path, self.file_size, self.blocks[:count], self.shell, self.shell_bytes
        )


def block_index(
    path: str | Path, header: Any, *, keep: Iterable[str], num_blocks: int
) -> BlockIndex:
    """Split the decode half's tensors (``keep``) of a safetensors header into the decoder blocks and the shell.

    Refuses (``WEIGHT_STREAMING_LAYOUT``) unless blocks ``0..num_blocks-1`` all exist, hold only F32 tensors, each
    occupy one contiguous byte range (one read per block) and have the same tensor names and shapes.
    """
    base = int(header.data_offset)
    per: dict[int, list[tuple[str, tuple[int, ...], int, int, str]]] = {}
    shell: list[str] = []
    shell_bytes = 0
    for name in keep:
        info = header.tensors[name]
        if not name.startswith(BLOCK_PREFIX):
            shell.append(name)
            shell_bytes += int(info.byte_length)
            continue
        index_text, _, local = name[len(BLOCK_PREFIX) :].partition(".")
        if not index_text.isdigit() or not local:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_LAYOUT",
                f"無法解析的 decoder block tensor 名稱 {name}",
            )
        entry = (
            local,
            tuple(int(d) for d in info.shape),
            base + int(info.start),
            int(info.byte_length),
            info.dtype,
        )
        per.setdefault(int(index_text), []).append(entry)
    if sorted(per) != list(range(num_blocks)):
        raise UnsupportedCombination(
            "WEIGHT_STREAMING_LAYOUT",
            f"checkpoint 的 decoder block 是 {sorted(per)[:3]}…（{len(per)} 個），decoder 設定是 {num_blocks} 層",
            expected=num_blocks,
            actual=len(per),
        )
    blocks: list[BlockSpan] = []
    signature: list[tuple[str, tuple[int, ...]]] | None = None
    for i in range(num_blocks):
        items = sorted(per[i], key=lambda t: t[2])
        not_f32 = sorted(t[0] for t in items if t[4] != "F32")
        if not_f32:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_LAYOUT",
                f"block {i} 的 {not_f32[:3]} 不是 F32（串流只讀 FP32 checkpoint）",
            )
        start, end = items[0][2], items[-1][2] + items[-1][3]
        if sum(t[3] for t in items) != end - start:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_LAYOUT", f"block {i} 在 checkpoint 裡不是連續的一段"
            )
        names = sorted((t[0], t[1]) for t in items)
        if signature is None:
            signature = names
        elif names != signature:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_LAYOUT", f"block {i} 的 tensor 與 block 0 不同"
            )
        blocks.append(
            BlockSpan(start, end, tuple((t[0], t[1], t[2], t[3]) for t in items))
        )
    return BlockIndex(
        str(path),
        int(Path(path).stat().st_size),
        tuple(blocks),
        tuple(sorted(shell)),
        shell_bytes,
    )


# ---------------------------------------------------------------------------- host side
class DirectReader:
    """``O_DIRECT`` reads of checkpoint byte ranges into page-aligned host buffers.

    Nothing goes through the page cache: the reads are not charged to the component's memory and evict nothing (E33d: 9.7 GB per clip in 1.4 s).
    """

    def __init__(self, path: str, file_size: int) -> None:
        """Open the indexed source used for streamed reads."""
        flag = getattr(os, "O_DIRECT", None)
        if flag is None:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_DIRECT_IO_UNAVAILABLE",
                "此平台沒有 O_DIRECT（source=nvme）",
            )
        try:
            self.fd = os.open(path, os.O_RDONLY | flag)
        except OSError as exc:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_DIRECT_IO_UNAVAILABLE",
                f"checkpoint 無法以 O_DIRECT 開啟（{exc.strerror or type(exc).__name__}）；檔案系統不支援時請改 source=pinned_host",
            ) from exc
        self.file_size = int(file_size)
        self.bytes_read = 0
        self.seconds = 0.0

    @staticmethod
    def aligned(start: int, end: int) -> tuple[int, int]:
        """Return the size rounded to the required alignment."""
        a = DIRECT_IO_ALIGN
        return start // a * a, -(-end // a) * a

    @classmethod
    def buffer_bytes(cls, nbytes: int) -> int:
        """Buffer size that holds any ``nbytes`` range at any alignment."""
        return -(-nbytes // DIRECT_IO_ALIGN) * DIRECT_IO_ALIGN + DIRECT_IO_ALIGN

    def read_into(self, start: int, end: int, buf: memoryview) -> int:
        """Read the aligned range around ``[start, end)`` into ``buf`` (page aligned); returns where ``start`` sits."""
        a0, a1 = self.aligned(start, end)
        if len(buf) < a1 - a0:
            raise ValueError(f"buffer of {len(buf)} B cannot hold {a1 - a0} B")
        need = end - a0
        got = 0
        t0 = time.perf_counter()
        while got < need:
            n = os.preadv(self.fd, [buf[got : a1 - a0]], a0 + got)
            if n <= 0:
                raise OSError(
                    f"short O_DIRECT read at byte {a0 + got} of the checkpoint"
                )
            got += n
        self.seconds += time.perf_counter() - t0
        self.bytes_read += got
        return start - a0

    def close(self) -> None:
        """Release the resources owned by this instance."""
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1


def _host_buffer(torch: Any, nbytes: int, *, pin: bool) -> tuple[Any, bool]:
    """A page-aligned uint8 host buffer of ``nbytes``, page-locked with ``cudaHostRegister`` when ``pin``.

    ``torch.empty(..., pin_memory=True)`` would round the request up to a power of two (the caching host
    allocator: a 256 MiB + 8 KiB staging buffer takes 512 MiB, a 9.0 GiB host copy 16 GiB); registering plain
    pages locks exactly what is used, and the registration ends with the storage (``host_store._register``).
    """
    raw = torch.empty(nbytes + DIRECT_IO_ALIGN, dtype=torch.uint8)
    pad = (-int(raw.data_ptr())) % DIRECT_IO_ALIGN
    pinned = bool(pin and _register(raw))
    return raw[pad : pad + nbytes], pinned


def _read_tensor_bytes(path: str, offset: int, nbytes: int) -> bytes:
    """A small buffered read (``scale2`` vectors, the load-time probe)."""
    with Path(path).open("rb", buffering=0) as fh:
        fh.seek(offset)
        data = fh.read(nbytes)
    if len(data) != nbytes:
        raise UnsupportedCombination(
            "WEIGHT_STREAMING_LAYOUT", f"checkpoint 在 {offset} 讀不到 {nbytes} B"
        )
    return data


class WeightStreamingState:
    """What a weight-streaming video VAE keeps between decodes (attached to the module by the loader).

    ``slots``: meta ``TransformerBlock`` templates built by the decoder's own constructor (the first ``slots``
    blocks), materialized on the device for each decode only.  ``source=nvme``: one page-locked staging buffer
    per slot (one block each); ``source=pinned_host``: every block's bytes in one page-locked host buffer.
    """

    def __init__(
        self, *, config: StreamingConfig, index: BlockIndex, slots: list[Any], pin: bool
    ) -> None:
        """Set up the buffers used to stream VAE weights."""
        import torch

        self.config = config
        self.index = index
        self.slots = list(slots)
        self.pin = bool(pin)
        self.reader: DirectReader | None = None
        self.staging: list[Any] = []
        self.store: Any = None
        self.store_offsets: list[int] = []
        self.pinned_bytes = 0
        self.host_bytes = 0
        self.load_seconds = 0.0
        if len(self.slots) != config.slots:
            raise _invalid(f"需要 {config.slots} 個 slot 模板，拿到 {len(self.slots)}")
        self._check_slots(torch)
        started = time.perf_counter()
        try:
            self.scale2 = [self._read_scale2(torch, span) for span in index.blocks]
            self.reader = DirectReader(index.path, index.file_size)
            if config.source == "nvme":
                per = DirectReader.buffer_bytes(index.max_block_bytes)
                self._refuse_host(per * config.slots, "staging")
                for _ in range(config.slots):
                    buf, pinned = _host_buffer(torch, per, pin=self.pin)
                    self.staging.append(buf)
                    self.host_bytes += per
                    self.pinned_bytes += per if pinned else 0
                self._probe(torch)
            else:
                spans = [DirectReader.aligned(b.start, b.end) for b in index.blocks]
                total = sum(a1 - a0 for a0, a1 in spans)
                self._refuse_host(total, "pinned_host")
                self.store, pinned = _host_buffer(torch, total, pin=self.pin)
                self.host_bytes += total
                self.pinned_bytes += total if pinned else 0
                view = memoryview(self.store.numpy())
                offset = 0
                for span, (a0, a1) in zip(index.blocks, spans, strict=True):
                    base = self.reader.read_into(
                        span.start, span.end, view[offset : offset + (a1 - a0)]
                    )
                    self.store_offsets.append(offset + base)
                    offset += a1 - a0
                self._probe(torch)
                self.reader.close()  # the host copy is complete: no further reads
        except BaseException:
            self.close()
            raise
        self.load_seconds = time.perf_counter() - started

    # -- load-time checks
    def _check_slots(self, torch: Any) -> None:
        """Every slot holds exactly one block's tensors (names and shapes) in the dtypes of the precision."""
        want = {name: shape for name, shape, _o, _n in self.index.blocks[0].tensors}
        for k, slot in enumerate(self.slots):
            have = {name: tuple(t.shape) for name, t in _slot_tensors(slot).items()}
            if have != want:
                diff = sorted(set(have) ^ set(want)) or sorted(
                    n for n in want if have.get(n) != want[n]
                )
                raise UnsupportedCombination(
                    "WEIGHT_STREAMING_LAYOUT",
                    f"slot {k} 與 checkpoint block 的 tensor 不同：{diff[:4]}",
                )
            for name, t in _slot_tensors(slot).items():
                half = (
                    self.config.precision == "fp16"
                    and name.rsplit(".", 1)[0] in FP16_LINEARS
                )
                expected = torch.float16 if half else torch.float32
                if t.dtype != expected:
                    raise UnsupportedCombination(
                        "WEIGHT_STREAMING_LAYOUT",
                        f"slot {k} 的 {name} 是 {t.dtype}，{self.config.precision} 需要 {expected}",
                    )

    def _refuse_host(self, nbytes: int, what: str) -> None:
        room = host_room_bytes()
        if room is not None and nbytes > room:
            raise HostMemoryInsufficient(
                "WEIGHT_STREAMING_HOST_MEMORY",
                f"weight_streaming {what} 需要 {nbytes / 2**30:.2f} GiB host 記憶體，可用 {room / 2**30:.2f} GiB",
                expected=nbytes,
                actual=room,
            )

    def _read_scale2(self, torch: Any, span: BlockSpan) -> Any:
        shape, offset, nbytes = span.tensor("scale2")
        data = bytearray(_read_tensor_bytes(self.index.path, offset, nbytes))
        return torch.frombuffer(data, dtype=torch.float32).reshape(shape).clone()

    def _probe(self, torch: Any) -> None:
        """Block 0 read the streaming way equals the same bytes read through the page cache (head and tail)."""
        del torch
        span = self.index.blocks[0]
        got = self.block_bytes(0)
        edge = min(DIRECT_IO_ALIGN, span.nbytes)
        head = bytes(got[:edge].numpy().tobytes())
        tail = bytes(got[span.nbytes - edge :].numpy().tobytes())
        if head != _read_tensor_bytes(
            self.index.path, span.start, edge
        ) or tail != _read_tensor_bytes(self.index.path, span.end - edge, edge):
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_PROBE",
                "O_DIRECT 讀出的 block 0 與一般讀取不同；不串流",
            )

    # -- per-block bytes
    def block_bytes(self, j: int) -> Any:
        """uint8 host view of block j's bytes (``source=nvme``: read into staging ``j % slots`` first)."""
        span = self.index.blocks[j]
        if self.config.source == "pinned_host":
            off = self.store_offsets[j]
            return self.store[off : off + span.nbytes]
        if self.reader is None:
            raise RuntimeError("self.reader is unavailable in this stage")
        buf = self.staging[j % self.config.slots]
        base = self.reader.read_into(span.start, span.end, memoryview(buf.numpy()))
        return buf[base : base + span.nbytes]

    def slot_linear_dtypes(self) -> set[Any]:
        """Dtypes of the four block linears as the slots hold them (``decode_video``'s FP32 check)."""
        out = set()
        for slot in self.slots:
            for name in FP16_LINEARS:
                out.add(slot.get_submodule(name).weight.dtype)
        return out

    def check_precision(self, precision: str) -> None:
        """Validate the precision allowed by the streaming policy."""
        if precision != self.config.precision:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_PRECISION_MISMATCH",
                f"此元件以 weight_streaming.precision={self.config.precision} 載入，stage 要求 {precision}",
                field_path="components.video_vae.compute_dtype",
                expected=self.config.precision,
                actual=precision,
            )

    def host_footprint(self) -> tuple[int, int]:
        """(host, page-locked) bytes held for streaming (staging or the host copy, plus the scale2 vectors)."""
        scale = sum(int(t.numel()) * 4 for t in getattr(self, "scale2", []))
        return self.host_bytes + scale, self.pinned_bytes

    def facts(self) -> dict[str, Any]:
        """Return the observed runtime facts for reporting."""
        return {
            **self.config.as_dict(),
            "blocks": self.index.num_blocks,
            "block_bytes": self.index.block_bytes,
            "max_block_bytes": self.index.max_block_bytes,
            "shell_tensors": len(self.index.shell),
            "shell_bytes": self.index.shell_bytes,
            "host_bytes": self.host_footprint()[0],
            "pinned_bytes": self.pinned_bytes,
            "pin_method": "cuda_host_register" if self.pinned_bytes else "none",
            "direct_io": True,
            "probe": "o_direct_matches_buffered_read",
            "load_seconds": round(self.load_seconds, 6),
            **(
                {"store_read_seconds": round(self.reader.seconds, 6)}
                if self.reader and self.store is not None
                else {}
            ),
        }

    def close(self) -> None:
        """Release the resources owned by this instance."""
        if self.reader is not None:
            self.reader.close()
        self.staging = []
        self.store = None
        self.store_offsets = []
        self.host_bytes = self.pinned_bytes = 0


def _slot_tensors(slot: Any) -> dict[str, Any]:
    return {
        **dict(slot.named_parameters()),
        **{n: b for n, b in slot.named_buffers() if b is not None},
    }


# ---------------------------------------------------------------------------- loader helpers
def detach_blocks(vae: Any, config: StreamingConfig) -> list[Any]:
    """Meta-constructed decode half -> streaming shell: the decoder keeps no blocks; the first ``config.slots`` blocks (built by the decoder's own constructor, still on meta) become the slot templates."""
    import torch

    dec = vae.decoder
    blocks = list(dec.transformer_blocks)
    if len(blocks) < config.slots:
        raise _invalid(f"decoder 只有 {len(blocks)} 層，少於 slots={config.slots}")
    if not all(t.is_meta for b in blocks for t in _slot_tensors(b).values()):
        raise _invalid(
            "weight_streaming 的 decoder 必須以 meta 建構（block 從不在 host 配置）"
        )
    slots = blocks[: config.slots]
    dec.transformer_blocks = torch.nn.ModuleList()
    for slot in slots:
        if config.precision == "fp16":
            for name in FP16_LINEARS:
                slot.get_submodule(name).to(dtype=torch.float16)
        for p in slot.parameters():
            p.requires_grad = False
        slot.eval()
    return slots


@contextlib.contextmanager
def blocks_attached(vae: Any, slots: list[Any]) -> Iterator[None]:
    """The slot templates as the decoder's blocks for a moment (``optimize_vae`` installs the same quality-gated attention forwards on them as on the 36 resident blocks); always detached again."""
    import torch

    dec = vae.decoder
    dec.transformer_blocks = torch.nn.ModuleList(slots)
    try:
        yield
    finally:
        dec.transformer_blocks = torch.nn.ModuleList()


def rebuild_rope_buffers(vae: Any) -> int:
    """The decoder's non-persistent RoPE buffer (``inv_freq``) as the constructor computes it on the host.

    The shell is built on meta, so the buffer the checkpoint does not carry is recomputed with the arguments
    ``ViT3DDecoder.__init__`` passes (``RotaryEmbeddingND(rope_apply_dim, rope_theta, n_dim=3, use_angle=True)``;
    both constructors are source-pinned).
    """
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.base_module import (  # type: ignore[import-untyped]
        RotaryEmbeddingND,
    )

    dec = vae.decoder
    pe = dec.pos_embed
    if not isinstance(pe, RotaryEmbeddingND) or not pe.inv_freq.is_meta:
        return 0
    fresh = RotaryEmbeddingND(
        pe.dim,
        float(dec.config.rope_theta),
        n_dim=pe.n_dim,
        use_angle=pe.angle_scale != 1.0,
    )
    if (
        fresh.inv_freq.dtype != pe.inv_freq.dtype
        or fresh.inv_freq.shape != pe.inv_freq.shape
    ):
        raise UnsupportedCombination(
            "WEIGHT_STREAMING_LAYOUT", "重建的 RoPE inv_freq 與 decoder 宣告的不同"
        )
    pe.inv_freq = fresh.inv_freq
    return 1


def _unstreamed_blocks(*_args: Any, **_kwargs: Any) -> Any:
    raise UnsupportedCombination(
        "WEIGHT_STREAMING_SCOPE_REQUIRED",
        "此 video VAE 以 weight_streaming 載入（decoder block 不常駐）；只能在 decode_video 的權重串流範圍內解碼",
    )


def attach_state(vae: Any, state: WeightStreamingState) -> None:
    """Mark the module as a streaming shell; its decoder refuses to run without the streaming scope."""
    vae.decoder.forward_transformer_blocks = _unstreamed_blocks
    object.__setattr__(vae, STATE_ATTR, state)


def streaming_state(vae: Any) -> WeightStreamingState | None:
    """The streaming state the loader attached, or None for every other (resident) video VAE."""
    state = getattr(vae, STATE_ATTR, None)
    return state if isinstance(state, WeightStreamingState) else None


# ---------------------------------------------------------------------------- device side
class BlockStreamer:
    """Device slots for one decode: block j lands in slot ``j % slots``; ``blocks()`` yields them in order."""

    def __init__(self, state: WeightStreamingState, device: Any) -> None:
        """Prepare the buffers and streams used to load VAE blocks."""
        import torch

        self.torch = torch
        self.state = state
        self.device = torch.device(device)
        self.cuda = self.device.type == "cuda"
        if state.config.precision == "fp16" and not self.cuda:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_PRECISION_MISMATCH",
                "fp16 權重串流只在 CUDA 上（autocast）",
            )
        self.nslots = state.config.slots
        self.passes = 0
        self.h2d_bytes = 0
        self.h2d_submit_seconds = 0.0
        self.read0 = (
            (state.reader.bytes_read, state.reader.seconds)
            if state.reader is not None
            else (0, 0.0)
        )
        self.slots = state.slots
        self.landing: Any = None
        try:
            for slot in self.slots:
                slot.to_empty(device=self.device)
            self.maps = [_slot_tensors(slot) for slot in self.slots]
            self.scale2 = [t.to(self.device) for t in state.scale2]
            if (
                state.config.precision == "fp16"
            ):  # FP32 landing buffer for the on-device rounding of the linears
                largest = max(n for _name, _s, _o, n in state.index.blocks[0].tensors)
                self.landing = torch.empty(
                    largest // 4, dtype=torch.float32, device=self.device
                )
        except (
            BaseException
        ):  # e.g. out of memory for the second slot: no slot keeps device memory
            self.landing = None
            for slot in self.slots:
                slot.to_empty(device="meta")
            raise
        self.copy_stream: Any = torch.cuda.Stream(self.device) if self.cuda else None  # type: ignore[no-untyped-call]
        self.loaded: list[Any] = [None] * self.nslots
        self.free: list[Any] = [None] * self.nslots

    def slot_bytes(self) -> int:
        """Return the byte capacity of a streaming slot."""
        return sum(
            int(t.numel()) * int(t.element_size())
            for m in self.maps
            for t in m.values()
        )

    def _fill(self, j: int) -> None:
        """Bring block j into slot ``j % slots`` (CUDA: on the copy stream, after the slot's previous block)."""
        torch = self.torch
        s = j % self.nslots
        span = self.state.index.blocks[j]
        if self.loaded[s] is not None:
            self.loaded[
                s
            ].synchronize()  # the copy of block j - slots out of staging s has completed
        src_u8 = self.state.block_bytes(j)
        params = self.maps[s]
        stream = (
            torch.cuda.stream(self.copy_stream)
            if self.cuda
            else contextlib.nullcontext()
        )
        with stream:
            if self.cuda and self.free[s] is not None:
                self.copy_stream.wait_event(
                    self.free[s]
                )  # compute of block j - slots has released slot s
            t0 = time.perf_counter()
            for local, shape, offset, nbytes in span.tensors:
                src = (
                    src_u8[offset - span.start : offset - span.start + nbytes]
                    .view(torch.float32)
                    .view(shape)
                )
                dst = params[local]
                if dst.dtype == torch.float32:
                    dst.copy_(src, non_blocking=self.cuda)
                else:  # fp16 linear: land FP32, round on the device (RNE, the host cast's rounding)
                    land = self.landing[: src.numel()].view(shape)
                    land.copy_(src, non_blocking=True)
                    dst.copy_(land)
                self.h2d_bytes += nbytes
            self.h2d_submit_seconds += time.perf_counter() - t0
            if self.cuda:
                event = torch.cuda.Event()
                event.record(self.copy_stream)
                self.loaded[s] = event

    def blocks(self) -> Iterator[tuple[int, Any]]:
        """(index, slot) for every block; the caller enqueues block i's compute before advancing."""
        torch = self.torch
        n = self.state.index.num_blocks
        self.passes += 1
        if not self.cuda:
            for i in range(n):
                self._fill(i)
                yield i, self.slots[i % self.nslots]
            return
        # loaded/free carry over from the previous pass: block 0 of this pass must not overwrite its slot before
        # the previous pass's last block in that slot has finished on the compute stream
        for j in range(min(self.nslots, n)):
            self._fill(j)
        compute = torch.cuda.current_stream(self.device)
        for i in range(n):
            s = i % self.nslots
            compute.wait_event(self.loaded[s])
            yield i, self.slots[s]
            event = torch.cuda.Event()
            event.record(compute)
            self.free[s] = event
            if i + self.nslots < n:
                self._fill(i + self.nslots)

    def close(self) -> None:
        """Wait for both streams, then give the slot memory back (the templates return to meta)."""
        torch = self.torch
        if self.cuda:
            torch.cuda.synchronize(self.device)
        self.maps = []
        self.scale2 = []
        self.landing = None
        self.loaded = [None] * self.nslots
        self.free = [None] * self.nslots
        for slot in self.slots:
            slot.to_empty(device="meta")

    def facts(self) -> dict[str, Any]:
        """Return the observed runtime facts for reporting."""
        reader = self.state.reader
        read = (
            (reader.bytes_read - self.read0[0], reader.seconds - self.read0[1])
            if reader
            else (0, 0.0)
        )
        return {
            "weight_passes": self.passes,
            "weight_bytes_read": int(read[0])
            if self.state.config.source == "nvme"
            else 0,
            "weight_read_seconds": round(float(read[1]), 6)
            if self.state.config.source == "nvme"
            else 0.0,
            "weight_h2d_bytes": int(self.h2d_bytes),
            "weight_h2d_submit_seconds": round(self.h2d_submit_seconds, 6),
        }


class _CapturedError(Exception):
    pass


_CapturedError.__name__ = "_Captured"
_CapturedError.__qualname__ = "_Captured"
_Captured = _CapturedError


class _TileState:
    __slots__ = ("hidden", "pending", "pending_scale", "rope", "z2")

    def __init__(self, z2: Any, hidden: Any, rope: Any) -> None:
        self.z2, self.hidden, self.rope = z2, hidden, rope
        self.pending: Any = None
        self.pending_scale: Any = None


_MISSING = object()


@contextlib.contextmanager
def _blocks_function(dec: Any, fn: Any) -> Iterator[None]:
    """``fn`` as the decoder's ``forward_transformer_blocks`` for one call; the previous one (the shell's refusal) comes back afterwards."""
    saved = dec.__dict__.get("forward_transformer_blocks", _MISSING)
    dec.forward_transformer_blocks = fn
    try:
        yield
    finally:
        if saved is _MISSING:
            del dec.forward_transformer_blocks
        else:
            dec.forward_transformer_blocks = saved


class _TileTaskOptions(NamedTuple):
    stack_tiling: bool
    cls_agg: Any = None


class LayerMajorTiles:
    """Replacement for ``AutoencoderKL._run_tile_tasks(tiles, idx, self.decode, stack_tiling)`` (klvae.py:371-390, called by ``tiled_decode``): ``tiles_per_pass`` tiles (all of a clip by default) per weight pass."""

    def __init__(
        self, vae: Any, streamer: BlockStreamer, tiles_per_pass: int | None
    ) -> None:
        """Arrange tiles for layer-major execution."""
        self.vae = vae
        self.dec = vae.decoder
        self.streamer = streamer
        self.tiles_per_pass = tiles_per_pass
        self.decode_fn = type(vae).decode
        self.calls = 0
        self.tiles = 0
        self.fused: bool | None = None

    def _prologue(self, z2: Any) -> tuple[Any, Any]:
        """``ViT3DDecoder.forward`` up to its blocks (unchanged code): the block input and the rotary table."""
        box: dict[str, Any] = {}

        def capture(hidden_states: Any, rotary_pos_emb: Any) -> Any:
            box["hidden"], box["rope"] = hidden_states, rotary_pos_emb
            raise _Captured

        with _blocks_function(self.dec, capture), contextlib.suppress(_Captured):
            self.dec(z2)
        return box["hidden"], box["rope"]

    def _epilogue(self, z2: Any, hidden: Any) -> Any:
        """``ViT3DDecoder.forward`` with the blocks' result in place of ``forward_transformer_blocks`` (unchanged code)."""
        with _blocks_function(self.dec, lambda _hidden_states, _rotary_pos_emb: hidden):
            return self.dec(z2)

    def _run_pass(self, states: list[_TileState]) -> None:
        from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae import (  # type: ignore[import-untyped]
            base_module,
            vae_vit,
        )

        fused = bool(
            vae_vit._fused_blocks_available(self.streamer.slots, states[0].hidden)
        )
        self.fused = fused if self.fused is None else (self.fused and fused)
        fused_ops = import_module("sglang.kernels.ops.diffusion") if fused else None
        for i, blk in self.streamer.blocks():
            for st in states:
                if (
                    fused_ops is None
                ):  # ViTBase.forward_transformer_blocks, unfused loop
                    st.hidden = blk(st.hidden, st.rope)
                    continue
                # vae_vit._run_fused_transformer_blocks, one block at a time
                if st.pending is None:
                    normed = fused_ops.h3_vae_rmsnorm(
                        st.hidden, blk.norm1.weight, blk.norm1.eps
                    )
                else:
                    st.hidden, normed = fused_ops.h3_vae_scale_add_rmsnorm(
                        st.hidden,
                        st.pending,
                        st.pending_scale,
                        blk.norm1.weight,
                        blk.norm1.eps,
                    )
                attn_output = blk.attn(normed, st.rope)
                del normed
                st.hidden, normed = fused_ops.h3_vae_scale_add_rmsnorm(
                    st.hidden, attn_output, blk.scale1, blk.norm2.weight, blk.norm2.eps
                )
                del attn_output
                st.pending = blk.ff(normed)
                del normed
                st.pending_scale = self.streamer.scale2[i]
        if fused:
            for st in states:
                st.hidden = base_module._scaled_residual_add(
                    st.hidden, st.pending, st.pending_scale
                )
                st.pending = st.pending_scale = None

    def __call__(
        self,
        tiles: Any,
        tile_indices: Any,
        forward_fn: Any,
        *tile_settings: Any,
        **tile_options: Any,
    ) -> Any:
        """Apply the layer to the grouped VAE tiles."""
        stack_tiling, cls_agg = _TileTaskOptions(*tile_settings, **tile_options)
        if cls_agg is not None or stack_tiling:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_STACK_TILING",
                "權重串流只取代未堆疊的 tile 解碼（stack_tiling=False、無 cls 聚合）",
            )
        if getattr(forward_fn, "__func__", None) is not self.decode_fn:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_FORWARD", "權重串流只取代 tiled_decode 的 self.decode"
            )
        self.calls += 1
        outputs: list[Any] = []
        indices = list(tile_indices)
        group = self.tiles_per_pass or max(1, len(indices))
        for g0 in range(0, len(indices), group):
            states = []
            for idx in indices[g0 : g0 + group]:
                z2 = self.vae.post_quant_conv(
                    tiles[idx]
                )  # AutoencoderKLLegacy.decode, first line
                hidden, rope = self._prologue(z2)
                states.append(_TileState(z2, hidden, rope))
            self._run_pass(states)
            for st in states:
                outputs.append(self._epilogue(st.z2, st.hidden))
                st.z2 = st.hidden = st.rope = None
            self.tiles += len(states)
            del states
        return outputs


@contextlib.contextmanager
def weight_streaming_scope(
    vae: Any, *, device: Any, precision: str
) -> Iterator[dict[str, Any]]:
    """Scope one decode of a streaming shell: slots on the device, ``_run_tile_tasks`` replaced; always restores.

    Yields the facts dict, completed when the scope ends (passes, bytes read and copied, device peaks).
    """
    import torch
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.klvae import (  # type: ignore[import-untyped]
        _resolve_temporal_stream_cat,
    )

    state = streaming_state(vae)
    if state is None:
        raise UnsupportedCombination(
            "WEIGHT_STREAMING_NOT_LOADED", "此 video VAE 不是以 weight_streaming 載入的"
        )
    check_sources()
    state.check_precision(precision)
    if "_run_tile_tasks" in vae.__dict__:
        raise UnsupportedCombination(
            "WEIGHT_STREAMING_CONFLICT",
            "_run_tile_tasks 已被另一個包裝取代（tile batching？）",
        )
    if not getattr(vae, "decoder_tiling", False) or getattr(vae, "stack_tiling", False):
        raise UnsupportedCombination(
            "WEIGHT_STREAMING_STACK_TILING",
            "權重串流需要 decoder_tiling=True、stack_tiling=False（逐 tile 解碼）",
        )
    if vae.training or not _resolve_temporal_stream_cat():
        raise UnsupportedCombination(
            "WEIGHT_STREAMING_TEMPORAL",
            "權重串流需要串流的時間解碼（MINIMAX_H3_VAE_DECODER_STREAM_TEMPORAL_CAT=1）",
        )
    facts: dict[str, Any] = {**state.config.as_dict(), "blocks": state.index.num_blocks}
    streamer = BlockStreamer(
        state, device
    )  # gives every slot back to meta itself if it cannot be built
    try:
        runner = LayerMajorTiles(vae, streamer, state.config.tiles_per_pass)
        facts["device_slot_bytes"] = streamer.slot_bytes()
        vae._run_tile_tasks = runner
        yield facts
        facts.update(
            {
                "tile_calls": runner.calls,
                "tiles": runner.tiles,
                "fused_norm_path": runner.fused,
            }
        )
    finally:
        vae.__dict__.pop("_run_tile_tasks", None)
        streamer.close()
        facts.update(streamer.facts())
        if streamer.cuda:
            facts["peak_allocated_bytes"] = int(
                torch.cuda.max_memory_allocated(streamer.device)
            )
            facts["peak_reserved_bytes"] = int(
                torch.cuda.max_memory_reserved(streamer.device)
            )


__all__ = [
    "BLOCK_PREFIX",
    "DEFAULT_SLOTS",
    "FP16_LINEARS",
    "MAX_SLOTS",
    "MIN_SLOTS",
    "PRECISIONS",
    "SOURCES",
    "STATE_ATTR",
    "BlockIndex",
    "BlockSpan",
    "BlockStreamer",
    "DirectReader",
    "LayerMajorTiles",
    "StreamingConfig",
    "WeightStreamingState",
    "attach_state",
    "block_index",
    "blocks_attached",
    "check_sources",
    "detach_blocks",
    "rebuild_rope_buffers",
    "streaming_state",
    "weight_streaming_scope",
]
