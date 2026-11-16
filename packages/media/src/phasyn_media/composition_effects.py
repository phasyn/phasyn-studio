"""Ordered clip effects, shape masks and alpha-preserving layer blend compilation.

Inputs have already passed the timeline schema and semantic validator. Label names use
compiler indices only; user names, IDs and arbitrary expressions never enter the graph.

A clip may be rendered from the middle of its processed clock (a later segment of an export):
``offset`` is the processed frame the chain starts at, and every per-frame expression adds it
to the filter's own frame counter, so the picture of a frame never depends on where a chain began.

The look effects (glow, RGB split, vignette, grain, directional blur, sharpen) are the editor's preview
shaders (``clipRenderer.ts``) as filters. Glow and sharpen amplify small differences, so they work on
16-bit planes and come back to 8 bits once; a Gaussian is ``gblur`` with four steps (within about a tenth
of the true curve the preview draws). Grain is a hash of the pixel and the processed frame, so a frame
has the same grain in every segment and every export.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from phasyn_components.errors import ComponentError

from .composition_curves import command_filter, expression, frame_parameters, number

# gblur steps of the look effects: four passes come within about 10 % of a Gaussian (two: about 25 %).
GAUSS_STEPS = 4
# Rec. 709 luma of the encoded RGB the graph works in.
LUMA = (0.2126, 0.7152, 0.0722)
# Unsharp mask radius in sequence pixels.
SHARPEN_SIGMA = 1.0
# A directional blur of length L is a Gaussian streak with sigma L/4: plus and minus two sigma cover the length.
STREAK_SIGMA = 0.25
# Grain of amount 1 adds triangular noise of up to this much of the colour range.
GRAIN_AMPLITUDE = 0.25
# Glow: thresholds stop just below 1 so the weight ramp keeps a width.
GLOW_THRESHOLD_MAX = 0.999


@dataclass(frozen=True)
class Canvas:
    """The sequence picture a clip chain works on: its size, frame rate and the processed frames of the slice."""

    width: int
    height: int
    rate: str
    frames: int


def clock(counter: str, offset: int) -> str:
    """The processed frame number, from a filter's frame counter (``n``, ``N`` or ``(N-1)``)."""
    return counter if offset == 0 else f"({counter}+{offset})"


def _peak(effect: Mapping[str, Any], name: str) -> float:
    """The largest value a parameter takes: its largest key when it is animated (no curve passes its keys), else
    its fixed value."""
    keys = effect.get("keyframes", {}).get(name) or []
    return max([float(key["value"]) for key in keys] or [float(effect[name])])


def _keyed(effect: Mapping[str, Any], name: str) -> bool:
    return bool(effect.get("keyframes", {}).get(name))


def _automation(target: str, commands: Mapping[str, str]) -> str:
    """The per-frame commands of one filter (nothing when every parameter is fixed), ready to precede it."""
    return command_filter(target, commands) + "," if commands else ""


def _plane(canvas: Canvas, luma: str, offset: int | None) -> str:
    """A grey plane of the canvas drawn by a ``geq`` expression: one frame when ``offset`` is None (a blend repeats
    it for every clip frame), else one per processed frame of the slice from ``offset`` on."""
    frames, tail = (1, "") if offset is None else (canvas.frames, f",setpts=N+{offset}")
    return (
        f"color=c=black:s={canvas.width}x{canvas.height}:r={canvas.rate},trim=end_frame={frames},format=gray,"
        f"geq=lum='{luma}'{tail}"
    )


def animated(container: Mapping[str, Any]) -> bool:
    """True when a key track really changes its value (constant keys are a fixed parameter)."""
    return any(len({point["value"] for point in points}) > 1 for points in container.get("keyframes", {}).values())


def _color(graph: list[str], current: str, effect: Mapping[str, Any], label: str, offset: int, _canvas: Canvas) -> str:
    if not any(effect.get("keyframes", {}).values()) and (
        effect["brightness"],
        effect["contrast"],
        effect["saturation"],
    ) == (0, 1, 1):
        return current
    frame = clock("n", offset)
    # eq negotiates YUV without alpha. Carry coverage independently so reordering
    # color after a key or blur cannot accidentally turn transparent pixels opaque.
    graph.append(f"[{current}]format=gbrap,split=2[{label}source][{label}coverage]")
    graph.append(f"[{label}coverage]alphaextract[{label}alpha]")
    graph.append(
        f"[{label}source]format=yuv444p,eq=brightness='{expression(effect, 'brightness', frame)}':"
        f"contrast='{expression(effect, 'contrast', frame)}':saturation='{expression(effect, 'saturation', frame)}':"
        f"eval=frame,format=gbrp[{label}rgb]"
    )
    graph.append(f"[{label}rgb][{label}alpha]alphamerge[{label}]")
    return label


def _chroma_key(
    graph: list[str], current: str, effect: Mapping[str, Any], label: str, offset: int, _canvas: Canvas
) -> str:
    # colorkey replaces alpha. Intersect the keyed coverage with the existing alpha
    # so multiple keys and earlier blurs retain their ordered, non-destructive meaning.
    color = f"0x{int(effect['color'][1:], 16):06x}"
    target = f"colorkey@{label}"
    frame = clock("(N-1)", offset)
    commands = {name: expression(effect, name, frame) for name in ("similarity", "blend") if _keyed(effect, name)}
    automation = _automation(target, commands)
    graph.append(f"[{current}]format=rgba,split=2[{label}source][{label}coverage]")
    graph.append(f"[{label}coverage]alphaextract[{label}original]")
    graph.append(
        f"[{label}source]{automation}{target}=color={color}:similarity={number(effect['similarity'])}:"
        f"blend={number(effect['blend'])},format=gbrap,split=2[{label}rgb][{label}key]"
    )
    graph.append(f"[{label}key]alphaextract[{label}keyalpha]")
    graph.append(f"[{label}original][{label}keyalpha]blend=all_mode=multiply:shortest=1[{label}alpha]")
    graph.append(f"[{label}rgb][{label}alpha]alphamerge[{label}]")
    return label


def _blur(graph: list[str], current: str, effect: Mapping[str, Any], label: str, offset: int, _canvas: Canvas) -> str:
    moving = _keyed(effect, "radius")
    if effect["radius"] == 0 and not moving:
        return current
    target = f"gblur@{label}"
    radius = expression(effect, "radius", clock("(N-1)", offset))
    # Update both axes: gblur may resolve sigmaV=-1 during initialization.
    automation = _automation(target, {"sigma": radius, "sigmaV": radius} if moving else {})
    # Blur premultiplied RGB and coverage together to avoid dark/colored
    # fringes at transparent edges, then restore straight alpha for overlay.
    graph.append(
        f"[{current}]format=gbrap,premultiply=inplace=1:planes=7,{automation}"
        f"{target}=sigma={number(effect['radius'])}:sigmaV={number(effect['radius'])}:steps=2:planes=15,"
        f"unpremultiply=inplace=1:planes=7,format=gbrap[{label}]"
    )
    return label


def _glow(graph: list[str], current: str, effect: Mapping[str, Any], label: str, offset: int, _canvas: Canvas) -> str:
    """Bloom in premultiplied 16-bit RGBA: weight = clip((luma - threshold) / (1 - threshold), 0, 1), the picture
    times its weight blurred by ``radius`` and scaled by ``intensity``, added to the colour; the glow's own coverage
    screens the alpha, so a glow reaches past a keyed or text picture onto what lies under it."""
    if _peak(effect, "intensity") <= 0:
        return current
    frame = clock("(N-1)", offset)
    threshold, radius, intensity = (expression(effect, name, frame) for name in ("threshold", "radius", "intensity"))
    floor = f"min({threshold},{GLOW_THRESHOLD_MAX})"
    level = number(min(float(effect["threshold"]), GLOW_THRESHOLD_MAX))
    luma = ":".join(f"{out}{src}={weight}" for out in "rgba" for src, weight in zip("rgb", LUMA, strict=True))
    levels = f"colorlevels@{label}level"
    graph.append(
        f"[{current}]format=gbrap16le,premultiply=inplace=1:planes=7,split=3[{label}src][{label}pass][{label}luma]"
    )
    level_commands = {f"{plane}imin": floor for plane in "rgba"} if _keyed(effect, "threshold") else {}
    graph.append(
        f"[{label}luma]colorchannelmixer={luma}:aa=0,{_automation(levels, level_commands)}"
        f"{levels}=rimin={level}:gimin={level}:bimin={level}:aimin={level}[{label}weight]"
    )
    graph.append(f"[{label}pass][{label}weight]blend=all_mode=multiply[{label}bright]")
    blurred = f"{label}bright"
    if _peak(effect, "radius") > 0:
        target = f"gblur@{label}blur"
        commands = {"sigma": radius, "sigmaV": radius} if _keyed(effect, "radius") else {}
        sigma = number(effect["radius"])
        graph.append(
            f"[{label}bright]{_automation(target, commands)}{target}=sigma={sigma}:sigmaV={sigma}:steps={GAUSS_STEPS}"
            f"[{label}soft]"
        )
        blurred = f"{label}soft"
    # colorchannelmixer takes gains up to 2: a stronger glow is two of them (min(I, 2), then max(1, I / 2)).
    gains = [(f"min({intensity},2)", min(float(effect["intensity"]), 2.0))]
    if _peak(effect, "intensity") > 2:
        gains.append((f"max(1,({intensity})/2)", max(1.0, float(effect["intensity"]) / 2)))
    mixers = []
    for step, (moving, fixed) in enumerate(gains):
        target = f"colorchannelmixer@{label}gain{step}"
        commands = dict.fromkeys(("rr", "gg", "bb", "aa"), moving) if _keyed(effect, "intensity") else {}
        gain = number(fixed)
        mixers.append(f"{_automation(target, commands)}{target}=rr={gain}:gg={gain}:bb={gain}:aa={gain}")
    graph.append(f"[{blurred}]{','.join(mixers)}[{label}glow]")
    graph.append(
        f"[{label}src][{label}glow]blend=c0_mode=addition:c1_mode=addition:c2_mode=addition:c3_mode=screen,"
        f"unpremultiply=inplace=1:planes=7,format=gbrap[{label}]"
    )
    return label


def _rgb_split(
    graph: list[str], current: str, effect: Mapping[str, Any], label: str, offset: int, _canvas: Canvas
) -> str:
    """Red moves ``offset`` pixels towards ``angle`` (0 = right, 90 = down), blue the opposite way, whole pixels."""
    if _peak(effect, "offset") <= 0:
        return current
    target = f"rgbashift@{label}"
    if _keyed(effect, "offset") or _keyed(effect, "angle"):
        frame = clock("(N-1)", offset)
        angle = f"(({expression(effect, 'angle', frame)})*PI/180)"
        dx = f"({expression(effect, 'offset', frame)})*cos({angle})"
        dy = f"({expression(effect, 'offset', frame)})*sin({angle})"
        commands = {"rh": dx, "rv": dy, "bh": f"-({dx})", "bv": f"-({dy})"}
        shift = "rh=0:rv=0:bh=0:bv=0"
    else:
        radians = math.radians(float(effect["angle"]))
        x, y = round(effect["offset"] * math.cos(radians)), round(effect["offset"] * math.sin(radians))
        commands, shift = {}, f"rh={x}:rv={y}:bh={-x}:bv={-y}"
    graph.append(f"[{current}]format=gbrap,{_automation(target, commands)}{target}={shift}:edge=smear[{label}]")
    return label


def vignette_luma(amount: str, softness: str) -> str:
    """The vignette's shade 0..255 as a ``geq`` expression (scratch registers 6-8).

    r is 0 at the centre and 1 in the corners (the frame's own ellipse); darkening is ``amount`` times a smooth step
    from r = 0.95 (1 - softness) to the corners.
    """
    inner = f"(0.95*(1-{softness}))"
    return (
        "st(6,(X+0.5)*2/W-1);st(7,(Y+0.5)*2/H-1);"
        f"st(8,clip((sqrt((ld(6)*ld(6)+ld(7)*ld(7))/2)-{inner})/(1-{inner}),0,1));"
        f"clip(255*(1-{amount}*ld(8)*ld(8)*(3-2*ld(8)))+0.5,0,255)"
    )


def _vignette(
    graph: list[str], current: str, effect: Mapping[str, Any], label: str, offset: int, canvas: Canvas
) -> str:
    """Colour times a shade plane (alpha unchanged): drawn once when it does not move, per frame when it is keyed."""
    if _peak(effect, "amount") <= 0:
        return current
    if _keyed(effect, "amount") or _keyed(effect, "softness"):
        prefix = frame_parameters(effect, ("amount", "softness"), clock("N", offset))
        shade = _plane(canvas, prefix + vignette_luma("ld(0)", "ld(1)"), offset)
    else:
        shade = _plane(canvas, vignette_luma(number(effect["amount"]), number(effect["softness"])), None)
    graph.append(f"{shade},format=gbrap[{label}shade]")
    graph.append(f"[{current}]format=gbrap[{label}base]")
    graph.append(f"[{label}base][{label}shade]blend=all_mode=multiply[{label}]")
    return label


def _hash(register: int, x: str, y: str, frame: str) -> str:
    """A hash in [0, 1) of a pixel and a frame (Hoskins' hash13; scratch registers 1-4) stored in ``register``."""
    return (
        f"st(1,({x})*0.1031);st(1,ld(1)-floor(ld(1)));st(2,({y})*0.1031);st(2,ld(2)-floor(ld(2)));"
        f"st(3,({frame})*0.1031);st(3,ld(3)-floor(ld(3)));"
        "st(4,ld(1)*(ld(3)+31.32)+ld(2)*(ld(2)+31.32)+ld(3)*(ld(1)+31.32));"
        f"st({register},(ld(1)+ld(2)+2*ld(4))*(ld(3)+ld(4)));st({register},ld({register})-floor(ld({register})));"
    )


def grain_luma(amount: str, frame: str) -> str:
    """Monochrome grain around 128 as a ``geq`` expression: triangular noise (two hashes) scaled by ``amount``."""
    scale = number(255 * GRAIN_AMPLITUDE)
    return (
        _hash(6, "X", "Y", frame)
        + _hash(7, "X+37", "Y+91", frame)
        + f"clip(128.5+{scale}*{amount}*(ld(6)+ld(7)-1),0,255)"
    )


def _grain(graph: list[str], current: str, effect: Mapping[str, Any], label: str, offset: int, canvas: Canvas) -> str:
    """The same noise added to red, green and blue (alpha unchanged); a function of the pixel and the processed frame."""
    if _peak(effect, "amount") <= 0:
        return current
    frame = clock("N", offset)
    if _keyed(effect, "amount"):
        luma = frame_parameters(effect, ("amount",), frame) + grain_luma("ld(0)", frame)
    else:
        luma = grain_luma(number(effect["amount"]), frame)
    graph.append(f"{_plane(canvas, luma, offset)},format=gbrap[{label}noise]")
    graph.append(f"[{current}]format=gbrap[{label}base]")
    graph.append(f"[{label}base][{label}noise]blend=c0_mode=grainmerge:c1_mode=grainmerge:c2_mode=grainmerge[{label}]")
    return label


def _directional_blur(
    graph: list[str], current: str, effect: Mapping[str, Any], label: str, offset: int, canvas: Canvas
) -> str:
    """A Gaussian streak along ``angle`` (sigma = length / 4) in premultiplied 16-bit RGBA.

    Along an axis it is one ``gblur`` axis. Any other angle turns the picture so the streak runs horizontally and
    back (``rotate`` itself works on 8 bits): the picture is first widened by smeared edges (three sigma), so the
    edges blur as an axis blur's do.
    """
    if _peak(effect, "length") <= 0:
        return current
    target = f"gblur@{label}"
    sigma = number(float(effect["length"]) * STREAK_SIGMA)
    moving = f"({expression(effect, 'length', clock('(N-1)', offset))})*{STREAK_SIGMA}"
    axis = None if _keyed(effect, "angle") else float(effect["angle"]) % 180
    name, other = ("sigmaV", "sigma") if axis == 90 else ("sigma", "sigmaV")
    commands = {name: moving} if _keyed(effect, "length") else {}
    streak = f"{_automation(target, commands)}{target}={name}={sigma}:{other}=0:steps={GAUSS_STEPS}"
    head = f"[{current}]format=gbrap16le,premultiply=inplace=1:planes=7,"
    tail = f"format=gbrap16le,unpremultiply=inplace=1:planes=7,format=gbrap[{label}]"
    if axis in (0, 90):
        graph.append(f"{head}{streak},{tail}")
        return label
    margin = math.ceil(3 * _peak(effect, "length") * STREAK_SIGMA) + 2
    padded_w, padded_h = canvas.width + 2 * margin, canvas.height + 2 * margin
    side = math.ceil(math.hypot(padded_w, padded_h))
    side += side % 2
    if _keyed(effect, "angle"):
        angle = f"(({expression(effect, 'angle', clock('n', offset))})*PI/180)"
    else:
        angle = number(math.radians(float(effect["angle"])))
    turn = f"ow={side}:oh={side}:c=black@0"
    graph.append(
        f"{head}pad={padded_w}:{padded_h}:{margin}:{margin}:color=black@0,"
        f"fillborders=left={margin}:right={margin}:top={margin}:bottom={margin}:mode=smear,format=gbrap,"
        f"rotate=a='-{angle}':{turn},format=gbrap16le,{streak},format=gbrap,"
        f"rotate=a='{angle}':{turn},crop={canvas.width}:{canvas.height}:{(side - canvas.width) // 2}:"
        f"{(side - canvas.height) // 2},{tail}"
    )
    return label


def _sharpen_levels(amount: float) -> dict[str, float]:
    """colorlevels that scale a detail plane around 0.5 by ``amount``: by the input range from 1 on, below 1 by the
    output range (0 leaves the plane at 0.5: no change)."""
    stretched = amount > 1
    values = {
        "imin": 0.5 - 0.5 / amount if stretched else 0.0,
        "imax": 0.5 + 0.5 / amount if stretched else 1.0,
        "omin": 0.0 if stretched else 0.5 - 0.5 * amount,
        "omax": 1.0 if stretched else 0.5 + 0.5 * amount,
    }
    return {f"{plane}{name}": value for plane in "rgb" for name, value in values.items()}


def _sharpen_commands(amount: str) -> dict[str, str]:
    """``_sharpen_levels`` as per-frame expressions of an animated amount."""
    stretched = f"gt({amount},1)"
    values = {
        "imin": f"if({stretched},0.5-0.5/({amount}),0)",
        "imax": f"if({stretched},0.5+0.5/({amount}),1)",
        "omin": f"if({stretched},0,0.5-0.5*{amount})",
        "omax": f"if({stretched},1,0.5+0.5*{amount})",
    }
    return {f"{plane}{name}": value for plane in "rgb" for name, value in values.items()}


def _sharpen(
    graph: list[str], current: str, effect: Mapping[str, Any], label: str, offset: int, _canvas: Canvas
) -> str:
    """Unsharp mask in 16 bits: colour + amount x (colour - Gaussian(colour)) on premultiplied RGB; alpha unchanged."""
    if _peak(effect, "amount") <= 0:
        return current
    target = f"colorlevels@{label}"
    animated_amount = _keyed(effect, "amount")
    commands = _sharpen_commands(expression(effect, "amount", clock("(N-1)", offset))) if animated_amount else {}
    levels = ":".join(f"{name}={number(value)}" for name, value in _sharpen_levels(float(effect["amount"])).items())
    sigma = number(SHARPEN_SIGMA)
    graph.append(f"[{current}]format=gbrap16le,premultiply=inplace=1:planes=7,split=3[{label}a][{label}b][{label}c]")
    graph.append(f"[{label}b]gblur=sigma={sigma}:sigmaV={sigma}:steps={GAUSS_STEPS}:planes=7[{label}soft]")
    graph.append(
        f"[{label}a][{label}soft]blend=c0_mode=grainextract:c1_mode=grainextract:c2_mode=grainextract[{label}detail]"
    )
    graph.append(f"[{label}detail]{_automation(target, commands)}{target}={levels}[{label}gain]")
    graph.append(
        f"[{label}c][{label}gain]blend=c0_mode=grainmerge:c1_mode=grainmerge:c2_mode=grainmerge,"
        f"unpremultiply=inplace=1:planes=7,format=gbrap[{label}]"
    )
    return label


Effect = Callable[[list[str], str, Mapping[str, Any], str, int, Canvas], str]
_EFFECTS: Mapping[str, Effect] = {
    "color": _color,
    "blur": _blur,
    "chroma_key": _chroma_key,
    "glow": _glow,
    "rgb_split": _rgb_split,
    "vignette": _vignette,
    "grain": _grain,
    "directional_blur": _directional_blur,
    "sharpen": _sharpen,
}


def append_effect_stack(
    graph: list[str], current: str, stack: Sequence[Mapping[str, Any]], index: int, offset: int, canvas: Canvas
) -> str:
    """At most eight effects per clip; disabled and identity effects allocate no filters."""
    for order, effect in enumerate(stack):
        if not effect["enabled"]:
            continue
        compile_effect = _EFFECTS.get(effect["kind"])
        if compile_effect is None:
            raise ComponentError("INVALID_ARGUMENT", "時間軸效果種類不支援")
        current = compile_effect(graph, current, effect, f"effect{index}_{order}", offset, canvas)
    return current


def mask_luma(mask: Mapping[str, Any], frame: str = "N") -> str:
    """Coverage 0..255 of a pixel as a ``geq`` expression (``X``, ``Y``, ``W``, ``H``; parameters cached per frame)."""
    prefix = frame_parameters(mask, ("x", "y", "width", "height", "feather"), frame)
    x, y, width, height, feather = (f"ld({index})" for index in range(5))
    if mask["kind"] == "rectangle":
        distance = f"min(min(X+0.5-({x})*W,({x}+{width})*W-X-0.5),min(Y+0.5-({y})*H,({y}+{height})*H-Y-0.5))"
    else:
        dx = f"((X+0.5-({x}+{width}/2)*W)/({width}*W/2))"
        dy = f"((Y+0.5-({y}+{height}/2)*H)/({height}*H/2))"
        distance = f"((1-sqrt({dx}*{dx}+{dy}*{dy}))*min({width}*W/2,{height}*H/2))"
    progress = f"clip(({distance})/({feather}*min(W,H)),0,1)"
    coverage = f"if(gt({feather},0),({progress}*{progress}*(3-2*{progress})),gte({distance},0))"
    if mask["invert"]:
        coverage = f"(1-({coverage}))"
    return f"{prefix}255*({coverage})"


def append_mask(
    graph: list[str], current: str, mask: Mapping[str, Any] | None, label: str, offset: int, canvas: Canvas
) -> str:
    """Multiply a shape into the alpha of a clip.

    The shape is one grey plane: computed once when it does not move, per frame when it is keyed.
    Colour planes are never touched (the earlier per-pixel copy of red, green and blue is gone).
    """
    if mask is None:
        return current
    if animated(mask):
        shape = _plane(canvas, mask_luma(mask, clock("N", offset)), offset)
    else:
        shape = _plane(canvas, mask_luma(mask), None)
    graph.append(f"{shape}[{label}shape]")
    graph.append(f"[{current}]format=gbrap,split=2[{label}source][{label}coverage]")
    graph.append(f"[{label}coverage]alphaextract[{label}alpha]")
    graph.append(f"[{label}alpha][{label}shape]blend=all_mode=multiply[{label}masked]")
    graph.append(f"[{label}source][{label}masked]alphamerge[{label}]")
    return label


def append_blend(
    graph: list[str],
    base: int,
    placed: str,
    mode: str,
    start: int,
    end: int,
    *,
    background: str | None = None,
    padded: bool = False,
) -> None:
    """Blend RGB against the opaque accumulated canvas, then apply source coverage.

    FFmpeg blend does not implement Porter-Duff source-over. Its RGB result must
    regain the original layer alpha before overlay; otherwise masked areas change
    the backdrop and multiply/screen erase the meaning of clip opacity.

    ``background`` names the canvas when it is not ``base{base}`` (an adjustment layer split it to read it);
    ``padded`` says the layer already starts at the segment's first frame with a transparent lead-in.
    """
    background = background or f"base{base}"
    layer = placed
    if mode != "normal":
        blend = {"multiply": "multiply", "screen": "screen", "add": "addition"}[mode]
        tag = f"blend{base}"
        # Pad transparent lead-in before splitting so both framesync branches start
        # together; a late overlay must not queue the full background prefix.
        aligned = f"{tag}aligned"
        lead = "" if padded else f",setpts=PTS-STARTPTS,tpad=start_mode=add:start={start}:color=black@0"
        graph.append(f"[{placed}]format=gbrap{lead}[{aligned}]")
        graph.append(f"[{background}]split=2[{tag}background][{tag}backdrop]")
        graph.append(f"[{tag}backdrop]format=gbrp[{tag}backrgb]")
        graph.append(f"[{aligned}]split=2[{tag}source][{tag}coverage]")
        if mode == "add":
            # CSS plus-lighter adds premultiplied source color to the opaque
            # backdrop: min(1, alpha * source + backdrop), without a second alpha.
            # Colour times coverage is computed on plain RGB planes. A premultiply filter marks its
            # frames as premultiplied, and FFmpeg then converts them back to straight alpha on its own
            # before the alpha plane is dropped, which silently removed the clip's opacity from this blend.
            graph.append(f"[{tag}coverage]alphaextract,format=gbrp[{tag}alpha]")
            graph.append(f"[{tag}source]format=gbrp[{tag}straight]")
            graph.append(f"[{tag}straight][{tag}alpha]blend=all_mode=multiply[{tag}rgb]")
            graph.append(f"[{tag}rgb][{tag}backrgb]blend=all_mode=addition:shortest=1:repeatlast=0[{tag}layer]")
        else:
            graph.append(f"[{tag}coverage]alphaextract[{tag}alpha]")
            graph.append(f"[{tag}source]format=gbrp[{tag}rgb]")
            graph.append(f"[{tag}rgb][{tag}backrgb]blend=all_mode={blend}:shortest=1:repeatlast=0[{tag}mixed]")
            graph.append(f"[{tag}mixed][{tag}alpha]alphamerge[{tag}layer]")
        background, layer = f"{tag}background", f"{tag}layer"
    graph.append(
        f"[{background}][{layer}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=auto:alpha=straight:"
        f"enable='between(n,{start},{end - 1})'[base{base + 1}]"
    )
