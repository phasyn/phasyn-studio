"""Normalized Attention Guidance (NAG, arXiv 2505.21179) for the H3 DiT: the request rules, torch-free.

Opt-in per ``h3.dit`` call: the ``nag_conditioning`` input (a second ``h3.conditioning`` step that encoded the
negative text as a ``t2va`` prompt without materials) plus the optional ``nag_scale`` / ``nag_tau`` /
``nag_alpha`` / ``nag_steps`` parameters. Without the input nothing here runs: ``denoise_av`` builds no session,
the packed sequence, the plan, the profile and the payload are the ones of today.

What a NAG step runs (``nag.NagSession``, the single-stream pattern of the official Flux code): the negative text
rows are appended after the live rows, ``[text+ | cond | audio | video | text- | pad]``, and every block's
attention runs two row segments of the same q/k/v instead of one:

* positive ``[0, used)``: exactly the live rows of today (``Z+``);
* negative ``[text_len, used + neg_len)``: the same condition / audio / video rows with the negative text in
  place of the positive one (``Z-``); the negative text rows keep their own ``Z-`` (their own stream);
* padding ``[used + neg_len, seq_len')`` attends among itself, as the padding of today does.

The target video rows then get ``Z = alpha * Z^ + (1 - alpha) * Z+`` with ``Z~ = Z+ + phi * (Z+ - Z-)`` and
``Z^ = Z~ * min(R, tau) / R``, ``R = |Z~|_1 / |Z+|_1`` per row over heads x head_dim (paper Eq. 7-10; the
official code's ``nag_scale`` is ``phi + 1``); every other row keeps ``Z+``. The negative rows sit at the
RoPE positions of the last ``neg_len`` positive text rows (right-aligned: the distance from the last text token
to frame 0 stays the trained one) and copy a positive text row's AdaLN index, so the fixed AdaLN sidecar and
its slot are unchanged.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, TypedDict, Unpack

from ._arguments import validate_keywords
from .errors import InvalidStageInput, UnsupportedCombination


class _TextLayoutRequired(TypedDict):
    text_len: int
    used: int
    seq_len: int
    positive_text_tags: Sequence[int]
    negative_text_tags: Sequence[int]


class _TextLayout(_TextLayoutRequired, total=False):
    align: int


STAGE_OPTION = "nag"
INPUT_ROLE = "nag_conditioning"
PORT = "nag_conditioning"
PARAMS = ("nag_scale", "nag_tau", "nag_alpha", "nag_steps")
DEFAULT_PHI = 4.0  # paper Table 5, every DiT
DEFAULT_TAU = 2.5
DEFAULT_ALPHA = 0.25  # Flux / Wan2.1
TEXT_TAG = 1  # token tag of a text row (Qwen vision rows are 0)
NORM = "l1"  # the paper's and the Wan / SD3 code's norm (the Flux code uses L2)
EPS = 1e-7  # the official code's guard on the guided norm
# profile attention providers whose impl serves a plain dense ``forward_varlen`` segment
ATTENTION_PROVIDERS = frozenset(
    {"pytorch_sdpa", "flash_attention_3", "flash_attention_4", "fp8_fa_sm120"}
)


@dataclass(frozen=True)
class Nag:
    """One request's guidance: phi (guidance scale), tau (norm clip), alpha (mix), the NAG updates (first N)."""

    phi: float
    tau: float
    alpha: float
    steps: int | None = None  # None: every update of the loop

    def on(self, step: int) -> bool:
        """Return whether negative attention guidance is active."""
        return self.steps is None or int(step) < self.steps

    def as_dict(self) -> dict[str, Any]:
        """Serialize the resolved values used by the runtime."""
        return {
            "phi": self.phi,
            "nag_scale_official": self.phi + 1.0,
            "tau": self.tau,
            "alpha": self.alpha,
            "steps": self.steps,
            "norm": NORM,
            "apply_to": "video",
            "negative_positions": "right_aligned",
        }


def _number(
    raw: Mapping[str, Any], key: str, default: float, low: float, high: float
) -> float:
    value = raw.get(key, default)
    if value is None:
        value = default
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not low <= float(value) <= high
    ):
        raise InvalidStageInput(
            "NAG_PARAMETER_RANGE",
            f"{key} 必須是 {low}..{high} 的數字，收到 {value!r}",
            field_path=key,
        )
    return float(value)


def from_params(params: Mapping[str, Any], *, planned_updates: int) -> Nag:
    """The guidance of the request parameters (defaults: phi 4, tau 2.5, alpha 0.25, every update)."""
    steps = params.get("nag_steps")
    if steps is not None and (
        isinstance(steps, bool)
        or not isinstance(steps, int)
        or not 1 <= steps <= planned_updates
    ):
        raise InvalidStageInput(
            "NAG_PARAMETER_RANGE",
            f"nag_steps 必須是 1..{planned_updates} 的整數（這次 {planned_updates} 步），收到 {steps!r}",
            field_path="nag_steps",
        )
    return Nag(
        phi=_number(params, "nag_scale", DEFAULT_PHI, 0.0, 50.0),
        tau=_number(params, "nag_tau", DEFAULT_TAU, 1.0, 100.0),
        alpha=_number(params, "nag_alpha", DEFAULT_ALPHA, 0.0, 1.0),
        steps=None if steps is None else int(steps),
    )


def check_combination(
    *, mode: str, attention: str, ref_kv_cache: bool, ptd: bool = False
) -> None:
    """The v1 refusals (before any GPU work); NAG never falls back to the run without it."""
    if mode == "exact":
        raise UnsupportedCombination(
            "NAG_EXACT_MODE",
            "NAG 改變每一步的 attention 輸出，不能用於 mode=exact 的元件",
            field_path="mode",
        )
    if attention not in ATTENTION_PROVIDERS:
        raise UnsupportedCombination(
            "NAG_ATTENTION_UNSUPPORTED",
            f"NAG 第一版只支援 dense attention（{', '.join(sorted(ATTENTION_PROVIDERS))}）；此元件是 {attention}"
            "（SubBlock sparse／VSA／hybrid window 的列選擇綁定單一序列）",
            field_path="attention.provider",
            actual=attention,
        )
    if ref_kv_cache:
        raise UnsupportedCombination(
            "NAG_REF_KV_CACHE",
            "NAG 第一版不能與 ref_kv_cache 同時使用（略過步的列與負面分支不一致）",
        )
    if ptd:
        raise UnsupportedCombination(
            "NAG_LORA_PTD",
            "NAG 第一版不支援 PTD 每步換 adapter 的 LoRA（文字列每步重算）",
        )


def check_parallel(sizes: Sequence[int]) -> None:
    """Validate the parallel layout used for negative guidance."""
    if tuple(int(s) for s in sizes) != (1, 1, 1):
        raise UnsupportedCombination(
            "NAG_PARALLEL_UNSUPPORTED",
            f"NAG 第一版只支援 TP = Ulysses = Ring = 1（目前 {tuple(sizes)}）：兩段 attention 的列在各 rank 間不對齊",
        )


ENCODER_FIELDS = ("encoder_revision", "tokenizer_digest", "quant_profile_digest")


def check_same_encoder(
    positive: Mapping[str, Any], negative: Mapping[str, Any]
) -> None:
    """The negative conditioning must come from the same text encoder, tokenizer and TE precision."""
    differ = [k for k in ENCODER_FIELDS if positive.get(k) != negative.get(k)]
    if differ:
        raise InvalidStageInput(
            "NAG_NEGATIVE_ENCODER",
            f"nag_conditioning 與 conditioning 不是同一個文字編碼器的輸出（{', '.join(differ)} 不同）",
            field_path=INPUT_ROLE,
        )


def parse(
    stage: Mapping[str, Any],
    *,
    mode: str,
    attention: str,
    ref_kv_cache: bool,
    ptd: bool,
) -> Nag | None:
    """The stage's ``nag`` option (None: off, nothing changes)."""
    raw = stage.get(STAGE_OPTION)
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise InvalidStageInput(
            "NAG_OPTION_INVALID", "nag 必須是 object", field_path="nag"
        )
    check_combination(
        mode=mode, attention=attention, ref_kv_cache=ref_kv_cache, ptd=ptd
    )
    steps = raw.get("steps")
    if steps is not None and (
        isinstance(steps, bool) or not isinstance(steps, int) or steps < 1
    ):
        raise InvalidStageInput(
            "NAG_PARAMETER_RANGE", f"nag.steps 必須是正整數，收到 {steps!r}"
        )
    return Nag(
        phi=_number(raw, "phi", DEFAULT_PHI, 0.0, 50.0),
        tau=_number(raw, "tau", DEFAULT_TAU, 1.0, 100.0),
        alpha=_number(raw, "alpha", DEFAULT_ALPHA, 0.0, 1.0),
        steps=None if steps is None else int(steps),
    )


@dataclass(frozen=True)
class NagRows:
    """Where everything sits in the extended packed sequence of a NAG step."""

    text_len: int  # L: positive text (+ Qwen vision) rows [0, L)
    used: int  # U: live rows of the positive sequence
    seq_len: int  # S: packed rows of the positive sequence (padding included)
    neg_len: int  # Ln: negative text rows [U, U + Ln)
    ext_used: int  # U + Ln
    ext_seq_len: int  # U + Ln padded to the packed alignment
    position_src: tuple[
        int, ...
    ]  # extended row -> positive row whose RoPE position / position ids it takes
    index_src: tuple[
        int, ...
    ]  # extended row -> positive row whose tag / AdaLN indices it takes

    @property
    def positive(self) -> tuple[int, int]:
        """Return the positive conditioning rows."""
        return 0, self.used

    @property
    def negative(self) -> tuple[int, int]:
        """Return the negative conditioning rows."""
        return self.text_len, self.ext_used

    @property
    def padding(self) -> tuple[int, int]:
        """Return the padding rows in the packed sequence."""
        return self.ext_used, self.ext_seq_len

    @property
    def negative_text(self) -> tuple[int, int]:
        """Return the rows containing negative text."""
        return self.used, self.ext_used

    def as_dict(self) -> dict[str, Any]:
        """Serialize the resolved values used by the runtime."""
        return {
            "text": self.text_len,
            "used": self.used,
            "seq_len": self.seq_len,
            "negative_text": self.neg_len,
            "extended_used": self.ext_used,
            "extended_seq_len": self.ext_seq_len,
            "segments": {
                "positive": list(self.positive),
                "negative": list(self.negative),
                "padding": list(self.padding),
            },
            "negative_positions_from": [self.text_len - self.neg_len, self.text_len],
        }


def row_plan(**arguments: Unpack[_TextLayout]) -> NagRows:
    """The extended layout (pure; ``nag.NagSession`` gathers every per-row tensor with these indices)."""
    validate_keywords(arguments, _TextLayout)
    text_len = arguments["text_len"]
    used = arguments["used"]
    seq_len = arguments["seq_len"]
    positive_text_tags = arguments["positive_text_tags"]
    negative_text_tags = arguments["negative_text_tags"]
    align = arguments.get("align", 64)
    text_length, used_length, sequence_length, negative_length = (
        int(text_len),
        int(used),
        int(seq_len),
        len(negative_text_tags),
    )
    if (
        not 0 < text_length <= used_length <= sequence_length
        or len(positive_text_tags) != text_length
    ):
        raise InvalidStageInput(
            "NAG_LAYOUT",
            f"packed 序列不是「文字在前」：text {text_length}、used {used_length}、seq_len {sequence_length}",
        )
    if negative_length == 0:
        raise InvalidStageInput(
            "NAG_NEGATIVE_EMPTY",
            "nag_conditioning 沒有任何文字列",
            error_code="INVALID_ARGUMENT",
        )
    vision = [i for i, t in enumerate(negative_text_tags) if int(t) != TEXT_TAG]
    if vision:
        raise UnsupportedCombination(
            "NAG_NEGATIVE_VISION",
            f"nag_conditioning 有 {len(vision)} 個非文字列（Qwen 視覺 token）；第一版只接受純文字的負面 prompt"
            "（h3.conditioning task=t2va、不接素材）",
        )
    if negative_length > text_length:
        raise InvalidStageInput(
            "NAG_NEGATIVE_TOO_LONG",
            f"負面文字 {negative_length} 列比正面文字 {text_length} 列長；右對齊的 RoPE 位置放不下（縮短負面文字）",
            expected=f"<= {text_length}",
            actual=str(negative_length),
        )
    text_rows = [i for i, t in enumerate(positive_text_tags) if int(t) == TEXT_TAG]
    if not text_rows:
        raise InvalidStageInput(
            "NAG_LAYOUT", "正面 conditioning 沒有任何文字列（tag=1）"
        )
    ext_used = used_length + negative_length
    ext_seq = (ext_used + int(align) - 1) // int(align) * int(align)
    pad = (
        used_length if sequence_length > used_length else 0
    )  # padding rows copy an original padding row (else text row 0), as ref_kv_cache does
    tail = [pad] * (ext_seq - ext_used)
    live = list(range(used_length))
    return NagRows(
        text_len=text_length,
        used=used_length,
        seq_len=sequence_length,
        neg_len=negative_length,
        ext_used=ext_used,
        ext_seq_len=ext_seq,
        position_src=tuple(
            live + list(range(text_length - negative_length, text_length)) + tail
        ),
        index_src=tuple(live + [text_rows[0]] * negative_length + tail),
    )


def nag_combine[T](
    positive: T, negative: T, *, phi: float, tau: float, alpha: float
) -> T:
    """NAG on rows ``[N, ...]`` (norms per row over every other axis), numpy or torch, in the inputs' dtype.

    ``phi == 0`` returns ``positive`` itself (no arithmetic).
    """
    if phi == 0.0:
        return positive
    pos: Any = positive
    neg: Any = negative
    guided = pos * (1.0 + phi) - neg * phi
    rows = int(pos.shape[0])
    shape = (rows, *([1] * (len(pos.shape) - 1)))
    pos_norm = abs(pos).reshape(rows, -1).sum(-1)
    guided_norm = abs(guided).reshape(rows, -1).sum(-1)
    ratio = guided_norm / pos_norm
    clip = ratio > tau  # NaN (both norms 0) compares False: that row keeps Z~ (== 0)
    factor = 1.0 + clip * (tau * pos_norm / (guided_norm + EPS) - 1.0)
    out: T = guided * factor.reshape(shape) * alpha + pos * (1.0 - alpha)
    return out


def extra_attention_flop(rows: NagRows, *, layers: int, attn_dim: int) -> float:
    """Analytic FLOP of the negative segment's attention per NAG step (QK^T and PV over ``used_length + negative_length - text_length`` rows)."""
    n = rows.ext_used - rows.text_len
    return 4.0 * n * n * attn_dim * layers


__all__ = [
    "ATTENTION_PROVIDERS",
    "DEFAULT_ALPHA",
    "DEFAULT_PHI",
    "DEFAULT_TAU",
    "INPUT_ROLE",
    "PARAMS",
    "PORT",
    "STAGE_OPTION",
    "Nag",
    "NagRows",
    "check_combination",
    "check_parallel",
    "extra_attention_flop",
    "from_params",
    "nag_combine",
    "parse",
    "row_plan",
]
