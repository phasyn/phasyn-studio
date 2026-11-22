"""Reference-row K/V cache across denoise steps for the H3 Ref2VA DiT (torch; actor only, imported lazily).

``RefKvSession`` serves one ``minimax_h3_denoise_loop`` of ``stages/denoise_av`` when the stage policy carries
``ref_kv_cache`` (option, step plan and sizes: ``recipe/adapter/ref_kv_rules.py``). Nothing here runs when the
option is off: ``denoise_av`` then builds no session and the loop is the loop of today.

Per step (:meth:`RefKvSession.wrap_forward`, the step plan of ``ref_kv_rules.step_plan``):

* ``full`` / ``fill``: the loop's kwargs reach the DiT unchanged. On a fill step every block's attention proxy
  copies the reference rows of the post-RoPE K and V it is handed (``k[r0:r1]``, ``v[r0:r1]``) into that layer's
  cache (BF16, or E4M3 with one absmax scale per head) and then runs the backend unchanged.
* ``skip``: the DiT gets a *reduced* packed sequence, the loop's kwargs with the reference rows [r0, r1) removed:
  text | target audio | target video | padding to 64. Every per-row tensor (AdaLN indices, token tags, RoPE cos/sin,
  positions) is gathered from the full one, the full unique-timestep set is kept (so the AdaLN tables and the
  sidecar slot stay the same), and the embedding layout and output rows are re-indexed. Each block's attention
  proxy attends the reduced queries over [the reduced rows' K/V union the cached reference K/V], in the original key
  order, with the backend's own dense kernel (``impl.forward``: queries shorter than keys). The loop expects the
  reference audio rows in front of the audio velocity and never reads them; they are zeros.

Why the skip path equals "stage 2-lite" ("compute every row, then overwrite the reference rows' K/V with the
cache") for every non-reference row: outside attention each op of the embedding, the 50 blocks and the final
layer is row-wise, so the reference rows reach the other rows only through their K/V, which stage 2-lite replaces
by the cache in every layer (``runtimes/h3/tests/ref_kv_cache_cpu.py`` checks it bit for bit with deterministic
kernels).

Hook points (pinned: ``pins.SOURCES["ref_kv_cache"]``): the reduced kwargs go through the unchanged
``MiniMaxH3DiTModel.forward`` (``minimax_h3.py:2734``), whose ``_embed`` honours ``local_embedding_layout``
(``:2584``, ``:2646``, ``:2691``); ``MiniMaxH3Attention.forward`` calls the attention core (``:1357-1374``), which
hands the post-RoPE q/k/v to ``attention._attention_impl.forward_varlen`` for TORCH_SDPA / FA at SP = 1
(``:928``). The session swaps each DiT block's ``_attention_impl`` for a proxy for the duration of the loop and
puts the original back afterwards, also on failure; the token refiner keeps its own.
"""

from __future__ import annotations

import contextlib
import importlib
import re
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any, TypedDict, Unpack

from phasyn_h3.recipe.adapter import ref_kv_rules as rules

from . import pins
from ._arguments import validate_keywords
from .errors import UnsupportedCombination
from .measure import dit_skip_step_flop, dit_step_flop


class _ReferenceRows(TypedDict):
    seq_len: int
    cu: tuple[int, ...]
    img_pos: Any
    update_mask: Any
    audio_pos: Any
    audio_update_mask: Any
    text_len: int


class _AttentionLengthsRequired(TypedDict):
    cu_seqlens: Any
    max_seqlen: int


class _AttentionLengths(_AttentionLengthsRequired, total=False):
    cu_seqlens_host: tuple[int, ...] | None


class _DispatchLengths(TypedDict):
    cu_seqlens: Any
    max_seqlen: int
    cu_seqlens_host: tuple[int, ...] | None


_CU_BOUNDARIES = 3
_BATCHED_ATTENTION_RANK = 4


PATCH_ID = "ref_kv_cache.v1"
_WHAT = "ref_kv_cache 的略過路徑"  # pins.check message: "… 不同；ref_kv_cache 的略過路徑不套用…"
_DIT_MODULE = "sglang.multimodal_gen.runtime.models.dits.minimax_h3"
_LAYER_RE = re.compile(r"blocks\.(\d+)\.attn")
_HEAD_CHUNK = 8  # heads per FP8 quantize / dequantize pass (bounds the FP32 temporaries to R x 8 x 128 x 4 B)
_SKIP_BACKENDS = (
    "TORCH_SDPA",
    "FA",
)  # backends whose impl.forward takes fewer query rows than key rows
# every key MiniMaxH3DenoiseBranch.static_kwargs holds after the two precomputes (S/denoise_loop.py:273-314,
# S/stages/denoising.py:421-422, 438)
_STATIC_KEYS = frozenset(
    {
        "img_position_ids",
        "update_mask",
        "block_token_tags",
        "skip_mask_out_condition",
        "prompt_embeds",
        "refined_prompt_embeds_length",
        "img_pos_info",
        "audio_pos_info",
        "text_pos_info",
        "img_pos_for_infer_output_info",
        "local_embedding_layout",
        "packed_seq_params",
        "refiner_packed_seq_params",
        "rope_cache",
    }
)
# what forward_kwargs adds per step (S/denoise_loop.py:344-357)
_STEP_KEYS = frozenset(
    {
        "x",
        "audio_x",
        "unique_timesteps",
        "inverse_indices",
        "block_combined_indices",
        "adaln_cache_slot",
    }
)


def _reject(reason: str, message: str, **kwargs: Any) -> UnsupportedCombination:
    return UnsupportedCombination(reason, message, **kwargs)


def _align(rows: int) -> int:
    from sglang.multimodal_gen.configs.models.dits.minimax_h3 import (  # type: ignore[import-untyped]
        MINIMAX_H3_PACKED_SEQUENCE_ALIGNMENT,
    )

    step = int(MINIMAX_H3_PACKED_SEQUENCE_ALIGNMENT)
    return (int(rows) + step - 1) // step * step


@dataclass(frozen=True)
class RowMap:
    """Where the reference rows sit in the packed sequence, and the reduced sequence of a skip step."""

    seq_len: int  # S: packed rows, padding included
    used: int  # U: live rows (cu_seqlens = (0, U, S))
    ref_start: int  # r0: the reference rows are [r0, r1)
    ref_stop: int  # r1
    text_len: int  # text + Qwen vision rows [0, text_len)
    reduced_used: int  # U - R
    reduced_seq_len: int  # U - R padded to the packed alignment (64)
    ref_audio_rows: (
        int  # reference audio rows in front of the target audio rows of audio_pos
    )
    target_video_rows: int
    target_audio_rows: int

    @property
    def ref_rows(self) -> int:
        """Return the packed reference-row indices."""
        return self.ref_stop - self.ref_start

    def as_dict(self) -> dict[str, Any]:
        """Serialize the resolved values used by the runtime."""
        return {
            "seq_len": self.seq_len,
            "used": self.used,
            "ref_rows": [self.ref_start, self.ref_stop],
            "reference": self.ref_rows,
            "text": self.text_len,
            "target_audio": self.target_audio_rows,
            "target_video": self.target_video_rows,
            "reduced_used": self.reduced_used,
            "reduced_seq_len": self.reduced_seq_len,
            "reference_share": round(self.ref_rows / self.used, 6),
        }


def _row_map(**arguments: Unpack[_ReferenceRows]) -> RowMap:
    validate_keywords(arguments, _ReferenceRows)
    seq_len = arguments["seq_len"]
    cu = arguments["cu"]
    img_pos = arguments["img_pos"]
    update_mask = arguments["update_mask"]
    audio_pos = arguments["audio_pos"]
    audio_update_mask = arguments["audio_update_mask"]
    text_len = arguments["text_len"]
    import torch

    if (
        len(cu) != _CU_BOUNDARIES
        or cu[0] != 0
        or cu[2] != seq_len
        or not 0 < cu[1] <= seq_len
    ):
        raise _reject(
            "REF_KV_CACHE_LAYOUT",
            f"packed cu_seqlens 必須是 (0, used, seq_len)，收到 {cu}",
        )
    used = int(cu[1])
    img_pos, audio_pos = img_pos.view(-1).long().cpu(), audio_pos.view(-1).long().cpu()
    update_mask, audio_update_mask = (
        update_mask.view(-1).bool().cpu(),
        audio_update_mask.view(-1).bool().cpu(),
    )
    ref = (
        torch.cat([img_pos[~update_mask], audio_pos[~audio_update_mask]]).sort().values
    )
    refs = int(ref.numel())
    if refs == 0:
        raise _reject(
            "REF_KV_CACHE_NO_REFERENCE",
            "packed 序列沒有參考列（不是 ref2va 的 layout）；ref_kv_cache 無從快取",
        )
    r0, r1 = int(ref[0]), int(ref[-1]) + 1
    if r1 - r0 != refs or int(torch.unique(ref).numel()) != refs:
        raise _reject(
            "REF_KV_CACHE_LAYOUT",
            f"參考列不是一段連續的列（{refs} 列分布在 [{r0}, {r1})）",
        )
    targets = torch.cat([img_pos[update_mask], audio_pos[audio_update_mask]])
    if (
        r0 < int(text_len)
        or r1 > used
        or (targets.numel() and (int(targets.min()) < r1 or int(targets.max()) >= used))
    ):
        raise _reject(
            "REF_KV_CACHE_LAYOUT",
            f"packed 順序不是「文字 | 參考列 | 目標列」：text {text_len}、參考 [{r0}, {r1})、used {used}",
        )
    ref_audio = int((~audio_update_mask).sum())
    ref_visual = int((~update_mask).sum())
    # the loop updates update_mask's suffix and reads the audio velocity after the reference rows
    # (S/denoise_loop.py:198-201, 604): both masks must be [False…, True…]
    if bool(audio_update_mask[:ref_audio].any()) or not bool(
        audio_update_mask[ref_audio:].all()
    ):
        raise _reject(
            "REF_KV_CACHE_LAYOUT", "audio_update_mask 不是「參考聲音列在前、目標在後」"
        )
    if bool(update_mask[:ref_visual].any()) or not bool(update_mask[ref_visual:].all()):
        raise _reject(
            "REF_KV_CACHE_LAYOUT", "update_mask 不是「參考畫面列在前、目標在後」"
        )
    reduced_used = used - refs
    return RowMap(
        seq_len=int(seq_len),
        used=used,
        ref_start=r0,
        ref_stop=r1,
        text_len=int(text_len),
        reduced_used=reduced_used,
        reduced_seq_len=_align(reduced_used),
        ref_audio_rows=ref_audio,
        target_video_rows=int(update_mask.sum()),
        target_audio_rows=int(audio_update_mask.sum()),
    )


def row_map_of_branch(positive: Any) -> RowMap:
    """The row map of a ``MiniMaxH3DenoiseBranch`` (what the loop runs)."""
    sk = positive.static_kwargs
    return _row_map(
        seq_len=int(positive.seq_len),
        cu=tuple(int(x) for x in sk["packed_seq_params"]["cu_seqlens_q_host"]),
        img_pos=positive.img_pos,
        update_mask=positive.update_mask,
        audio_pos=positive.audio_pos,
        audio_update_mask=positive.audio_update_mask,
        text_len=int(sk["text_pos_info"]["position_ids"].numel()),
    )


def row_map_of_packed(packed: Mapping[str, Any]) -> RowMap:
    """The row map of a packed layout (``stages.layout.build_packed``), before any branch exists."""
    import torch

    audio_pos = packed["audio_pos"]
    audio_mask = packed.get("audio_update_mask")
    if audio_mask is None:
        audio_mask = torch.ones(int(audio_pos.numel()), dtype=torch.bool)
    return _row_map(
        seq_len=int(packed["seq_len"]),
        cu=tuple(int(x) for x in packed["cu_seqlens"].tolist()),
        img_pos=packed["img_pos"],
        update_mask=packed["update_mask"],
        audio_pos=audio_pos,
        audio_update_mask=audio_mask,
        text_len=int(packed["text_pos"].numel()),
    )


def planned_skip(
    packed: Mapping[str, Any], policy: rules.RefKvCachePolicy, steps: int
) -> tuple[int, int]:
    """``measure.dit_flop(ref_skip=...)`` of a planned run: (reduced rows, skipped steps)."""
    rows = row_map_of_packed(packed)
    return rows.reduced_seq_len, policy.plan(int(steps)).count("skip")


def _quantize_fp8(x32: Any) -> tuple[Any, Any]:
    """E4M3 with one absmax scale per head over (rows, dims) of an FP32 [R, h, D] chunk."""
    import torch

    scale = x32.abs().amax(dim=(0, 2), keepdim=True).clamp_min(1e-30) / rules.FP8_MAX
    return (x32 / scale).clamp_(-rules.FP8_MAX, rules.FP8_MAX).to(
        torch.float8_e4m3fn
    ), scale


class _ImplProxy:
    """Stands in for one DiT block's ``_attention_impl`` while a session is active.

    Only ``forward_varlen`` (what the attention core calls for TORCH_SDPA / FA) goes through the session; every
    other attribute is the real impl's.
    """

    __slots__ = ("_phasyn_impl", "_phasyn_layer", "_phasyn_session")

    def __init__(self, session: RefKvSession, layer: int, impl: Any) -> None:
        self._phasyn_session = session
        self._phasyn_layer = layer
        self._phasyn_impl = impl

    def forward_varlen(
        self, query: Any, key: Any, value: Any, **arguments: Unpack[_AttentionLengths]
    ) -> Any:
        validate_keywords(arguments, _AttentionLengths)
        cu_seqlens = arguments["cu_seqlens"]
        max_seqlen = arguments["max_seqlen"]
        cu_seqlens_host = arguments.get("cu_seqlens_host")
        return self._phasyn_session.attend(
            self._phasyn_layer,
            self._phasyn_impl,
            query,
            key,
            value,
            cu_seqlens=cu_seqlens,
            max_seqlen=max_seqlen,
            cu_seqlens_host=cu_seqlens_host,
        )

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_phasyn_"):
            raise AttributeError(name)
        return getattr(self._phasyn_impl, name)


def _dense(impl: Any, query: Any, key: Any, value: Any) -> Any:
    """One dense segment through the backend's own kernel ([S, H, D] in, [Sq, H, D] out; Sq may be < Sk)."""
    out = impl.forward(query.unsqueeze(0), key.unsqueeze(0), value.unsqueeze(0), None)
    if isinstance(out, tuple):
        out = out[0]
    return out[0] if out.dim() == _BATCHED_ATTENTION_RANK else out


class RefKvSession:
    """The reference-row K/V cache of one denoise loop (see the module docstring).

    Build it after ``prepare_dit_attention`` and the refined-prompt / RoPE precomputes (it reads the bound
    backends and the branch's final static kwargs), run the loop inside :meth:`active` with the forward from
    :meth:`wrap_forward`, then read :meth:`report`.
    """

    def __init__(
        self,
        model: Any,
        positive: Any,
        policy: rules.RefKvCachePolicy,
        *,
        steps: int,
        device: Any,
    ) -> None:
        """Prepare the reference key and value state for this invocation."""
        self.policy = policy
        self.steps = int(steps)
        self.plan = policy.plan(self.steps)
        self.digests = pins.check("ref_kv_cache", what=_WHAT)
        self._check_parallel()
        self.attention = self._dit_attention(model)
        self.backend = min(self._backend_name(a) for a in self.attention)
        if self.backend == "FA":
            self.digests.update(pins.check("ref_kv_cache_fa", what=_WHAT))
        self.rows = row_map_of_branch(positive)
        first = self.attention[0]
        self.layers = len(self.attention)
        self.heads, self.head_dim = int(first.num_heads), int(first.head_dim)
        self.estimate = rules.cache_bytes(
            layers=self.layers,
            ref_rows=self.rows.ref_rows,
            heads=self.heads,
            head_dim=self.head_dim,
            cache_dtype=policy.cache_dtype,
        )
        if (
            policy.max_cache_bytes is not None
            and self.estimate > policy.max_cache_bytes
        ):
            raise _reject(
                "REF_KV_CACHE_OVER_BUDGET",
                f"參考列 K/V 快取估計 {self.estimate} bytes（{self.layers} 層 × K,V × {self.rows.ref_rows} 列 × "
                f"{self.heads} × {self.head_dim} × {policy.cache_dtype}）超過 max_cache_bytes={policy.max_cache_bytes}；"
                "第 0 步前拒絕（cache_dtype 改 fp8、降低參考解析度或調高上限）",
                expected=f"<= {policy.max_cache_bytes}",
                actual=str(self.estimate),
            )
        self.device = device
        self._static: dict[str, Any] | None = None
        self._x: Any = None
        self._ax: Any = None
        if "skip" in self.plan:
            self._prepare_reduced(positive)
        self._cache: dict[int, dict[str, Any]] = {}
        self._stage: dict[
            str, dict[str, Any]
        ] = {}  # cache_device host: device staging entries
        self._filled: set[int] = set()
        self._index_cache: dict[tuple[int, int], tuple[Any, ...]] = {}
        self._kv: tuple[Any, Any] | None = None
        self._kv_dtype: Any = None
        self._active = False
        self._complete = False
        self._phase: str | None = None
        self._calls = 0
        self._order_ok = True
        self.cache_bytes_allocated = 0
        self.counts = {"full": 0, "fill": 0, "skip": 0}

    # ------------------------------------------------------------------ checks
    @staticmethod
    def _check_parallel() -> None:
        from sglang.multimodal_gen.runtime.distributed import get_tp_world_size  # type: ignore[import-untyped]
        from sglang.multimodal_gen.runtime.distributed.parallel_state import (  # type: ignore[import-untyped]
            get_ring_ctx,
            get_ulysses_ctx,
        )

        sizes = (
            int(get_tp_world_size()),
            int(get_ulysses_ctx()[0]),
            int(get_ring_ctx()[0]),
        )
        if sizes != (1, 1, 1):
            raise _reject(
                "REF_KV_CACHE_PARALLEL_UNSUPPORTED",
                f"ref_kv_cache 只支援 TP = Ulysses = Ring = 1（目前 {sizes}）：略過步的列數在各 rank 間不再對齊",
            )

    @staticmethod
    def _backend_name(attention: Any) -> str:
        enum = getattr(attention, "_attention_backend_enum", None)
        return str(getattr(enum, "name", enum))

    def _dit_attention(self, model: Any) -> list[Any]:
        mh = importlib.import_module(_DIT_MODULE)
        if not isinstance(model, mh.MiniMaxH3DiTModel):
            raise _reject(
                "REF_KV_CACHE_MODEL_UNSUPPORTED",
                f"ref_kv_cache 只支援 MiniMaxH3DiTModel，收到 {type(model).__name__}",
            )
        if hasattr(model, "_sglang_cache_dit_adapter"):
            raise _reject(
                "REF_KV_CACHE_MODEL_UNSUPPORTED",
                "Cache-DiT 掛載中（block stack 被替換），ref_kv_cache 不適用",
            )
        out = []
        for index, block in enumerate(model.blocks):
            attn = getattr(block, "attn", None)
            if not isinstance(block, mh.MiniMaxH3DiTBlock) or not isinstance(
                attn, mh.MiniMaxH3Attention
            ):
                raise _reject(
                    "REF_KV_CACHE_MODEL_UNSUPPORTED",
                    f"DiT blocks.{index} 不是 MiniMaxH3DiTBlock",
                )
            if (
                _LAYER_RE.fullmatch(str(attn.prefix)) is None
                or attn.prefix != f"blocks.{index}.attn"
            ):
                raise _reject(
                    "REF_KV_CACHE_MODEL_UNSUPPORTED",
                    f"blocks.{index} 的 attention prefix 是 {attn.prefix}",
                )
            if attn.hybrid is not None or attn._attention_impl is None:
                raise _reject(
                    "REF_KV_CACHE_MODEL_UNSUPPORTED",
                    f"blocks.{index}：VDN hybrid attention 或尚未綁定 backend",
                )
            name = self._backend_name(attn)
            if name not in _SKIP_BACKENDS:
                raise _reject(
                    "REF_KV_CACHE_ATTENTION_UNSUPPORTED",
                    f"blocks.{index} 綁定 {name}；ref_kv_cache skip 只支援 {', '.join(_SKIP_BACKENDS)}"
                    "（Q 比 K 短的 dense 呼叫）",
                    actual=name,
                )
            out.append(attn)
        if not out:
            raise _reject("REF_KV_CACHE_MODEL_UNSUPPORTED", "DiT 沒有 block")
        return out

    # ------------------------------------------------------------------ reduced sequence
    def _prepare_reduced(self, positive: Any) -> None:
        """The skip steps' static kwargs and input buffers (built once; per step only x, audio_x and the timestep indices change)."""
        import torch

        sk = positive.static_kwargs
        unknown = sorted(set(sk) - _STATIC_KEYS)
        missing = sorted(_STATIC_KEYS - set(sk))
        if unknown or missing:
            raise _reject(
                "REF_KV_CACHE_KWARGS_UNKNOWN",
                f"denoise branch 的 static kwargs 與 ref_kv_cache 預期不同（未知 {unknown}，缺 {missing}；"
                "SubBlock mask 或未 precompute 的 rope／prompt 都不支援）",
            )
        rm, dev = self.rows, self.device
        pad = (
            rm.used if rm.seq_len > rm.used else 0
        )  # padding rows copy an original padding row (else text row 0)
        src = torch.cat(
            [
                torch.arange(0, rm.ref_start, dtype=torch.long),
                torch.arange(rm.ref_stop, rm.used, dtype=torch.long),
                torch.full(
                    (rm.reduced_seq_len - rm.reduced_used,), pad, dtype=torch.long
                ),
            ]
        ).to(dev)
        img_full = positive.img_target_seq_idx.to(dev)
        aud_full = positive.audio_target_seq_idx.to(dev)
        img_r, aud_r = img_full - rm.ref_rows, aud_full - rm.ref_rows
        cos_sin, _positions = sk["rope_cache"]
        self._src, self._img_full, self._aud_full, self._img_r, self._aud_r = (
            src,
            img_full,
            aud_full,
            img_r,
            aud_r,
        )
        self._static = {
            "img_position_ids": sk["img_position_ids"].index_select(1, src),
            "update_mask": torch.ones(int(img_r.numel()), dtype=torch.bool, device=dev),
            "block_token_tags": sk["block_token_tags"].index_select(0, src),
            "skip_mask_out_condition": sk["skip_mask_out_condition"],
            "prompt_embeds": sk["prompt_embeds"],
            "refined_prompt_embeds_length": sk["refined_prompt_embeds_length"],
            "img_pos_info": {"position_ids": img_r},
            "audio_pos_info": {"position_ids": aud_r},
            "text_pos_info": sk["text_pos_info"],
            "img_pos_for_infer_output_info": {"position_ids": img_r},
            # S/denoise_loop.py _build_local_embedding_layout for one rank over the reduced rows
            "local_embedding_layout": {
                "text_source_start": 0,
                "text_source_stop": rm.text_len,
                "img_global_ids": img_r,
                "img_row_ids": img_r,
                "audio_global_ids": aud_r,
                "audio_row_ids": aud_r,
            },
            "packed_seq_params": {
                "cu_seqlens_q": torch.tensor(
                    [0, rm.reduced_used, rm.reduced_seq_len],
                    dtype=torch.int32,
                    device=dev,
                ),
                "cu_seqlens_q_host": (0, rm.reduced_used, rm.reduced_seq_len),
                "max_seqlen_q": rm.reduced_used,
            },
            "refiner_packed_seq_params": sk["refiner_packed_seq_params"],
            # row-aligned cos|sin of the kept rows, positions 0..S_r-1 (the CPU path ignores positions)
            "rope_cache": (
                cos_sin.index_select(0, src),
                torch.arange(rm.reduced_seq_len, device=dev, dtype=torch.long),
            ),
        }
        with torch.inference_mode():
            self._x = positive.x_buffer.new_zeros(
                (1, rm.reduced_seq_len, int(positive.x_buffer.shape[-1]))
            )
            self._ax = positive.audio_x_buffer.new_zeros(
                (1, rm.reduced_seq_len, int(positive.audio_x_buffer.shape[-1]))
            )

    def _reduced_kwargs(self, kwargs: Mapping[str, Any]) -> dict[str, Any]:
        unknown = sorted(set(kwargs) - _STATIC_KEYS - _STEP_KEYS)
        if unknown or self._static is None:
            raise _reject(
                "REF_KV_CACHE_KWARGS_UNKNOWN",
                f"denoise loop 傳入 ref_kv_cache 不認得的 kwargs：{unknown}",
            )
        out = dict(self._static)
        self._x[0].index_copy_(
            0, self._img_r, kwargs["x"][0].index_select(0, self._img_full)
        )
        self._ax[0].index_copy_(
            0, self._aud_r, kwargs["audio_x"][0].index_select(0, self._aud_full)
        )
        out["x"], out["audio_x"] = self._x, self._ax
        out["unique_timesteps"] = kwargs[
            "unique_timesteps"
        ]  # the full set: same AdaLN rows and sidecar slot
        inverse, combined = (
            kwargs["inverse_indices"],
            kwargs.get("block_combined_indices"),
        )
        key = (id(inverse), id(combined))
        hit = self._index_cache.get(key)
        if hit is None or hit[0] is not inverse or hit[1] is not combined:
            hit = (
                inverse,
                combined,
                inverse.index_select(0, self._src),
                None if combined is None else combined.index_select(0, self._src),
            )
            self._index_cache[key] = hit
        out["inverse_indices"] = hit[2]
        if hit[3] is not None:
            out["block_combined_indices"] = hit[3]
        if "adaln_cache_slot" in kwargs:
            out["adaln_cache_slot"] = kwargs["adaln_cache_slot"]
        return out

    def _expand(self, out: Any) -> Any:
        """The reduced forward's (video, audio) velocity in the shapes the loop reads (S/denoise_loop.py:599-604)."""
        import torch

        video, audio = out
        rm = self.rows
        if (
            int(video.shape[0]) != rm.target_video_rows
            or int(audio.shape[0]) != rm.target_audio_rows
        ):
            raise _reject(
                "REF_KV_CACHE_OUTPUT_ROWS",
                f"略過步的輸出列數 {tuple(video.shape)}／{tuple(audio.shape)} 與目標列數不符",
            )
        if rm.ref_audio_rows:
            audio = torch.cat(
                (audio.new_zeros((rm.ref_audio_rows, int(audio.shape[-1]))), audio),
                dim=0,
            )
        return video, audio

    # ------------------------------------------------------------------ loop plumbing
    def wrap_forward(
        self, forward: Callable[[Any, dict[str, Any], int], Any]
    ) -> Callable[[Any, dict[str, Any], int], Any]:
        """The loop's ``model_forward``: ``forward`` (Phasyn's own) with the step plan applied around it."""

        def model_forward(model: Any, kwargs: dict[str, Any], step: int) -> Any:
            phase = self._begin(step)
            if phase == "skip":
                kwargs = self._reduced_kwargs(kwargs)
            try:
                out = forward(model, kwargs, step)
            except BaseException:
                self._phase = None
                self._kv = None
                raise
            self._finish(phase, step)
            return self._expand(out) if phase == "skip" else out

        return model_forward

    def _begin(self, step: int) -> str:
        if not self._active:
            raise RuntimeError(
                "RefKvSession.wrap_forward used outside RefKvSession.active()"
            )
        phase = self.plan[step] if 0 <= int(step) < len(self.plan) else "full"
        if phase == "skip" and not self._complete:
            raise _reject(
                "REF_KV_CACHE_EMPTY",
                f"第 {step} 步要略過參考列，但快取沒有填滿（{len(self._filled)}/{self.layers} 層）",
            )
        if phase == "fill":
            self._filled = set()
            self._complete = False
        self._phase, self._calls, self._order_ok = phase, 0, True
        return phase

    def _finish(self, phase: str, step: int) -> None:
        calls, ordered = self._calls, self._order_ok
        self._phase = None
        self._kv = None  # the skip forward's K/V buffers go back to the allocator
        self.counts[phase] += 1
        if phase in ("fill", "skip") and (calls != self.layers or not ordered):
            raise _reject(
                "REF_KV_CACHE_LAYER_CALLS",
                f"第 {step} 步（{phase}）的 DiT attention 呼叫 {calls} 次{'、順序不符' if not ordered else ''}"
                f"（預期 blocks.0..{self.layers - 1} 各一次）",
            )
        if phase == "fill":
            self._complete = len(self._filled) == self.layers
            self.cache_bytes_allocated = max(
                self.cache_bytes_allocated, self._cache_bytes()
            )

    @contextlib.contextmanager
    def active(self) -> Iterator[RefKvSession]:
        """Swap every DiT block's attention impl for the session's proxy for one loop (always restored)."""
        installed: list[tuple[Any, Any]] = []
        try:
            for layer, attn in enumerate(self.attention):
                impl = attn._attention_impl
                attn._attention_impl = _ImplProxy(self, layer, impl)
                installed.append((attn, impl))
            self._active = True
            yield self
        finally:
            self._active = False
            self._phase = None
            for attn, impl in installed:
                attn._attention_impl = impl
            self._kv = None
            self._cache.clear()
            self._stage.clear()
            self._index_cache.clear()
            self._filled = set()
            self._complete = False
            self._static, self._x, self._ax = None, None, None

    # ------------------------------------------------------------------ attention
    def attend(
        self,
        layer: int,
        impl: Any,
        query: Any,
        key: Any,
        value: Any,
        **arguments: Unpack[_DispatchLengths],
    ) -> Any:
        """Apply the attention policy to the current token sequence."""
        validate_keywords(arguments, _DispatchLengths)
        cu_seqlens = arguments["cu_seqlens"]
        max_seqlen = arguments["max_seqlen"]
        cu_seqlens_host = arguments["cu_seqlens_host"]
        phase = self._phase
        if phase is None or phase == "full":
            return impl.forward_varlen(
                query,
                key,
                value,
                cu_seqlens=cu_seqlens,
                max_seqlen=max_seqlen,
                cu_seqlens_host=cu_seqlens_host,
            )
        if layer != self._calls:
            self._order_ok = False
        self._calls += 1
        rm = self.rows
        if phase == "fill":
            if int(query.shape[0]) != rm.seq_len:
                raise _reject(
                    "REF_KV_CACHE_ROWS",
                    f"填快取步的 attention 有 {int(query.shape[0])} 列，預期 {rm.seq_len}",
                )
            self._store(layer, key, value)
            return impl.forward_varlen(
                query,
                key,
                value,
                cu_seqlens=cu_seqlens,
                max_seqlen=max_seqlen,
                cu_seqlens_host=cu_seqlens_host,
            )
        bounds = tuple(int(b) for b in (cu_seqlens_host or ()))
        if int(query.shape[0]) != rm.reduced_seq_len or bounds != (
            0,
            rm.reduced_used,
            rm.reduced_seq_len,
        ):
            raise _reject(
                "REF_KV_CACHE_ROWS",
                f"略過步的 attention 收到 {int(query.shape[0])} 列、分段 {bounds}，預期 "
                f"{(0, rm.reduced_used, rm.reduced_seq_len)}",
            )
        return self._attend_skip(layer, impl, query, key, value)

    def _new_entry(
        self,
        shape: tuple[int, int, int],
        heads: int,
        kv_dtype: Any,
        device: Any,
        *,
        pin: bool,
    ) -> dict[str, Any]:
        """One layer's K/V cache tensors (plus per-head scales for fp8) on ``device``."""
        import torch

        if self.policy.cache_dtype == "bf16":
            return {
                name: torch.empty(shape, dtype=kv_dtype, device=device, pin_memory=pin)
                for name in ("k", "v")
            }
        entry = {
            name: torch.empty(
                shape, dtype=torch.float8_e4m3fn, device=device, pin_memory=pin
            )
            for name in ("k", "v")
        }
        entry.update(
            {
                f"{name}s": torch.empty(
                    (1, heads, 1), dtype=torch.float32, device=device, pin_memory=pin
                )
                for name in ("k", "v")
            }
        )
        return entry

    def _staging(
        self,
        slot: str,
        shape: tuple[int, int, int],
        heads: int,
        kv_dtype: Any,
        device: Any,
    ) -> dict[str, Any]:
        """A reusable device-side entry (cache_device host): one for storing, one for loading."""
        entry = self._stage.get(slot)
        if entry is None:
            entry = self._new_entry(shape, heads, kv_dtype, device, pin=False)
            self._stage[slot] = entry
        return entry

    def _store(self, layer: int, key: Any, value: Any) -> None:
        rm = self.rows
        heads, dim = int(key.shape[1]), int(key.shape[2])
        shape = (rm.ref_rows, heads, dim)
        host = self.policy.cache_device == "host"
        entry = self._cache.get(layer)
        if entry is None:
            # pinned only when the DiT runs on CUDA (pinning needs a CUDA context; the CPU test keeps it pageable)
            entry = self._new_entry(
                shape,
                heads,
                key.dtype,
                "cpu" if host else key.device,
                pin=host and key.device.type == "cuda",
            )
            self._cache[layer] = entry
        # host: quantize into a device staging entry, then one stream-ordered copy per tensor into pinned memory
        dst = (
            self._staging("store", shape, heads, key.dtype, key.device)
            if host
            else entry
        )
        self._kv_dtype = key.dtype
        rows = slice(rm.ref_start, rm.ref_stop)
        for name, tensor in (("k", key), ("v", value)):
            ref = tensor[rows]  # [R, H, D] view of the layer's post-RoPE K or V
            if self.policy.cache_dtype == "bf16":
                dst[name].copy_(ref)
                continue
            for h0 in range(0, heads, _HEAD_CHUNK):
                h1 = min(heads, h0 + _HEAD_CHUNK)
                q8, scale = _quantize_fp8(ref[:, h0:h1].float())
                dst[name][:, h0:h1].copy_(q8)
                dst[f"{name}s"][:, h0:h1].copy_(scale)
        if host:
            for name, tensor in dst.items():
                entry[name].copy_(tensor, non_blocking=True)
        self._filled.add(layer)

    def _device_entry(self, entry: Mapping[str, Any], device: Any) -> Mapping[str, Any]:
        """The layer's entry on ``device``: itself (cache_device gpu) or a staging copy of the pinned host entry."""
        if self.policy.cache_device != "host":
            return entry
        k = entry["k"]
        stage = self._staging(
            "load", tuple(k.shape), int(k.shape[1]), self._kv_dtype, device
        )
        for name, tensor in entry.items():
            stage[name].copy_(tensor, non_blocking=True)
        return stage

    def _load(self, entry: Mapping[str, Any], name: str, dst: Any) -> None:
        """Write the cached reference K or V of one layer into ``dst`` ([R, H, D], the key buffer's slice)."""
        if self.policy.cache_dtype == "bf16":
            dst.copy_(entry[name])
            return
        heads = int(dst.shape[1])
        for h0 in range(0, heads, _HEAD_CHUNK):
            h1 = min(heads, h0 + _HEAD_CHUNK)
            dst[:, h0:h1].copy_(
                (entry[name][:, h0:h1].float() * entry[f"{name}s"][:, h0:h1]).to(
                    dst.dtype
                )
            )

    def _attend_skip(
        self, layer: int, impl: Any, query: Any, key: Any, value: Any
    ) -> Any:
        import torch

        rm = self.rows
        r0, r1, live = rm.ref_start, rm.ref_stop, rm.reduced_used
        heads, dim = int(query.shape[1]), int(query.shape[2])
        if (
            self._kv is None
        ):  # one K and one V buffer per skip forward, rebuilt by every layer
            shape = (rm.used, heads, dim)
            self._kv = (
                torch.empty(shape, dtype=key.dtype, device=key.device),
                torch.empty(shape, dtype=key.dtype, device=key.device),
            )
        entry = self._device_entry(self._cache[layer], key.device)
        for buf, tensor, name in ((self._kv[0], key, "k"), (self._kv[1], value, "v")):
            buf[:r0].copy_(tensor[:r0])  # text and Qwen vision rows
            buf[r1:].copy_(tensor[r0:live])  # target audio and video rows
            self._load(
                entry, name, buf[r0:r1]
            )  # the cached reference rows, in their original place
        out = torch.empty(
            (rm.reduced_seq_len, heads, dim), dtype=query.dtype, device=query.device
        )
        out[:live].copy_(_dense(impl, query[:live], self._kv[0], self._kv[1]))
        if (
            rm.reduced_seq_len > live
        ):  # the padding rows attend among themselves, as in a full forward
            out[live:].copy_(_dense(impl, query[live:], key[live:], value[live:]))
        return out

    def _cache_bytes(self) -> int:
        return sum(
            int(t.numel()) * int(t.element_size())
            for entry in self._cache.values()
            for t in entry.values()
        )

    # ------------------------------------------------------------------ test / report access
    def cached_kv(self, layer: int) -> tuple[Any, Any]:
        """The layer's cached reference K and V as the attention reads them (BF16, dequantized); test access."""
        entry: Mapping[str, Any] = self._cache[layer]
        if self.policy.cache_device == "host":
            entry = self._device_entry(entry, self.device)
        out = []
        for name in ("k", "v"):
            dst = entry[name].new_empty(entry[name].shape, dtype=self._kv_dtype)
            self._load(entry, name, dst)
            out.append(dst)
        return out[0], out[1]

    def flop_skip(self) -> tuple[int, int]:
        """``measure.dit_flop(ref_skip=...)`` of what ran: (reduced rows, skipped forwards)."""
        return self.rows.reduced_seq_len, int(self.counts["skip"])

    def report(self) -> dict[str, Any]:
        """Run facts (deterministic: no timing), for ``REF_KV_CACHE`` and the bundle's acceleration metadata."""
        full = dit_step_flop(self.rows.seq_len)["total_flop"]
        skip = dit_skip_step_flop(self.rows.seq_len, self.rows.reduced_seq_len)[
            "total_flop"
        ]
        n_skip = self.plan.count("skip")
        return {
            "patch": PATCH_ID,
            **self.policy.as_dict(),
            "steps": self.steps,
            "plan": list(self.plan),
            "forwards": dict(self.counts),
            "rows": self.rows.as_dict(),
            "layers": self.layers,
            "heads": self.heads,
            "head_dim": self.head_dim,
            "attention_backend": self.backend,
            "cache_bytes_estimate": self.estimate,
            "cache_bytes_allocated": self.cache_bytes_allocated,
            "kv_buffer_bytes": rules.kv_buffer_bytes(
                used_rows=self.rows.used, heads=self.heads, head_dim=self.head_dim
            ),
            "analytic_flop": {
                "full_step": full,
                "skipped_step": skip,
                "skipped_step_ratio": round(skip / full, 6) if full else None,
                "run_ratio": round(
                    ((self.steps - n_skip) * full + n_skip * skip)
                    / (self.steps * full),
                    6,
                )
                if self.steps and full
                else None,
            },
            "source_sha256": dict(self.digests),
        }

    def warnings(self) -> list[str]:
        """Return the warnings accumulated during execution."""
        out = []
        if "skip" not in self.plan:
            out.append(
                f"ref_kv_cache：這次 {self.steps} 步沒有任何略過步（start_step={self.policy.start_step}，"
                f"refresh {list(self.policy.refresh_steps)}）；結果等同未開啟"
            )
        late = [s for s in self.policy.refresh_steps if s >= self.steps]
        if late:
            out.append(
                f"ref_kv_cache：refresh_steps {late} 超出這次的 {self.steps} 步，沒有作用"
            )
        return out


__all__ = [
    "PATCH_ID",
    "RefKvSession",
    "RowMap",
    "planned_skip",
    "row_map_of_branch",
    "row_map_of_packed",
]
