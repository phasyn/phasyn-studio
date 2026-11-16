"""Parse the vendored Anime4K v4 ``Upscale_CNN_x2_VL`` mpv shader (bloc97/Anime4K, MIT) into convolution weights.

The shader text in ``third_party/anime4k`` is the weight file: it is read at load, checked against its pinned
SHA-256 and turned into float64 NumPy arrays (no torch here). Only the constructs of this one shader are accepted;
anything else is refused instead of guessed:

* conv passes (``//!SAVE <texture>``): ``#define go_i(x_off, y_off) (T_texOff(vec2(x_off, y_off)))`` (3×3 taps) or
  ``#define g_i (T_tex(T_pos))`` (1×1), optionally as CReLU halves ``max((…), 0.0)``／``max(-(…), 0.0)``;
  ``result += mat4(16 floats) * go_i(dx, dy)`` is column-major (column = input component, row = output component),
  ``result += vec4(…)`` is the bias, texture reads clamp at the edges (replicate padding) and every pass returns
  ``result`` unchanged. Consecutive passes that read the same inputs are merged into one convolution.
* the last pass (Depth-to-Space): R, G and B each come from one 4-channel texture whose channel ``sub_y * 2 + sub_x``
  is the sub-pixel of a 2×2 block, added to MAIN sampled bilinearly at the output pixel; alpha copies blue and is
  dropped. (The M-size shaders broadcast one texture to all three colours; VL does not.)

``halo`` is the receptive-field radius in input pixels: a tile read with that many extra pixels on every side gives
the same interior as the whole frame.

Two more vendored shaders of the same release make the second method:

* ``Restore_CNN_Soft_VL`` (1×): the same conv passes, the last one ``//!SAVE MAIN`` without COMPONENTS and returning
  ``result + MAIN_tex(MAIN_pos)``: the restored MAIN is its conv output plus MAIN (alpha weights and bias must be zero,
  so alpha stays 1). Only that last pass may add the residual.
* ``Clamp_Highlights`` (De-Ring): matched as the exact v4.0 text: the luma (0.299, 0.587, 0.114) maximum over 5 pixels
  horizontally, then 5 vertically, on the chain input (replicate edges); at the end the output's luma is clamped to
  that maximum sampled bilinearly at the output pixel: ``out -= max(luma_out - stats, 0)`` on every channel.

``MethodSpec`` is one method: optional clamp, optional restore, then the 2× chain, with the halo of the whole chain.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from phasyn_components.errors import ComponentError

SHADER_DIR = Path(__file__).resolve().parent / "third_party" / "anime4k"
SHADER_FILE = "Anime4K_Upscale_CNN_x2_VL.glsl"
# Anime4K v4.0.1 release (asset Anime4K_v4.0.zip), file dated 2021-08-10.
SHADER_SHA256 = "5638fe31c37c151a3443fea3451a3ef91af073f4dbb9615f6c0d1e29db11493d"
RESTORE_FILE = "Anime4K_Restore_CNN_Soft_VL.glsl"
RESTORE_SHA256 = "094334b0e20c1a201fe4941c7c68de72451e5aee9efb5524d7fb82b12dca64b9"
CLAMP_FILE = "Anime4K_Clamp_Highlights.glsl"
CLAMP_SHA256 = "8c5fb67c76bed3021f8a27b050c3b97a6ac1b284f9ce91c04189015c354c0217"
LUMA = (0.299, 0.587, 0.114)
CLAMP_KERNEL = 5
MAX_SHADER_BYTES = 1024 * 1024
MAIN = "MAIN"

_DEFINE = re.compile(r"^#define (go?_\d+)(\(x_off, y_off\))? \((.*)\)\s*$", re.M)
_TERM = re.compile(r"mat4\(([^)]*)\) \* (go?_\d+)(?:\(([-\d.]+), ([-\d.]+)\))?")
_STATEMENT = re.compile(r"^\s*(?:vec4 )?result \+?= mat4\(", re.M)
_BIAS = re.compile(r"^\s*result \+= vec4\(([^)]*)\);\s*$", re.M)
_SAMPLE = re.compile(r"(\w+?)_tex(Off)?\((vec2\(x_off, y_off\)|(\w+?)_pos)\)")
_D2S_CHANNEL = re.compile(
    r"float c(\d) = (\w+?)_tex\(\(vec2\(0\.5\) - f\1\) \* \2_pt \+ \2_pos\)\[i\1\.y \* 2 \+ i\1\.x\];"
)


@dataclass(frozen=True)
class ConvStage:
    """One convolution: reads CReLU views of 4-channel textures and writes 4-channel textures."""

    saves: tuple[str, ...]
    inputs: tuple[tuple[str, str], ...]  # (texture, "id" | "pos" | "neg") per 4-channel input group
    weight: np.ndarray  # float64 [4 * len(saves), 4 * len(inputs), k, k]
    bias: np.ndarray  # float64 [4 * len(saves)]

    @property
    def pad(self) -> int:
        return int(self.weight.shape[-1]) // 2


@dataclass(frozen=True)
class ChainSpec:
    name: str
    sha256: str
    scale: int
    stages: tuple[ConvStage, ...]
    depth_to_space: tuple[str, str, str]  # textures of R, G, B
    halo: int


@dataclass(frozen=True)
class RestoreSpec:
    """A 1× restore chain: ``stages`` end with the residual stage that writes MAIN (conv output + MAIN)."""

    name: str
    sha256: str
    stages: tuple[ConvStage, ...]
    radius: int  # input pixels the restored MAIN depends on


@dataclass(frozen=True)
class ClampSpec:
    name: str
    sha256: str
    kernel: int
    luma: tuple[float, float, float]


@dataclass(frozen=True)
class MethodSpec:
    method_id: str
    label: str
    upscale: ChainSpec
    restore: RestoreSpec | None
    clamp: ClampSpec | None
    halo: int
    shaders: tuple[tuple[str, str], ...]  # (file, sha256) in chain order


def _refuse(message: str) -> ComponentError:
    return ComponentError("MODEL_INCOMPATIBLE", f"Anime4K shader 無法解析：{message}")


def _define(name: str, has_offsets: bool, expr: str) -> tuple[str, str]:
    """(texture, activation) of one ``#define``; ``go_`` reads with offsets, ``g_`` reads the texel itself."""
    activation = "id"
    inner = expr
    crelu = re.fullmatch(r"max\((-?)\((.*)\), 0\.0\)", expr)
    if crelu:
        activation, inner = ("neg" if crelu.group(1) else "pos"), crelu.group(2)
    sample = _SAMPLE.fullmatch(inner)
    if sample is None:
        raise _refuse(f"不支援的 define {name}: {expr}")
    texture, offset, _arg, pos_of = sample.groups()
    wants_offsets = name.startswith("go_")
    if wants_offsets != has_offsets or wants_offsets != bool(offset) or (not offset and pos_of != texture):
        raise _refuse(f"define {name} 的取樣方式不符合預期：{expr}")
    return texture, activation


def _conv_pass(
    block: str, *, residual: bool = False
) -> tuple[str, tuple[tuple[str, str], ...], np.ndarray, np.ndarray]:
    """One conv pass; ``residual`` accepts only Restore's last form (``//!SAVE MAIN``, ``return result + MAIN``)."""
    save = re.search(r"^//!SAVE (\S+)$", block, re.M)
    if residual:
        if save is None or save.group(1) != MAIN or re.search(r"^//!COMPONENTS", block, re.M):
            raise _refuse("殘差 pass 必須 SAVE MAIN 且不另設 COMPONENTS")
        if "return result + MAIN_tex(MAIN_pos);" not in block or "return result;" in block:
            raise _refuse("殘差 pass 必須回傳 result + MAIN_tex(MAIN_pos)")
    else:
        if save is None or re.search(r"^//!COMPONENTS 4$", block, re.M) is None:
            raise _refuse("conv pass 缺少 SAVE 或不是 4 個 components")
        if "return result;" not in block or "return result +" in block:
            raise _refuse(f"conv pass {save.group(1)} 不是單純回傳 result")
    defines = {name: _define(name, bool(params), expr) for name, params, expr in _DEFINE.findall(block)}
    order = sorted(defines, key=lambda n: int(n.split("_")[1]))
    if not order or [int(n.split("_")[1]) for n in order] != list(range(len(order))):
        raise _refuse(f"conv pass {save.group(1)} 的 define 編號不連續")
    terms = _TERM.findall(block)
    if len(terms) != len(_STATEMENT.findall(block)):
        raise _refuse(f"conv pass {save.group(1)} 有無法解析的 mat4 項")
    offsets = [(int(float(dx)), int(float(dy))) for _, _, dx, dy in terms if dx]
    pad = max([max(abs(x), abs(y)) for x, y in offsets], default=0)
    k = 2 * pad + 1
    index = {name: i for i, name in enumerate(order)}
    weight = np.zeros((4, 4 * len(order), k, k), dtype=np.float64)
    for values, name, dx, dy in terms:
        if name not in index or name.startswith("go_") != bool(dx):
            raise _refuse(f"conv pass {save.group(1)} 引用了未定義或用法不符的 {name}")
        matrix = [float(v) for v in values.split(",")]
        if len(matrix) != 16:
            raise _refuse(f"conv pass {save.group(1)} 的 mat4 不是 16 個數")
        x, y = (int(float(dx)), int(float(dy))) if dx else (0, 0)
        group = index[name]
        for column in range(4):
            for row in range(4):
                weight[row, 4 * group + column, y + pad, x + pad] += matrix[column * 4 + row]
    biases = _BIAS.findall(block)
    if len(biases) != 1:
        raise _refuse(f"conv pass {save.group(1)} 的 bias 不是恰好一個")
    bias = np.array([float(v) for v in biases[0].split(",")], dtype=np.float64)
    if bias.shape != (4,):
        raise _refuse(f"conv pass {save.group(1)} 的 bias 不是 vec4")
    return save.group(1), tuple(defines[n] for n in order), weight, bias


def _depth_to_space(block: str) -> tuple[str, str, str]:
    channels = {int(c): texture for c, texture in _D2S_CHANNEL.findall(block)}
    if sorted(channels) != [0, 1, 2] or len(set(channels.values())) != 3:
        raise _refuse("Depth-to-Space 不是 R、G、B 各一個 texture（只支援 VL 的形式）")
    if "float c3 = c2;" not in block or "return vec4(c0, c1, c2, c3) + MAIN_tex(MAIN_pos);" not in block:
        raise _refuse("Depth-to-Space 的輸出形式不符合預期")
    if re.search(r"^//!WIDTH \w+\.w 2 \*$", block, re.M) is None:
        raise _refuse("Depth-to-Space 不是 2×")
    return channels[0], channels[1], channels[2]


def _merge(passes: list[tuple[str, tuple[tuple[str, str], ...], np.ndarray, np.ndarray]]) -> list[ConvStage]:
    stages: list[ConvStage] = []
    for save, inputs, weight, bias in passes:
        last = stages[-1] if stages else None
        if last is not None and last.inputs == inputs and last.weight.shape[1:] == weight.shape[1:]:
            stages[-1] = ConvStage(
                (*last.saves, save), inputs, np.concatenate([last.weight, weight]), np.concatenate([last.bias, bias])
            )
        else:
            stages.append(ConvStage((save,), inputs, weight, bias))
    return stages


def _halo(stages: list[ConvStage], d2s: tuple[str, str, str]) -> int:
    radius = {MAIN: 0}
    for stage in stages:
        missing = [t for t, _ in stage.inputs if t not in radius]
        if missing:
            raise _refuse(f"conv 讀取尚未產生的 texture {missing}")
        reach = max(radius[t] for t, _ in stage.inputs) + stage.pad
        radius.update(dict.fromkeys(stage.saves, reach))
    missing = [t for t in d2s if t not in radius]
    if missing:
        raise _refuse(f"Depth-to-Space 讀取尚未產生的 texture {missing}")
    return max(1, *(radius[t] for t in d2s))  # bilinear MAIN reads one neighbour


def _radii(stages: list[ConvStage] | tuple[ConvStage, ...]) -> dict[str, int]:
    radius = {MAIN: 0}
    for stage in stages:
        missing = [t for t, _ in stage.inputs if t not in radius]
        if missing:
            raise _refuse(f"conv 讀取尚未產生的 texture {missing}")
        reach = max(radius[t] for t, _ in stage.inputs) + stage.pad
        for name in stage.saves:
            radius[name] = max(reach, radius.get(name, 0)) if name == MAIN else reach
    return radius


def _main_alpha_zero(stages: list[ConvStage] | tuple[ConvStage, ...]) -> None:
    for stage in stages:  # MAIN is fed with alpha = 1, which is only exact when its weights are zero
        if any(t == MAIN and stage.weight[:, 4 * i + 3].any() for i, (t, _) in enumerate(stage.inputs)):
            raise _refuse("MAIN 的 alpha 有非零權重")


def parse_restore(text: str, *, name: str, sha256: str) -> RestoreSpec:
    text = text.replace("\r\n", "\n")
    blocks = text.split("//!DESC")[1:]
    if len(blocks) < 2 or not all(re.search(r"^//!HOOK MAIN$", b, re.M) for b in blocks):
        raise _refuse("restore shader 必須有多個 HOOK MAIN 的 pass")
    *convs, last = blocks
    stages = _merge([_conv_pass(b) for b in convs])
    out_save, out_inputs, out_weight, out_bias = _conv_pass(last, residual=True)
    if out_weight[3].any() or out_bias[3] != 0.0:
        raise _refuse("殘差 pass 的 alpha 輸出不是零（MAIN 的 alpha 會被改掉）")
    stages.append(ConvStage((out_save,), out_inputs, out_weight, out_bias))
    _main_alpha_zero(stages)
    return RestoreSpec(name=name, sha256=sha256, stages=tuple(stages), radius=_radii(stages)[MAIN])


_CLAMP_REQUIRED = (
    "//!DESC Anime4K-v4.0-De-Ring-Compute-Statistics\n//!HOOK MAIN\n//!BIND HOOKED\n//!SAVE STATSMAX\n//!COMPONENTS 1",
    "#define KERNELSIZE 5 ",
    "#define KERNELHALFSIZE 2 ",
    "return dot(vec4(0.299, 0.587, 0.114, 0.0), rgba);",
    "float g = get_luma(MAIN_texOff(vec2(i - KERNELHALFSIZE, 0)));",
    "//!BIND STATSMAX\n//!SAVE STATSMAX\n//!COMPONENTS 1",
    "float g = STATSMAX_texOff(vec2(0, i - KERNELHALFSIZE)).x;",
    "//!DESC Anime4K-v4.0-De-Ring-Clamp\n//!HOOK PREKERNEL\n//!BIND HOOKED\n//!BIND STATSMAX",
    "float new_luma = min(current_luma, STATSMAX_tex(HOOKED_pos).x);",
    "return HOOKED_tex(HOOKED_pos) - (current_luma - new_luma);",
)


def parse_clamp(text: str, *, name: str, sha256: str) -> ClampSpec:
    """Clamp_Highlights is accepted only as the exact v4.0 construction (three passes, 5×5 max, luma clamp)."""
    text = text.replace("\r\n", "\n")  # the release ships this file with CRLF line ends
    if text.count("//!DESC") != 3 or any(part not in text for part in _CLAMP_REQUIRED):
        raise _refuse("Clamp_Highlights 不是預期的 v4.0 寫法")
    return ClampSpec(name=name, sha256=sha256, kernel=CLAMP_KERNEL, luma=LUMA)


def parse_chain(text: str, *, name: str, sha256: str) -> ChainSpec:
    blocks = text.split("//!DESC")[1:]
    if len(blocks) < 2:
        raise _refuse("找不到 shader pass")
    if not all(re.search(r"^//!HOOK MAIN$", b, re.M) for b in blocks):
        raise _refuse("每個 pass 都必須 HOOK MAIN")
    *convs, last = blocks
    if "Depth-to-Space" not in last.splitlines()[0] or any("Depth-to-Space" in b.splitlines()[0] for b in convs):
        raise _refuse("Depth-to-Space 必須是最後一個、也是唯一一個 pass")
    stages = _merge([_conv_pass(b) for b in convs])
    d2s = _depth_to_space(last)
    _main_alpha_zero(stages)
    return ChainSpec(
        name=name, sha256=sha256, scale=2, stages=tuple(stages), depth_to_space=d2s, halo=_halo(stages, d2s)
    )


def _pinned(file: str, sha256: str) -> str:
    """A vendored shader's text, refused unless it is exactly the pinned file."""
    path = SHADER_DIR / file
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_SHADER_BYTES:
        raise ComponentError("PROVIDER_NOT_INSTALLED", f"缺少內建的 Anime4K shader（{file}）")
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != sha256:
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"內建的 Anime4K shader 與釘選的版本不同（{file}）",
            details={"expected_sha256": sha256, "actual_sha256": digest},
        )
    return data.decode("ascii")


def load_vendored() -> ChainSpec:
    """The vendored VL shader, refused unless it is exactly the pinned file."""
    return parse_chain(_pinned(SHADER_FILE, SHADER_SHA256), name=Path(SHADER_FILE).stem, sha256=SHADER_SHA256)


def method_spec(method_id: str, label: str, upscale: ChainSpec, *, restore_and_clamp: bool) -> MethodSpec:
    """One method; the default (no restore, no clamp) keeps the 2× chain's own halo."""
    if not restore_and_clamp:
        return MethodSpec(method_id, label, upscale, None, None, upscale.halo, ((SHADER_FILE, upscale.sha256),))
    clamp = parse_clamp(_pinned(CLAMP_FILE, CLAMP_SHA256), name=Path(CLAMP_FILE).stem, sha256=CLAMP_SHA256)
    restore = parse_restore(_pinned(RESTORE_FILE, RESTORE_SHA256), name=Path(RESTORE_FILE).stem, sha256=RESTORE_SHA256)
    # the 2× chain reads the restored MAIN; the clamp reads 2 input pixels and samples them bilinearly (1 more)
    halo = max(restore.radius + upscale.halo, clamp.kernel // 2 + 1)
    shaders = ((CLAMP_FILE, CLAMP_SHA256), (RESTORE_FILE, RESTORE_SHA256), (SHADER_FILE, upscale.sha256))
    return MethodSpec(method_id, label, upscale, restore, clamp, halo, shaders)


__all__ = [
    "CLAMP_FILE",
    "CLAMP_SHA256",
    "LUMA",
    "RESTORE_FILE",
    "RESTORE_SHA256",
    "SHADER_FILE",
    "SHADER_SHA256",
    "ChainSpec",
    "ClampSpec",
    "ConvStage",
    "MethodSpec",
    "RestoreSpec",
    "load_vendored",
    "method_spec",
    "parse_chain",
    "parse_clamp",
    "parse_restore",
]
