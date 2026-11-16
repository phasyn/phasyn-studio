"""FFmpeg graph of one video segment of a multitrack export.

One process renders the frames ``[segment.start, segment.end)`` of the sequence: every clip the
segment shows is one input, read from its own seek point, and processed on one RGBA chain from
the processed frame the segment needs (never from the start of the clip). Layers composite in
planar RGB over black, bottom to top, and the result is converted once to BT.709 limited-range
4:2:0.

Per clip, in this order: timing (source range on the sequence grid, speed, frame step, holds),
fit to the canvas with transparent bars, camera, the older colour controls, title, effect stack,
mask, fades, motion. Every per-frame expression counts processed frames of the clip, so a frame
looks the same whichever segment renders it.

An adjustment layer reads no file. Where it comes in the compositing order, the canvas so far is
split; its frames in the clip's range become the clip's picture, on the clip's processed clock,
and go through the same chain as any clip from the older colour controls on (effect stack, mask,
fades on its coverage, so the adjustment eases in and out instead of fading to black, opacity);
the result is blended back over the canvas with the clip's blend mode, only within its frames.

Transitions are sums of the two clips in premultiplied alpha with per-frame weights, the same
weights as the earlier per-pixel expression. A moving transition (push, slide, whip, wipe, zoom)
moves and scales the two pictures with sub-pixel ``perspective`` maps and weights them per pixel:
the canvas rectangle of the picture that comes in front hides the one behind it (whatever its
alpha holds, so nothing shows through and vanishes at the cut), and a wipe is a moving soft edge.
Its movement follows the transition's easing; overlap and frame accounting are a cross-fade's.
Each clip also feeds a 2x2 probe, drawn outside the picture, whose end stops the segment: a clip
that delivers fewer frames than planned makes the segment short, which the exporter refuses,
instead of leaving a silent hole in the film.

Only validated numbers and compiler-owned labels enter the graph; names, text and paths never do.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any

from phasyn_components.timeline import curve_value

from ._validate import filter_number
from .composition import (
    BoundedGraph,
    ClipSlice,
    CompositionClip,
    CompositionPlan,
    Segment,
    plain_clip,
    retimed_index,
    stepped_index,
    title_in_slice,
)
from .composition_curves import command_filter, eased, expression, number
from .composition_effects import GAUSS_STEPS, Canvas, append_blend, append_effect_stack, append_mask, clock
from .effects import ClipEffects, Transition, camera_chain, impact_chain

# Conversions round correctly and interpolate chroma at full resolution: the default fast paths darken the
# picture by about half a code value per RGB round trip.
ACCURATE = "accurate_rnd+full_chroma_int"
SWS_FLAGS = f"bicubic+{ACCURATE}"
OUTPUT_FORMAT = "format=pix_fmts=yuv420p:color_spaces=bt709:color_ranges=tv"
# Transparent border around a transformed picture: the resampler repeats edge pixels outside its source.
TRANSFORM_PAD = 2
# Above this size the per-frame corner expressions of an animated transform become per-frame tables.
TRANSFORM_EXPRESSION_BYTES = 16 * 1024
# A zoom transition travels through this factor: in, the outgoing picture grows to it while the incoming one grows
# from its inverse to full size; out, the reverse.
ZOOM_FACTOR = 2
# A whip's blur at the middle of its movement: sigma as a share of the distance the pictures travel.
WHIP_BLUR = 0.035
# Where the pictures of a moving transition go (sequence pixels grow right and down).
EDGES = {"left": (-1, 0), "right": (1, 0), "up": (0, -1), "down": (0, 1)}


@dataclass(frozen=True)
class MediaInput:
    """One opened clip file. ``time_base`` and ``start_pts`` describe its video stream (``None`` for a still)."""

    index: int
    time_base: Fraction | None = None
    start_pts: int = 0
    declare: str = ""  # ``setparams`` options for colour properties the file does not state
    opaque_cover: bool = False  # the file's picture has no alpha and fills the canvas under the sequence fit
    resize: bool = True  # the file's frames are not canvas sized


@dataclass(frozen=True)
class RasterInput:
    """A title or caption picture: drawn by the exporter (cropped, at ``x``/``y``) or uploaded (canvas sized)."""

    index: int
    x: int = 0
    y: int = 0
    fitted: bool = False


@dataclass(frozen=True)
class SegmentInputs:
    media: Mapping[int, MediaInput] = field(default_factory=dict)  # by position in Segment.slices
    titles: Mapping[int, RasterInput] = field(default_factory=dict)  # by position in Segment.slices
    caption_images: Mapping[int, RasterInput] = field(default_factory=dict)  # by caption index
    caption_track: RasterInput | None = None
    direct: bool = False  # every clip is plain, opaque and canvas filling: compose without RGB (``direct_segment``)


@dataclass(frozen=True)
class _Piece:
    """A layer of the segment: one clip alone, or the overlap of two clips in a transition."""

    start: int  # segment-local frames
    end: int
    members: tuple[int | None, ...]  # positions in Segment.slices; ``None`` is a disabled clip
    mode: str
    transition: Transition | None = None  # the transition of a mix
    progress: int = 0  # transition frame shown at ``start``


@dataclass(frozen=True)
class _Place:
    """Where one picture of a moving transition is drawn: moved by (``dx``, ``dy``) pixels and scaled by ``scale``
    about the centre, as expressions of the eased progress."""

    dx: str = "0"
    dy: str = "0"
    scale: str = "1"

    @property
    def still(self) -> bool:
        return (self.dx, self.dy, self.scale) == ("0", "0", "1")


def _rate(fps: Fraction) -> str:
    return f"{fps.numerator}/{fps.denominator}"


def _seconds(frames: int, fps: Fraction) -> str:
    return f"{float(Fraction(frames) / fps):.9f}"


def source_range(clip: CompositionClip, item: ClipSlice) -> tuple[int, int]:
    """First and last source frame (sequence rate) the slice decodes."""
    speed = clip.plan.effects.speed_percent if clip.plan.effects else 100
    first = stepped_index(clip, retimed_index(clip, item.first))
    last = stepped_index(clip, retimed_index(clip, item.end - 1))
    start = int(clip.document["in_frame"])
    return start + first * speed // 100, start + last * speed // 100


# --------------------------------------------------------------------------- one clip


def _timing(clip: CompositionClip, item: ClipSlice, media: MediaInput, fps: Fraction) -> list[str]:
    """Exactly ``item.frames`` frames of a video source with PTS = processed frame number (time base 1/fps)."""
    if media.time_base is None:
        raise ValueError("a video clip needs the clock of its source")
    effects = clip.plan.effects
    speed = effects.speed_percent if effects else 100
    step = effects.frame_step if effects else 1
    head = effects.hold.start if effects else 0
    rate = _rate(fps)
    shown_first, shown_last = retimed_index(clip, item.first), retimed_index(clip, item.end - 1)
    first, last = stepped_index(clip, shown_first), stepped_index(clip, shown_last)
    low, high = source_range(clip, item)
    parts = [
        f"settb=expr={media.time_base.numerator}/{media.time_base.denominator}",
        f"setpts=PTS-({media.start_pts})",
        f"fps={rate}",
        f"trim=start_pts={low}:end_pts={high + 1}",
        f"setpts=PTS-{clip.document['in_frame']}",
    ]
    if speed != 100:
        # Retimed frame r shows source frame floor(r*speed/100): put source frame k at ceil(100*k/speed) by
        # nearest rounding on a grid of half output frames per speed step (exact integers, no time fudge).
        last_source = last * speed // 100
        parts += [
            f"settb=expr={fps.denominator}/{2 * speed * fps.numerator}",
            f"setpts=PTS*100/{speed}+{speed - 2}",
            f"fps={rate}",
            f"tpad=stop_mode=clone:stop={last - math.ceil(Fraction(100 * last_source, speed))}",
            f"trim=start_pts={first}:end_pts={last + 1}",
        ]
    if step > 1:
        parts += [
            f"select='not(mod(pts\\,{step}))'",
            f"fps={rate}",
            f"tpad=stop_mode=clone:stop={step - 1}",
            f"trim=start_pts={shown_first}:end_pts={shown_last + 1}",
        ]
    lead = min(max(0, head - item.first), item.frames - 1)
    tail = item.frames - 1 - (shown_last - shown_first) - lead
    if lead or tail:
        parts.append(f"tpad=start_mode=clone:start={lead}:stop_mode=clone:stop={tail}")
    parts.append(f"setpts=N+{item.first}")
    return parts


def _still(item: ClipSlice, fps: Fraction) -> list[str]:
    """One picture held for the slice, with the same PTS convention as a video clip."""
    return [
        "loop=loop=-1:size=1:start=0",
        f"trim=end_frame={item.frames}",
        f"settb=expr={fps.denominator}/{fps.numerator}",
        f"setpts=N+{item.first}",
    ]


def _fit(width: int, height: int, fit: str | None) -> list[str]:
    """Scale to the canvas as planar RGBA in one conversion; what the picture does not cover stays transparent."""
    flags = f"{'lanczos' if fit else 'bicubic'}+{ACCURATE}"
    if fit == "cover":
        return [
            f"scale={width}:{height}:force_original_aspect_ratio=increase:flags={flags}",
            f"crop={width}:{height}",
            "format=gbrap",
            "setsar=1",
        ]
    return [
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags={flags}",
        "format=gbrap",
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black@0",
        "setsar=1",
    ]


def _legacy_color(graph: list[str], current: str, effects: ClipEffects | None, label: str, offset: int) -> str:
    """Invert, eq and impact frames keep their YUV meaning; coverage travels beside them."""
    if effects is None:
        return current
    operations: list[str] = []
    if effects.color.invert:
        operations.append("negate")
    if not effects.color.eq_identity:
        color = effects.color
        operations.append(
            f"eq=brightness={filter_number(color.brightness)}:contrast={filter_number(color.contrast)}:"
            f"saturation={filter_number(color.saturation)}"
        )
    if effects.impact is not None:
        operations += impact_chain(effects.impact, clock=clock("n", offset))
    if not operations:
        return current
    graph.append(f"[{current}]format=gbrap,split=2[{label}source][{label}coverage]")
    graph.append(f"[{label}coverage]alphaextract[{label}alpha]")
    graph.append(
        f"[{label}source]format=pix_fmts=yuv444p:color_spaces=bt709:color_ranges=tv,"
        f"{','.join(operations)},format=gbrp[{label}rgb]"
    )
    graph.append(f"[{label}rgb][{label}alpha]alphamerge[{label}]")
    return label


def _fades(clip: CompositionClip, item: ClipSlice, fps: Fraction) -> list[str]:
    """Fades from and to black: the colour is multiplied by ``k / frames`` and the coverage is kept.

    That is the editor's ``videoFadeFactor`` applied to the colour of the clip (``clipRenderer.ts``), and
    a linear fade from black for an opaque clip. FFmpeg's black fade scales every byte of a packed RGBA
    frame, alpha included (a fade of f then shows f squared over black); on planar ``gbrap`` it scales the
    three colour planes only. An adjustment layer's fades scale its coverage instead (``alpha``): its
    adjustment eases in and out over the picture below, which never fades to black.
    """
    effects = clip.plan.effects
    if effects is None:
        return []
    out: list[str] = []
    coverage = ":alpha=1" if clip.adjustment else ""
    fade_in, fade_out = effects.fade.video_in, effects.fade.video_out
    if fade_in and item.first < fade_in:
        out.append(f"fade=t=in:st=0:d={_seconds(fade_in, fps)}{coverage}")
    start = clip.plan.frames - fade_out - 1
    if fade_out and item.end > start:
        out.append(f"fade=t=out:st={_seconds(start, fps)}:d={_seconds(fade_out, fps)}{coverage}")
    return ["format=gbrap", *out] if out else []


def _constant(motion: Mapping[str, Any], name: str) -> float | None:
    points = motion["keyframes"].get(name, [])
    if not points:
        return float(motion[name])
    value = float(points[0]["value"])
    return value if all(point["value"] == value for point in points) else None


def _corner_offsets(width: int, height: int) -> tuple[tuple[float, float], ...]:
    half_w, half_h = width / 2 + TRANSFORM_PAD, height / 2 + TRANSFORM_PAD
    return ((-half_w, -half_h), (half_w, -half_h), (-half_w, half_h), (half_w, half_h))


def _corners(motion: Sequence[float], size: tuple[int, int]) -> list[float]:
    """Where the corners of the padded picture land (padded canvas coordinates), as the affine map of the editor."""
    x, y, scale, degrees = motion
    width, height = size
    angle = math.radians(degrees)
    out: list[float] = []
    for du, dv in _corner_offsets(width, height):
        out.append(width / 2 + TRANSFORM_PAD + x * width + scale * (math.cos(angle) * du - math.sin(angle) * dv))
        out.append(height / 2 + TRANSFORM_PAD + y * height + scale * (math.sin(angle) * du + math.cos(angle) * dv))
    return out


def _corner_expressions(motion: Mapping[str, Any], size: tuple[int, int], frame: str) -> list[str]:
    width, height = size
    x, y, scale, rotation = (expression(motion, name, frame) for name in ("x", "y", "scale", "rotation"))
    angle = f"(({rotation})*PI/180)"
    out: list[str] = []
    for du, dv in _corner_offsets(width, height):
        out.append(
            f"{number(width / 2 + TRANSFORM_PAD)}+({x})*{width}+({scale})*(cos({angle})*({number(du)})-sin({angle})*({number(dv)}))"
        )
        out.append(
            f"{number(height / 2 + TRANSFORM_PAD)}+({y})*{height}+({scale})*(sin({angle})*({number(du)})+cos({angle})*({number(dv)}))"
        )
    return out


def _table(values: Sequence[float], frame: str, first: int = 0) -> str:
    """A balanced lookup of per-frame values (index ``frame`` counted from ``first``)."""
    if len(values) == 1:
        return number(values[0])
    middle = len(values) // 2
    left, right = _table(values[:middle], frame, first), _table(values[middle:], frame, first + middle)
    return f"if(lt({frame},{first + middle}),{left},{right})"


def _corner_tables(motion: Mapping[str, Any], size: tuple[int, int], item: ClipSlice) -> list[str]:
    """Per-frame corners evaluated here with the document's own curve arithmetic (many or heavy keys)."""
    keys = motion["keyframes"]
    rows = [
        _corners(
            [curve_value(keys.get(name, []), frame, motion[name]) for name in ("x", "y", "scale", "rotation")], size
        )
        for frame in range(item.first, item.end)
    ]
    return [_table([row[column] for row in rows], "(in-1)") for column in range(8)]


def _transform(motion: Mapping[str, Any], size: tuple[int, int], item: ClipSlice) -> list[str]:
    """Scale, rotate and move in one resampling of premultiplied RGBA (bilinear, sub-pixel, antialiased edges)."""
    fixed = [_constant(motion, name) for name in ("x", "y", "scale", "rotation")]
    if fixed == [0, 0, 1, 0]:
        return []
    width, height = size
    names = ("x0", "y0", "x1", "y1", "x2", "y2", "x3", "y3")
    if all(value is not None for value in fixed):
        values = [number(value) for value in _corners([float(value or 0) for value in fixed], size)]
        evaluation = "init"
    else:
        values = _corner_expressions(motion, size, clock("(in-1)", item.first))
        if sum(len(value) for value in values) > TRANSFORM_EXPRESSION_BYTES:
            values = _corner_tables(motion, size, item)
        evaluation = "frame"
    corners = ":".join(f"{name}='{value}'" for name, value in zip(names, values, strict=True))
    padded = f"{width + 2 * TRANSFORM_PAD}:{height + 2 * TRANSFORM_PAD}:{TRANSFORM_PAD}:{TRANSFORM_PAD}"
    return [
        "format=gbrap",
        "premultiply=inplace=1:planes=7",
        f"pad={padded}:color=black@0",
        f"perspective={corners}:sense=destination:interpolation=linear:eval={evaluation}",
        f"crop={width}:{height}:{TRANSFORM_PAD}:{TRANSFORM_PAD}",
        "unpremultiply=inplace=1:planes=7",
    ]


def _opacity(motion: Mapping[str, Any], label: str, offset: int) -> list[str]:
    fixed = _constant(motion, "opacity")
    if fixed == 1:
        return []
    if fixed is not None:
        return ["format=gbrap", f"colorchannelmixer=aa={number(fixed)}"]
    target = f"colorchannelmixer@{label}opacity"
    automation = command_filter(target, {"aa": expression(motion, "opacity", clock("(N-1)", offset))})
    return ["format=gbrap", automation, f"{target}=aa=1"]


def _step(graph: list[str], current: str, filters: Sequence[str], label: str) -> str:
    if not filters:
        return current
    graph.append(f"[{current}]{','.join(filters)}[{label}]")
    return label


def _title(
    graph: list[str],
    current: str,
    clip: CompositionClip,
    item: ClipSlice,
    raster: RasterInput | None,
    label: str,
    size: tuple[int, int],
) -> str:
    """Draw the clip title over the fitted picture for its frames (a text layer is its title already)."""
    title = clip.title
    if title is None or clip.generated or not title_in_slice(clip, item.first, item.end):
        return current
    if raster is None:
        raise ValueError("a titled clip needs its title picture")
    graph.append(f"[{raster.index}:v:0]{_raster(raster, size)}[{label}image]")
    frame = clock("n", item.first)
    graph.append(
        f"[{current}][{label}image]overlay=x={raster.x}:y={raster.y}:eof_action=repeat:format=auto:"
        f"enable='between({frame},{title.start_frame},{title.end_frame - 1})'[{label}]"
    )
    return label


def _raster(raster: RasterInput, size: tuple[int, int]) -> str:
    """An uploaded raster is scaled to the canvas as before; a drawn one is already in canvas pixels."""
    return f"scale={size[0]}:{size[1]},format=rgba" if raster.fitted else "format=rgba"


def _picture(
    graph: list[str],
    plan: CompositionPlan,
    clip: CompositionClip,
    item: ClipSlice,
    position: int,
    inputs: SegmentInputs,
) -> str:
    """The fitted RGBA picture of a clip for the slice's frames."""
    width, height, fps = plan.width, plan.height, plan.fps
    label = f"fit{position}"
    if clip.generated:
        raster = inputs.titles[position]
        place = (
            f"scale={width}:{height}" if raster.fitted else f"pad={width}:{height}:{raster.x}:{raster.y}:color=black@0"
        )
        graph.append(f"[{raster.index}:v:0]format=gbrap,{place},setsar=1,{','.join(_still(item, fps))}[{label}]")
        return label
    media = inputs.media[position]
    declare = [f"setparams={media.declare}"] if media.declare else []
    timing = _still(item, fps) if clip.still else _timing(clip, item, media, fps)
    chain = [*declare, *timing, *_fit(width, height, plan.fit)]
    graph.append(f"[{media.index}:V:0]{','.join(chain)}[{label}]")  # V: never an attached cover picture
    return label


def _look(graph: list[str], plan: CompositionPlan, item: ClipSlice, position: int, current: str) -> str:
    """The effect stack and the mask of a clip's picture (an adjustment layer's too), from the slice's first frame."""
    clip = plan.clips[item.clip]
    canvas = Canvas(plan.width, plan.height, _rate(plan.fps), item.frames)
    current = append_effect_stack(graph, current, clip.document.get("effect_stack", []), position, item.first, canvas)
    return append_mask(graph, current, clip.document.get("mask"), f"mask{position}", item.first, canvas)


def _finish(plan: CompositionPlan, item: ClipSlice, position: int) -> list[str]:
    """The last filters of every clip picture: fades, motion and opacity, in planar RGBA."""
    clip = plan.clips[item.clip]
    motion = clip.document["motion"]
    return [
        *_fades(clip, item, plan.fps),
        *_transform(motion, (plan.width, plan.height), item),
        *_opacity(motion, f"clip{position}", item.first),
        "format=gbrap",
    ]


def _clip_stream(
    graph: list[str],
    plan: CompositionPlan,
    segment: Segment,
    position: int,
    inputs: SegmentInputs,
    consumers: Sequence[str],
) -> None:
    """Emit the processed frames of one slice (segment-local PTS) to each consumer label."""
    item = segment.slices[position]
    clip = plan.clips[item.clip]
    size = (plan.width, plan.height)
    effects, offset = clip.plan.effects, item.first
    current = _picture(graph, plan, clip, item, position, inputs)
    if effects is not None and not clip.generated:
        camera = camera_chain(
            effects.camera, width=plan.width, height=plan.height, clock=clock("n", offset), flags=f"lanczos+{ACCURATE}"
        )
        current = _step(graph, current, camera, f"camera{position}")
        current = _legacy_color(graph, current, effects, f"legacy{position}", offset)
    current = _title(graph, current, clip, item, inputs.titles.get(position), f"titled{position}", size)
    current = _look(graph, plan, item, position, current)
    tail = [*_finish(plan, item, position), f"setpts=N+{item.at}"]
    if len(consumers) > 1:
        tail.append(f"split={len(consumers)}")
    graph.append(f"[{current}]{','.join(tail)}{''.join(f'[{name}]' for name in consumers)}")


def _adjusted(graph: list[str], plan: CompositionPlan, segment: Segment, position: int, base: int) -> tuple[str, str]:
    """An adjustment layer over the canvas so far (``base{base}``): (the canvas, the layer to blend back over it).

    The canvas is split: its frames in the clip's range are the clip's picture, on its processed clock, and go
    through a clip's chain from the older colour controls on. The layer starts with transparent frames from the
    segment's first frame, so the canvas it was split from never waits for it.
    """
    item = segment.slices[position]
    clip = plan.clips[item.clip]
    label = f"adjust{position}"
    graph.append(f"[base{base}]split=2[{label}under][{label}source]")
    graph.append(
        f"[{label}source]trim=start_frame={item.at}:end_frame={item.at + item.frames},setpts=N+{item.first},"
        f"format=gbrap[{label}picture]"
    )
    current = _legacy_color(graph, f"{label}picture", clip.plan.effects, f"legacy{position}", item.first)
    current = _look(graph, plan, item, position, current)
    lead = [f"tpad=start_mode=add:start={item.at}:color=black@0"] if item.at else []
    graph.append(f"[{current}]{','.join([*_finish(plan, item, position), 'setpts=N', *lead])}[{label}]")
    return f"{label}under", label


# --------------------------------------------------------------------------- layers of the segment


def _transition(clip: CompositionClip) -> Transition | None:
    effects = clip.plan.effects
    return effects.transition_out if effects else None


def _pieces(plan: CompositionPlan, segment: Segment) -> list[_Piece]:
    """Layers in compositing order: per transition chain, each clip alone and each overlap of two clips."""
    positions = {item.clip: position for position, item in enumerate(segment.slices)}
    pieces: list[_Piece] = []

    def local(start: int, end: int) -> tuple[int, int] | None:
        start, end = max(start, segment.start), min(end, segment.end)
        return (start - segment.start, end - segment.start) if start < end else None

    for group in plan.groups:
        if not plan.clips[group[0]].is_video:
            continue
        mode = str(plan.clips[group[0]].document.get("blend_mode", "normal"))
        incoming = 0
        for order, index in enumerate(group):
            clip = plan.clips[index]
            following = plan.clips[group[order + 1]] if order + 1 < len(group) else None
            outgoing = _transition(clip) if following is not None else None
            overlap = outgoing.frames if outgoing else 0
            alone = local(clip.start + incoming, clip.end - overlap)
            if alone and clip.enabled:
                pieces.append(_Piece(alone[0], alone[1], (positions[index],), mode))
            mixed = local(clip.end - overlap, clip.end) if outgoing and following else None
            if mixed and outgoing and following and (clip.enabled or following.enabled):
                members = (
                    positions[index] if clip.enabled else None,
                    positions[group[order + 1]] if following.enabled else None,
                )
                progress = mixed[0] + segment.start - following.start
                pieces.append(_Piece(mixed[0], mixed[1], members, mode, outgoing, progress))
            incoming = overlap
    return pieces


def _weights(kind: str, frame: str, length: int) -> tuple[dict[str, str], dict[str, str]]:
    """Gains of the outgoing and the incoming clip (premultiplied colour, coverage, white from coverage).

    ``P`` falls from 1 to ``1/length``. A cross-fade is linear. A dip lets the outgoing picture go in the
    first fifth and the incoming one arrive in the last fifth (smooth steps), while coverage stays linear,
    so a dip never makes a transparent canvas opaque; a dip to white adds white for the coverage it hides.
    """
    progress = f"(1-{frame}/{length})"
    if kind == "crossfade":
        colour_out, colour_in = progress, f"(1-{progress})"
    else:
        leave, arrive = f"clip(({progress}-0.8)/0.2,0,1)", f"clip({progress}/0.2,0,1)"
        colour_out = f"({progress}*({leave})*({leave})*(3-2*({leave})))"
        colour_in = f"((1-{progress})*(1-({arrive})*({arrive})*(3-2*({arrive}))))"
    out = {"rr": colour_out, "gg": colour_out, "bb": colour_out, "aa": progress}
    into = {"rr": colour_in, "gg": colour_in, "bb": colour_in, "aa": f"(1-{progress})"}
    if kind == "dip_to_white":
        out.update(dict.fromkeys(("ra", "ga", "ba"), f"({progress}-{colour_out})"))
        into.update(dict.fromkeys(("ra", "ga", "ba"), f"((1-{progress})-{colour_in})"))
    return out, into


def _summed(graph: list[str], weighted: Sequence[str], label: str) -> str:
    """The premultiplied sum of the weighted sides of a transition, back in straight 8-bit alpha."""
    source = weighted[0]
    if len(weighted) == 2:
        graph.append(f"[{weighted[0]}][{weighted[1]}]blend=all_mode=addition[{label}sum]")
        source = f"{label}sum"
    graph.append(f"[{source}]unpremultiply=inplace=1:planes=7,format=gbrap[{label}]")
    return label


def _mix(graph: list[str], plan: CompositionPlan, piece: _Piece, sides: Sequence[str | None], label: str) -> str:
    """The overlap of a transition: weighted premultiplied sum of the sides that exist."""
    transition = piece.transition
    if transition is None:
        raise ValueError("a mixed piece needs its transition")
    if transition.direction is not None:
        return _moving_mix(graph, plan, piece, transition, sides, label)
    frame = clock("(N-1)", piece.progress)
    weighted: list[str] = []
    gains_of = _weights(transition.kind, frame, transition.frames)
    for side, source, gains in zip(("out", "in"), sides, gains_of, strict=True):
        if source is None:
            continue
        target = f"colorchannelmixer@{label}{side}"
        graph.append(
            f"[{source}]format=gbrap,premultiply=inplace=1:planes=7,{command_filter(target, gains)},"
            f"{target}=rr=1[{label}{side}]"
        )
        weighted.append(f"{label}{side}")
    return _summed(graph, weighted, label)


# --------------------------------------------------------------------------- moving transitions


def _progress(transition: Transition, counter: str, first: int) -> str:
    """Eased progress 0..1 from a filter's frame counter whose first frame is transition frame ``first``.

    Frame k of an overlap of n frames is at k / n, as a cross-fade's weights are: the first frame shows the outgoing
    picture where it was, the frame after the overlap the incoming one alone.
    """
    return eased(transition.easing, f"({clock(counter, first)}/{transition.frames})")


def _places(transition: Transition, progress: str, width: int, height: int) -> tuple[_Place, _Place]:
    """Where the outgoing and the incoming picture are at eased progress ``progress``."""
    if transition.kind == "zoom":
        zoom = number(ZOOM_FACTOR)
        if transition.direction == "in":
            return _Place(scale=f"pow({zoom},{progress})"), _Place(scale=f"pow({zoom},{progress}-1)")
        return _Place(scale=f"pow({zoom},-{progress})"), _Place(scale=f"pow({zoom},1-{progress})")
    x, y = EDGES[str(transition.direction)]

    def moved(at: str) -> _Place:
        return _Place(f"({at})*({x * width})", f"({at})*({y * height})")

    if transition.kind in ("push", "whip"):
        return moved(progress), moved(f"{progress}-1")
    if transition.kind == "slide":
        return _Place(), moved(f"{progress}-1")
    return _Place(), _Place()


def _moved(place: _Place, width: int, height: int) -> list[str]:
    """Filters that draw premultiplied 16-bit RGBA at ``place`` (sub-pixel, bilinear; ``perspective`` itself works on
    8 bits); transparent where nothing lands."""
    if place.still:
        return []
    values: list[str] = []
    for du, dv in _corner_offsets(width, height):
        values.append(f"{number(width / 2 + TRANSFORM_PAD)}+({place.scale})*({number(du)})+({place.dx})")
        values.append(f"{number(height / 2 + TRANSFORM_PAD)}+({place.scale})*({number(dv)})+({place.dy})")
    names = ("x0", "y0", "x1", "y1", "x2", "y2", "x3", "y3")
    corners = ":".join(f"{name}='{value}'" for name, value in zip(names, values, strict=True))
    return [
        "format=gbrap",
        f"pad={width + 2 * TRANSFORM_PAD}:{height + 2 * TRANSFORM_PAD}:{TRANSFORM_PAD}:{TRANSFORM_PAD}:color=black@0",
        f"perspective={corners}:sense=destination:interpolation=linear:eval=frame",
        f"crop={width}:{height}:{TRANSFORM_PAD}:{TRANSFORM_PAD}",
        "format=gbrap16le",
    ]


def _gain(target: str, gain: str) -> list[str]:
    """Every plane of premultiplied RGBA times a per-frame ``gain``."""
    return [command_filter(target, dict.fromkeys(("rr", "gg", "bb", "aa"), gain)), f"{target}=rr=1"]


def _cover(graph: list[str], plan: CompositionPlan, piece: _Piece, place: _Place, gain: str | None, label: str) -> str:
    """A stream whose four planes are 1 - gain x (the canvas rectangle of a picture drawn at ``place``): the share
    of the picture behind it. The rectangle is drawn by the same map as that picture, so their edges meet exactly."""
    chain = [
        f"color=c=white:s={plan.width}x{plan.height}:r={_rate(plan.fps)}",
        "format=gbrap16le",
        f"trim=end_frame={piece.end - piece.start}",
        f"setpts=N+{piece.start}",
        *_moved(place, plan.width, plan.height),
    ]
    if gain is not None:
        chain += _gain(f"colorchannelmixer@{label}", gain)
    graph.append(",".join([*chain, "negate=negate_alpha=1"]) + f"[{label}]")
    return label


def _wipe_shares(
    graph: list[str],
    plan: CompositionPlan,
    piece: _Piece,
    transition: Transition,
    sides: Sequence[str | None],
    label: str,
) -> list[str | None]:
    """Streams whose four planes are the shares of a wipe's pictures (None for a picture that is not shown): the
    incoming one behind the moving edge (a smooth step ``softness`` of the travel wide), the outgoing one the rest.
    The edge is drawn once; the outgoing share is its negation."""
    direction = str(transition.direction)
    along = {"left": "(1-(X+0.5)/W)", "right": "((X+0.5)/W)", "up": "(1-(Y+0.5)/H)", "down": "((Y+0.5)/H)"}[direction]
    travel = plan.width if EDGES[direction][0] else plan.height
    soft = max(transition.softness, 1 / travel)
    edge = f"({_progress(transition, 'N', piece.progress)}*{number(1 + soft)}-{number(soft / 2)})"
    share = f"st(6,clip(({edge}-{along})/{number(soft)}+0.5,0,1));clip(65535*ld(6)*ld(6)*(3-2*ld(6))+0.5,0,65535)"
    drawn = ",".join(
        [
            f"color=c=black:s={plan.width}x{plan.height}:r={_rate(plan.fps)}",
            f"trim=end_frame={piece.end - piece.start}",
            "format=gray16le",
            f"geq=lum='{share}'",
            f"setpts=N+{piece.start}",
            "mergeplanes=format=gbrap16le",
        ]
    )
    out, into = (
        None if source is None else f"{label}{side}share" for side, source in zip(("out", "in"), sides, strict=True)
    )
    if out is not None and into is not None:
        graph.append(f"{drawn},split=2[{into}][{label}edge]")
        graph.append(f"[{label}edge]negate=negate_alpha=1[{out}]")
    elif out is not None:
        graph.append(f"{drawn},negate=negate_alpha=1[{out}]")
    elif into is not None:
        graph.append(f"{drawn}[{into}]")
    return [out, into]


def _whip(transition: Transition, progress: str, plan: CompositionPlan, target: str) -> list[str]:
    """The whip's blur along its movement: sigma WHIP_BLUR x the travel at the middle, nothing at either end."""
    horizontal = EDGES[str(transition.direction)][0] != 0
    travel = plan.width if horizontal else plan.height
    sigma = f"{number(WHIP_BLUR * travel)}*sin(PI*{progress})"
    return [
        command_filter(target, {"sigma" if horizontal else "sigmaV": sigma}),
        f"{target}=sigma=0:sigmaV=0:steps={GAUSS_STEPS}",
    ]


def _moving_mix(
    graph: list[str],
    plan: CompositionPlan,
    piece: _Piece,
    transition: Transition,
    sides: Sequence[str | None],
    label: str,
) -> str:
    """Push, slide, whip, wipe and zoom as a premultiplied 16-bit sum of the two pictures, each moved and weighted
    (8-bit premultiplying would darken white by a code value for the whole transition):

    - push, whip: both pictures travel by the frame (whip: blurred along the way); nothing overlaps;
    - slide: the incoming picture travels in; the outgoing one is hidden under its rectangle;
    - wipe: shares of a moving soft edge;
    - zoom in: the outgoing picture grows to ZOOM_FACTOR, the incoming one grows from 1/ZOOM_FACTOR in front of it,
      fading in (and hiding it under its rectangle as it does); zoom out: the reverse.
    """
    width, height = plan.width, plan.height
    places = _places(transition, _progress(transition, "(in-1)", piece.progress), width, height)
    progress = _progress(transition, "(N-1)", piece.progress)
    gains: list[str | None] = [None, None]
    # What weights each picture: the rectangle (place, fade) of the picture in front of it, or a wipe's share
    covers: list[tuple[_Place, str | None] | None] = [None, None]
    shares: list[str | None] = [None, None]
    if transition.kind == "slide":
        covers[0] = (places[1], None)
    elif transition.kind == "wipe":
        shares = _wipe_shares(graph, plan, piece, transition, sides, label)
    elif transition.kind == "zoom":
        front = 1 if transition.direction == "in" else 0
        fade = progress if front else f"(1-{progress})"
        gains[front] = fade
        covers[1 - front] = (places[front], fade)
    weighted: list[str] = []
    for index, (side, source) in enumerate(zip(("out", "in"), sides, strict=True)):
        if source is None:
            continue
        tag = f"{label}{side}"
        chain = [f"[{source}]format=gbrap16le,premultiply=inplace=1:planes=7", *_moved(places[index], width, height)]
        if transition.kind == "whip":
            chain += _whip(transition, progress, plan, f"gblur@{tag}whip")
        gain = gains[index]
        if gain is not None:
            chain += _gain(f"colorchannelmixer@{tag}", gain)
        graph.append(",".join(chain) + f"[{tag}]")
        cover = covers[index]
        share = shares[index] if cover is None else _cover(graph, plan, piece, *cover, f"{tag}share")
        if share is not None:
            graph.append(f"[{tag}][{share}]blend=all_mode=multiply[{tag}weighted]")
            tag = f"{tag}weighted"
        weighted.append(tag)
    return _summed(graph, weighted, label)


def _layers(graph: list[str], plan: CompositionPlan, segment: Segment, inputs: SegmentInputs) -> list[_Piece]:
    """Emit every clip stream once, cut into the pieces that use it and one probe; return the pieces."""
    pieces = _pieces(plan, segment)
    uses: dict[int, list[str]] = {position: [] for position in range(len(segment.slices))}
    for number_, piece in enumerate(pieces):
        for side, member in enumerate(piece.members):
            if member is not None:
                uses[member].append(f"part{number_}_{side}")
    for position, item in enumerate(segment.slices):
        clip = plan.clips[item.clip]
        # An adjustment layer's picture is the canvas under it: it is made where it is placed (_place)
        if clip.enabled and not clip.adjustment:
            _clip_stream(graph, plan, segment, position, inputs, [*uses[position], f"probe{position}"])
    return pieces


def _place(graph: list[str], plan: CompositionPlan, segment: Segment, pieces: Sequence[_Piece]) -> int:
    base = 0
    for number_, piece in enumerate(pieces):
        member = piece.members[0]
        if piece.transition is None and member is not None and plan.clips[segment.slices[member].clip].adjustment:
            under, layer = _adjusted(graph, plan, segment, member, base)
            append_blend(graph, base, layer, piece.mode, piece.start, piece.end, background=under, padded=True)
            base += 1
            continue
        cut = f"trim=start_pts={piece.start}:end_pts={piece.end}"
        sides = [None if member is None else f"cut{number_}_{side}" for side, member in enumerate(piece.members)]
        for side, member in enumerate(piece.members):
            if member is not None:
                graph.append(f"[part{number_}_{side}]{cut}[cut{number_}_{side}]")
        layer = _mix(graph, plan, piece, sides, f"mix{number_}") if piece.transition else str(sides[0])
        append_blend(graph, base, layer, piece.mode, piece.start, piece.end)
        base += 1
    return base


def _probes(graph: list[str], plan: CompositionPlan, segment: Segment, base: int) -> int:
    """A clip that ends early ends the segment: the exporter then refuses the short output (an adjustment layer is
    made from the canvas itself and reads nothing)."""
    for position, item in enumerate(segment.slices):
        clip = plan.clips[item.clip]
        if not clip.enabled or clip.adjustment:
            continue
        rest = segment.frames - item.at - item.frames
        pad = f",tpad=stop_mode=add:stop={rest}:color=black@0" if rest else ""
        graph.append(f"[probe{position}]crop=2:2:0:0{pad}[watch{position}]")
        graph.append(f"[base{base}][watch{position}]overlay=x=-2:y=-2:eof_action=endall:format=auto[base{base + 1}]")
        base += 1
    return base


def _captions(graph: list[str], plan: CompositionPlan, segment: Segment, inputs: SegmentInputs, base: int) -> int:
    for index in segment.captions:
        caption = plan.captions[index]
        raster = inputs.caption_images.get(index)
        if raster is None:
            continue
        start, end = max(caption.start, segment.start) - segment.start, min(caption.end, segment.end) - segment.start
        graph.append(f"[{raster.index}:v:0]scale={plan.width}:{plan.height},format=rgba[caption{index}]")
        graph.append(
            f"[base{base}][caption{index}]overlay=x=0:y=0:eof_action=repeat:format=auto:"
            f"enable='between(n,{start},{end - 1})'[base{base + 1}]"
        )
        base += 1
    track = inputs.caption_track
    if track is not None:
        graph.append(f"[{track.index}:v:0]fps={_rate(plan.fps)},format=rgba[captions]")
        graph.append(
            f"[base{base}][captions]overlay=x={track.x}:y={track.y}:eof_action=pass:repeatlast=0:format=auto[base{base + 1}]"
        )
        base += 1
    return base


def direct_segment(plan: CompositionPlan, segment: Segment, media: Mapping[int, MediaInput]) -> bool:
    """True when a segment shows only plain clips whose files are opaque and fill the canvas, and no caption."""
    shown = [(position, item) for position, item in enumerate(segment.slices) if plan.clips[item.clip].enabled]
    return (
        not segment.captions
        and len(shown) == len(segment.slices)
        and all(plain_clip(plan, item.clip) and media[position].opaque_cover for position, item in shown)
    )


def _direct_graph(plan: CompositionPlan, segment: Segment, inputs: SegmentInputs) -> str:
    """Plain clips stay in 4:2:0: frames of a canvas-sized BT.709 source reach the encoder unchanged."""
    width, height, fps = plan.width, plan.height, plan.fps
    graph = BoundedGraph()
    graph.append(
        f"color=c=black:s={width}x{height}:r={_rate(fps)},{OUTPUT_FORMAT},trim=end_frame={segment.frames}[base0]"
    )
    flags = f"{'lanczos' if plan.fit else 'bicubic'}+{ACCURATE}"
    for position, item in enumerate(segment.slices):
        clip, media = plan.clips[item.clip], inputs.media[position]
        chain = [*([f"setparams={media.declare}"] if media.declare else []), *_timing(clip, item, media, fps)]
        if media.resize and plan.fit == "cover":
            chain += [
                f"scale={width}:{height}:force_original_aspect_ratio=increase:flags={flags}",
                f"crop={width}:{height}",
            ]
        elif media.resize:
            chain.append(f"scale={width}:{height}:flags={flags}")
        chain += ["setsar=1", OUTPUT_FORMAT, f"setpts=N+{item.at}", "split=2"]
        graph.append(f"[{media.index}:V:0]{','.join(chain)}[part{position}][probe{position}]")
        append_blend(graph, position, f"part{position}", "normal", item.at, item.at + item.frames)
    base = _probes(graph, plan, segment, len(segment.slices))
    graph.append(f"[base{base}]{OUTPUT_FORMAT}[v]")
    return f"sws_flags={SWS_FLAGS};" + ";".join(graph)


def segment_graph(plan: CompositionPlan, segment: Segment, inputs: SegmentInputs) -> str:
    """The complete filter graph of one segment; its only output ``[v]`` has exactly ``segment.frames`` frames."""
    if inputs.direct:
        return _direct_graph(plan, segment, inputs)
    graph = BoundedGraph()
    graph.append(
        f"color=c=black:s={plan.width}x{plan.height}:r={_rate(plan.fps)},format=gbrp,trim=end_frame={segment.frames}[base0]"
    )
    pieces = _layers(graph, plan, segment, inputs)
    base = _place(graph, plan, segment, pieces)
    base = _probes(graph, plan, segment, base)
    base = _captions(graph, plan, segment, inputs, base)
    graph.append(f"[base{base}]{OUTPUT_FORMAT}[v]")
    return f"sws_flags={SWS_FLAGS};" + ";".join(graph)


__all__ = [
    "OUTPUT_FORMAT",
    "MediaInput",
    "RasterInput",
    "SegmentInputs",
    "direct_segment",
    "segment_graph",
    "source_range",
]
