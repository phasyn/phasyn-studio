"""Normalized Attention Guidance on the H3 DiT (torch; actor only, imported lazily by ``stages/denoise_av``).

``NagSession`` serves one ``minimax_h3_denoise_loop`` when the stage carries the ``nag`` option (rules, layout and
formula: ``nag_rules``). Nothing here runs when the option is off.

On a NAG step (:meth:`NagSession.wrap_forward`) the DiT gets the *extended* packed sequence of
``nag_rules.row_plan``: the loop's kwargs with the negative text rows appended after the live rows. Every per-row
tensor (positions, RoPE cos/sin, token tags, AdaLN indices) is gathered from the positive one, the unique
timesteps and the AdaLN cache slot are the loop's own (a fixed AdaLN sidecar is read exactly as without NAG), and
the embedding layout and output rows are unchanged (the negative rows sit after every row the loop reads). The
negative text embedding (refined once per loop by the DiT's own token refiner) is written into its rows by a
wrapper on ``model._embed``. Each block's attention impl is swapped for a proxy that runs the positive, negative
and padding segments of the same q/k/v through the backend's own ``forward_varlen`` and mixes the target video
rows with ``nag_rules.nag_combine``. Steps after ``nag.steps`` pass the loop's kwargs through untouched.

The proxies and the ``_embed`` wrapper exist only inside :meth:`NagSession.active` and are removed afterwards,
also on failure (the ``ref_kv_cache`` pattern).
"""

from __future__ import annotations

import contextlib
import importlib
from collections.abc import Callable, Iterator, Mapping
from typing import Any, NamedTuple, TypedDict, Unpack

from . import nag_rules as rules, pins
from ._arguments import validate_keywords
from .errors import UnsupportedCombination
from .measure import DIT_ATTN_DIM
from .ref_kv_cache import _STATIC_KEYS, _STEP_KEYS


class _AttentionLengthsRequired(TypedDict):
    cu_seqlens: Any
    max_seqlen: int


class _AttentionLengths(_AttentionLengthsRequired, total=False):
    cu_seqlens_host: tuple[int, ...] | None


class _GuidanceInputs(TypedDict):
    negative_hidden: Any
    negative_tags: Any
    positive_text_tags: Any
    steps: int
    device: Any


class _DispatchLengths(TypedDict):
    cu_seqlens: Any
    max_seqlen: int
    cu_seqlens_host: tuple[int, ...] | None


_CU_BOUNDARIES = 3


PATCH_ID = "nag.v1"
_WHAT = "NAG（Normalized Attention Guidance）"
_DIT_MODULE = "sglang.multimodal_gen.runtime.models.dits.minimax_h3"
_COMBINE_ROWS = (
    4096  # rows per FP32 combine chunk (4096 x 7168 x 4 B = 117 MB per temporary)
)


def _reject(reason: str, message: str, **kwargs: Any) -> UnsupportedCombination:
    return UnsupportedCombination(reason, message, **kwargs)


class _NagImpl:
    """Stands in for one DiT block's ``_attention_impl``: only ``forward_varlen`` goes through the session."""

    __slots__ = ("_phasyn_impl", "_phasyn_layer", "_phasyn_session")

    def __init__(self, session: NagSession, layer: int, impl: Any) -> None:
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


class _SegmentRows(NamedTuple):
    start: int
    stop: int


def _segment(
    impl: Any, query: Any, key: Any, value: Any, *bounds: int, **named_bounds: int
) -> Any:
    """Rows [start, stop) as one dense varlen document through the backend's own kernel."""
    import torch

    start, stop = _SegmentRows(*bounds, **named_bounds)
    n = stop - start
    cu = torch.tensor([0, n], dtype=torch.int32, device=query.device)
    return impl.forward_varlen(
        query[start:stop],
        key[start:stop],
        value[start:stop],
        cu_seqlens=cu,
        max_seqlen=n,
        cu_seqlens_host=(0, n),
    )


class NagSession:
    """NAG for one denoise loop.

    Build it after ``prepare_dit_attention`` and both precomputes; run the loop inside :meth:`active` with the forward from :meth:`wrap_forward`, then read :meth:`report`.
    """

    def __init__(
        self,
        model: Any,
        positive: Any,
        nag: rules.Nag,
        **arguments: Unpack[_GuidanceInputs],
    ) -> None:
        """Prepare the negative-guidance state for this invocation."""
        validate_keywords(arguments, _GuidanceInputs)
        negative_hidden = arguments["negative_hidden"]
        negative_tags = arguments["negative_tags"]
        positive_text_tags = arguments["positive_text_tags"]
        steps = arguments["steps"]
        device = arguments["device"]
        import torch
        from sglang.multimodal_gen.configs.models.dits.minimax_h3 import (  # type: ignore[import-untyped]
            MINIMAX_H3_PACKED_SEQUENCE_ALIGNMENT,
        )

        self.nag = nag
        self.steps = int(steps)
        self.digests = pins.check("nag", what=_WHAT)
        self._check_parallel()
        self.attention = self._dit_attention(model)
        self.layers = len(self.attention)
        self.model = model
        self.device = device
        sk, cu, seq_len, text_len = _positive_layout(positive)
        self.rows = rules.row_plan(
            text_len=text_len,
            used=cu[1],
            seq_len=seq_len,
            positive_text_tags=[int(t) for t in positive_text_tags.view(-1).tolist()],
            negative_text_tags=[int(t) for t in negative_tags.view(-1).tolist()],
            align=int(MINIMAX_H3_PACKED_SEQUENCE_ALIGNMENT),
        )
        rm = self.rows
        # the rows that get the guidance: the target video rows (global positions, all in [text_len, used))
        guided = positive.img_target_seq_idx.view(-1).long().to(device)
        if guided.numel() and (
            int(guided.min()) < rm.text_len or int(guided.max()) >= rm.used
        ):
            raise _reject("NAG_LAYOUT", "目標影片列不在 [text, used) 之內")
        self._guided = guided
        self._guided_neg = (
            guided - rm.text_len
        )  # the same rows inside the negative segment's output
        with torch.inference_mode():
            self.negative_embed = model.refine_prompt_embeds(
                negative_hidden.to(device),
                torch.tensor([0, rm.neg_len], dtype=torch.int32, device=device),
                device=device,
            )
        if int(self.negative_embed.shape[0]) != rm.neg_len:
            raise _reject(
                "NAG_LAYOUT",
                f"負面文字 refine 後 {int(self.negative_embed.shape[0])} 列，預期 {rm.neg_len}",
            )
        pos_src = torch.tensor(rm.position_src, dtype=torch.long, device=device)
        self._index_src = torch.tensor(rm.index_src, dtype=torch.long, device=device)
        cos_sin, _positions = sk["rope_cache"]
        self._static = {
            **dict(sk),
            "img_position_ids": sk["img_position_ids"].index_select(
                1, pos_src.to(sk["img_position_ids"].device)
            ),
            "block_token_tags": sk["block_token_tags"].index_select(0, self._index_src),
            "packed_seq_params": {
                "cu_seqlens_q": torch.tensor(
                    [0, rm.ext_used, rm.ext_seq_len], dtype=torch.int32, device=device
                ),
                "cu_seqlens_q_host": (0, rm.ext_used, rm.ext_seq_len),
                "max_seqlen_q": rm.ext_used,
            },
            "rope_cache": (
                cos_sin.index_select(0, pos_src.to(cos_sin.device)),
                torch.arange(rm.ext_seq_len, device=cos_sin.device, dtype=torch.long),
            ),
        }
        with torch.inference_mode():
            self._x = positive.x_buffer.new_zeros(
                (1, rm.ext_seq_len, int(positive.x_buffer.shape[-1]))
            )
            self._ax = positive.audio_x_buffer.new_zeros(
                (1, rm.ext_seq_len, int(positive.audio_x_buffer.shape[-1]))
            )
        self._index_cache: dict[tuple[int, int], tuple[Any, ...]] = {}
        self._active = False
        self._on = False
        self._calls = 0
        self._order_ok = True
        self._embedded = False
        self.counts = {"nag": 0, "plain": 0}

    # ------------------------------------------------------------------ checks
    @staticmethod
    def _check_parallel() -> None:
        from sglang.multimodal_gen.runtime.distributed import get_tp_world_size  # type: ignore[import-untyped]
        from sglang.multimodal_gen.runtime.distributed.parallel_state import (  # type: ignore[import-untyped]
            get_ring_ctx,
            get_ulysses_ctx,
        )

        rules.check_parallel(
            (
                int(get_tp_world_size()),
                int(get_ulysses_ctx()[0]),
                int(get_ring_ctx()[0]),
            )
        )

    @staticmethod
    def _dit_attention(model: Any) -> list[Any]:
        mh = importlib.import_module(_DIT_MODULE)
        if not isinstance(model, mh.MiniMaxH3DiTModel):
            raise _reject(
                "NAG_MODEL_UNSUPPORTED",
                f"NAG 只支援 MiniMaxH3DiTModel，收到 {type(model).__name__}",
            )
        if hasattr(model, "_sglang_cache_dit_adapter"):
            raise _reject(
                "NAG_MODEL_UNSUPPORTED",
                "Cache-DiT 掛載中（block stack 被替換），NAG 不適用",
            )
        out = []
        for index, block in enumerate(model.blocks):
            attn = getattr(block, "attn", None)
            if not isinstance(block, mh.MiniMaxH3DiTBlock) or not isinstance(
                attn, mh.MiniMaxH3Attention
            ):
                raise _reject(
                    "NAG_MODEL_UNSUPPORTED",
                    f"DiT blocks.{index} 不是 MiniMaxH3DiTBlock",
                )
            if attn.hybrid is not None or attn._attention_impl is None:
                raise _reject(
                    "NAG_MODEL_UNSUPPORTED",
                    f"blocks.{index}：hybrid window attention 或尚未綁定 backend",
                )
            enum = getattr(attn, "_attention_backend_enum", None)
            name = str(getattr(enum, "name", enum))
            if name in (
                "SUBBLOCK_SPARSE_ATTN",
                "VIDEO_SPARSE_ATTN_H3",
                "HYBRID_WINDOW_ATTN_H3",
            ):
                raise _reject(
                    "NAG_ATTENTION_UNSUPPORTED",
                    f"blocks.{index} 綁定 {name}；NAG 第一版只支援 dense attention",
                )
            out.append(attn)
        if not out:
            raise _reject("NAG_MODEL_UNSUPPORTED", "DiT 沒有 block")
        return out

    # ------------------------------------------------------------------ extended kwargs
    def _extended_kwargs(self, kwargs: Mapping[str, Any]) -> dict[str, Any]:
        unknown = sorted(set(kwargs) - _STATIC_KEYS - _STEP_KEYS)
        if unknown:
            raise _reject(
                "NAG_KWARGS_UNKNOWN",
                f"denoise loop 傳入 NAG 不認得的 kwargs：{unknown}",
            )
        used = self.rows.used
        out = dict(self._static)
        self._x[0, :used].copy_(kwargs["x"][0, :used])
        self._ax[0, :used].copy_(kwargs["audio_x"][0, :used])
        out["x"], out["audio_x"] = self._x, self._ax
        out["unique_timesteps"] = kwargs[
            "unique_timesteps"
        ]  # the loop's set: same AdaLN rows and sidecar slot
        inverse, combined = (
            kwargs["inverse_indices"],
            kwargs.get("block_combined_indices"),
        )
        key = (id(inverse), id(combined))
        hit = self._index_cache.get(key)
        if hit is None or hit[0] is not inverse or hit[1] is not combined:
            src = self._index_src.to(inverse.device)
            hit = (
                inverse,
                combined,
                inverse.index_select(0, src),
                None
                if combined is None
                else combined.index_select(0, src.to(combined.device)),
            )
            self._index_cache[key] = hit
        out["inverse_indices"] = hit[2]
        if hit[3] is not None:
            out["block_combined_indices"] = hit[3]
        if "adaln_cache_slot" in kwargs:
            out["adaln_cache_slot"] = kwargs["adaln_cache_slot"]
        return out

    def _embed_wrapper(self, embed: Callable[..., Any]) -> Callable[..., Any]:
        """``model._embed`` plus the refined negative text written into rows [used, used + Ln)."""
        start, stop = self.rows.negative_text

        def wrapped(**kwargs: Any) -> Any:
            embeddings, t_emb = embed(**kwargs)
            if self._on:
                if int(embeddings.shape[0]) != self.rows.ext_seq_len:
                    raise _reject(
                        "NAG_ROWS",
                        f"embedding 有 {int(embeddings.shape[0])} 列，預期 {self.rows.ext_seq_len}",
                    )
                embeddings[start:stop].copy_(self.negative_embed.to(embeddings.dtype))
                self._embedded = True
            return embeddings, t_emb

        return wrapped

    # ------------------------------------------------------------------ loop plumbing
    def wrap_forward(
        self, forward: Callable[[Any, dict[str, Any], int], Any]
    ) -> Callable[[Any, dict[str, Any], int], Any]:
        """Install the configured guidance policy on the forward pass."""

        def model_forward(model: Any, kwargs: dict[str, Any], step: int) -> Any:
            if not self._active:
                raise RuntimeError(
                    "NagSession.wrap_forward used outside NagSession.active()"
                )
            if not self.nag.on(step):
                self.counts["plain"] += 1
                return forward(model, kwargs, step)
            ext = self._extended_kwargs(kwargs)
            self._on, self._calls, self._order_ok, self._embedded = True, 0, True, False
            try:
                out = forward(model, ext, step)
            finally:
                self._on = False
            if self._calls != self.layers or not self._order_ok or not self._embedded:
                raise _reject(
                    "NAG_LAYER_CALLS",
                    f"第 {step} 步的 DiT attention 呼叫 {self._calls} 次{'、順序不符' if not self._order_ok else ''}"
                    f"{'、負面文字沒有寫入 embedding' if not self._embedded else ''}"
                    f"（預期 blocks.0..{self.layers - 1} 各一次）",
                )
            self.counts["nag"] += 1
            return out

        return model_forward

    @contextlib.contextmanager
    def active(self) -> Iterator[NagSession]:
        """Swap every block's attention impl and ``model._embed`` for the loop (always restored)."""
        installed: list[tuple[Any, Any]] = []
        embed_installed = False
        try:
            for layer, attn in enumerate(self.attention):
                impl = attn._attention_impl
                attn._attention_impl = _NagImpl(self, layer, impl)
                installed.append((attn, impl))
            self.model._embed = self._embed_wrapper(self.model._embed)
            embed_installed = True
            self._active = True
            yield self
        finally:
            self._active = False
            self._on = False
            for attn, impl in installed:
                attn._attention_impl = impl
            if embed_installed:
                with contextlib.suppress(AttributeError):
                    del self.model._embed  # back to the class method
            self._index_cache.clear()

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
        if not self._on:
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
        bounds = tuple(int(b) for b in (cu_seqlens_host or ()))
        if int(query.shape[0]) != rm.ext_seq_len or bounds != (
            0,
            rm.ext_used,
            rm.ext_seq_len,
        ):
            raise _reject(
                "NAG_ROWS",
                f"NAG 步的 attention 收到 {int(query.shape[0])} 列、分段 {bounds}，預期 {(0, rm.ext_used, rm.ext_seq_len)}",
            )
        return self.attend_segments(impl, query, key, value)

    def attend_segments(self, impl: Any, query: Any, key: Any, value: Any) -> Any:
        """The extended sequence's attention output: Z+ | NAG on the target video rows | Z- of the negative text."""
        import torch

        rm = self.rows
        out = torch.empty_like(query)
        p0, p1 = rm.positive
        n0, n1 = rm.negative
        out[p0:p1].copy_(_segment(impl, query, key, value, p0, p1))
        negative = _segment(impl, query, key, value, n0, n1)
        t0, t1 = rm.negative_text
        out[t0:t1].copy_(negative[t0 - n0 : t1 - n0])
        g0, g1 = rm.padding
        if g1 > g0:
            out[g0:g1].copy_(_segment(impl, query, key, value, g0, g1))
        nag = self.nag
        if nag.phi != 0.0:
            for start in range(0, int(self._guided.numel()), _COMBINE_ROWS):
                rows = self._guided[start : start + _COMBINE_ROWS]
                pos = out.index_select(0, rows).float()
                neg = negative.index_select(
                    0, self._guided_neg[start : start + _COMBINE_ROWS]
                ).float()
                mixed = rules.nag_combine(
                    pos, neg, phi=nag.phi, tau=nag.tau, alpha=nag.alpha
                )
                out.index_copy_(0, rows, mixed.to(out.dtype))
        return out

    # ------------------------------------------------------------------ report
    def report(self) -> dict[str, Any]:
        """Run facts (deterministic: no timing), for ``NAG`` and the bundle's metadata."""
        return {
            "patch": PATCH_ID,
            **self.nag.as_dict(),
            "loop_steps": self.steps,
            "forwards": dict(self.counts),
            "rows": self.rows.as_dict(),
            "guided_rows": int(self._guided.numel()),
            "layers": self.layers,
            "analytic_extra_attention_flop_per_nag_step": rules.extra_attention_flop(
                self.rows, layers=self.layers, attn_dim=DIT_ATTN_DIM
            ),
            "source_sha256": dict(self.digests),
        }


__all__ = ["PATCH_ID", "NagSession"]


def _positive_layout(positive: Any) -> tuple[Any, Any, Any, Any]:
    sk = positive.static_kwargs
    unknown, missing = (
        sorted(set(sk) - _STATIC_KEYS),
        sorted(_STATIC_KEYS - set(sk)),
    )
    if unknown or missing:
        raise _reject(
            "NAG_KWARGS_UNKNOWN",
            f"denoise branch 的 static kwargs 與 NAG 預期不同（未知 {unknown}，缺 {missing}；"
            "SubBlock mask 或未 precompute 的 rope／prompt 都不支援）",
        )
    cu = tuple(int(x) for x in sk["packed_seq_params"]["cu_seqlens_q_host"])
    seq_len = int(positive.seq_len)
    if len(cu) != _CU_BOUNDARIES or cu[0] != 0 or cu[2] != seq_len:
        raise _reject(
            "NAG_LAYOUT", f"packed cu_seqlens 必須是 (0, used, seq_len)，收到 {cu}"
        )
    text_len = int(sk["text_pos_info"]["position_ids"].numel())
    return sk, cu, seq_len, text_len
