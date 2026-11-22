"""The states of a caption track: which captions are on screen during which frames (pure).

A track is cut at every caption start and end. Between two cuts the picture does not change, so
each such interval becomes one sample of the track movie; neighbouring intervals that show the
same pictures in the same order are one state.
"""

from __future__ import annotations

from bisect import insort
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise


@dataclass(frozen=True)
class Span:
    """One caption event: its half-open frame range and the picture it shows."""

    start: int
    end: int
    picture: int


@dataclass(frozen=True)
class State:
    """Frames ``[start, end)`` of a track and the pictures composited there, bottom first."""

    start: int
    end: int
    pictures: tuple[int, ...]


def track_states(frames: int, spans: Sequence[Span]) -> list[State]:
    """Partition ``[0, frames)`` into states; later events lie on top of earlier ones.

    Every span satisfies ``0 <= start < end <= frames``.
    """
    starting: dict[int, list[int]] = {}
    ending: dict[int, list[int]] = {}
    for index, span in enumerate(spans):
        starting.setdefault(span.start, []).append(index)
        ending.setdefault(span.end, []).append(index)
    cuts = sorted({0, frames, *starting, *ending})
    active: list[
        int
    ] = []  # indices of the events on screen, ascending (the stacking order)
    states: list[State] = []
    for start, end in pairwise(cuts):
        for index in ending.get(start, ()):
            active.remove(index)
        for index in starting.get(start, ()):
            insort(active, index)
        pictures = tuple(spans[index].picture for index in active)
        if states and states[-1].pictures == pictures:
            states[-1] = State(states[-1].start, end, pictures)
        else:
            states.append(State(start, end, pictures))
    return states
