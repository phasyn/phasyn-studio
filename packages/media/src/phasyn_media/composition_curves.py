"""Bounded numeric automation expressions shared by motion, masks and effects.

Only validated values and compiler-owned clocks enter expressions. Registers 6–9
are scratch space; a caller may cache per-frame parameters in registers 0–5.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from itertools import pairwise
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.timeline import bezier_value


def number(value: float | int) -> str:
    numeric = float(value)
    if not math.isfinite(numeric):
        raise ComponentError("INVALID_ARGUMENT", "時間軸數值必須有限")
    return format(numeric, ".12g")


def _cubic(at: str, first: float, second: float) -> str:
    return f"(3*(1-({at}))^2*({at})*{first:.17g}+3*(1-({at}))*({at})^2*{second:.17g}+({at})^3)"


def _bezier(progress: str, controls: Sequence[float]) -> str:
    x1, y1, x2, y2 = controls
    # A width of exactly 2^-32 gives exactly the browser's 32 bisections.
    solve = (
        f"st(6,{progress});st(7,0);st(8,1);"
        "while(gt(ld(8)-ld(7),1/4294967296),"
        f"st(9,(ld(7)+ld(8))/2);if(lt({_cubic('ld(9)', x1, x2)},ld(6)),st(7,ld(9)),st(8,ld(9))));"
        f"st(9,(ld(7)+ld(8))/2);{_cubic('ld(9)', y1, y2)}"
    )
    return f"if(lte({progress},0),0,if(gte({progress},1),1,({solve})))"


def expression(container: Mapping[str, Any], name: str, clock: str) -> str:
    """Use local output frames; outside the key range hold the nearest endpoint."""
    points = container.get("keyframes", {}).get(name, [])
    if not points:
        return number(container[name])
    values: list[str] = []
    for left, right in pairwise(points):
        a, b = int(left["frame"]), int(right["frame"])
        if b <= a:
            raise ComponentError("INVALID_ARGUMENT", "關鍵影格需依時間嚴格遞增")
        start, end = number(left["value"]), number(right["value"])
        raw = f"(({clock}-{a})/{b - a})"
        progress = raw
        kind = left["interpolation"]
        low, high = left.get("curve_range", [0.0, 1.0])
        span = high - low
        if kind == "ease_in":
            bend = number(span / (low + high))
            progress = f"({raw}*(1-{bend}+{bend}*{raw}))"
        elif kind == "ease_out":
            bend = number(span / ((1 - low) + (1 - high)))
            progress = f"({raw}*(1+{bend}-{bend}*{raw}))"
        elif kind == "ease_in_out":
            first = low * (1 - low)
            middle = (low * (1 - high) + high * (1 - low)) / 2
            last = high * (1 - high)
            weight = first + middle + last
            c1, c2 = first / weight, (first + middle) / weight
            progress = (
                f"({raw}*({number(3 * c1)}+{raw}*({number(3 * c2 - 6 * c1)}+{raw}*{number(1 + 3 * c1 - 3 * c2)})))"
            )
        elif kind == "bezier":
            controls = left["bezier"]
            first, last = bezier_value(low, controls), bezier_value(high, controls)
            if last > first:
                easing = _bezier(f"({low:.17g}+{span:.17g}*{raw})", controls)
                progress = (
                    f"if(lte({raw},0),0,if(gte({raw},1),1,clip((({easing})-{first:.17g})/{last - first:.17g},0,1)))"
                )
        value = start if kind == "hold" else f"({start}+({end}-{start})*{progress})"
        values.append(value)
    values.append(number(points[-1]["value"]))

    def select(first: int, end: int) -> str:
        if end - first == 1:
            return values[first]
        middle = (first + end) // 2
        boundary = int(points[middle]["frame"])
        return f"if(lt({clock},{boundary}),{select(first, middle)},{select(middle, end)})"

    # FFmpeg bounds evaluator recursion. A balanced tree keeps 128 keys shallow.
    result = select(0, len(values))
    first = points[0]
    return f"if(lte({clock},{int(first['frame'])}),{number(first['value'])},{result})"


def eased(easing: str, progress: str) -> str:
    """A transition's progress (0 to 1) through its easing, the keyframe easings over a whole interval:
    ``ease_in`` t², ``ease_out`` t(2 - t), ``ease_in_out`` t²(3 - 2t) (the editor's ``easeProgress``)."""
    if easing == "linear":
        return progress
    if easing == "ease_in":
        return f"({progress}*{progress})"
    if easing == "ease_out":
        return f"({progress}*(2-{progress}))"
    return f"({progress}*{progress}*(3-2*{progress}))"


def frame_parameters(container: Mapping[str, Any], names: Sequence[str], clock: str = "N") -> str:
    """Cache up to five scalar channels once per frame in each geq slice/plane."""
    if len(names) > 5:
        raise ValueError("at most five cached channels")
    values = ";".join(f"st({index},{expression(container, name, clock)})" for index, name in enumerate(names))
    # Registers initially contain zero. Store N+1 so the first frame is evaluated.
    return f"if(eq(ld(5),({clock})+1),0,({values};st(5,({clock})+1)));"


def command_filter(target: str, commands: Mapping[str, str]) -> str:
    """One per-frame interval: size depends on keys, never on clip frame count.

    The three parsers are sendcmd, filter options and filtergraph. Escape each
    enclosing layer separately; no user strings or paths are accepted here.
    """
    command = "0 " + ",".join(f"[expr] {target} {name} '{value}'" for name, value in commands.items()) + ";"
    option = "".join("\\" + char if char in "\\':" else char for char in command)
    graph = "".join("\\" + char if char in "\\'[],;" else char for char in option)
    return f"sendcmd=c={graph}"
