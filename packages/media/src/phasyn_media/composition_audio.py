"""FFmpeg graph of one audio chunk of a multitrack export.

A chunk mixes the audio clips that sound in a frame range into exactly its 48 kHz samples
(planar float in the graph, written as interleaved 32-bit float). Every clip is one input, read
from its own seek point: the decode is cut on a source sample that lies on the common grid of
the source rate and 48 kHz, so the resampler runs in the phase a decode from the first sample
would have. A stream whose timestamps count samples is placed by them (a gap is silence), so its
samples sit where the container says whether or not the decode began at a seek point. From there
the clip keeps the processing it always had: source range, tempo, holds, fades, gain and pan
automation on its own sample clock, then its output window.

Clips joined by transitions cross-fade on samples (a dip fades out, then in); a disabled clip in such a chain is
silence.
The mixer never normalizes: gain above the available headroom can clip.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction
from itertools import pairwise

from .composition import AudioChunk, BoundedGraph, CompositionClip, CompositionPlan, chunk_samples
from .composition_curves import expression, number
from .effects import AUDIO_RATE, samples_for
from .seek import AudioCut

FORMAT = "aformat=sample_fmts=fltp:channel_layouts=stereo"


@dataclass(frozen=True)
class AudioInput:
    index: int  # FFmpeg input number
    cut: AudioCut


def first_sample(clip: CompositionClip, fps: Fraction) -> int:
    """First 48 kHz sample the clip reads from its source, counted from the source's clip origin."""
    return samples_for(int(clip.document["in_frame"]), fps)


def _source(clip: CompositionClip, cut: AudioCut, fps: Fraction) -> list[str]:
    """The clip's source range as 48 kHz stereo, sample 0 = its first source sample."""
    length = samples_for(int(clip.document["out_frame"]), fps) - first_sample(clip, fps)
    parts = [f"atrim=start_pts={cut.start_pts}"] if cut.start_pts is not None else []
    # Trims, tempo and holds use a sample clock; missing or stale packet PTS must
    # not drive fade/automation time or make independently sliced inputs silent.
    if cut.first_pts is not None and cut.rate:
        # Timestamps that count samples place the decode first: from half a sample of difference on, the
        # resampler fills a gap with silence and drops an overlap, and only then are samples counted.
        half = number(0.5 / cut.rate)
        placed = f"aresample={AUDIO_RATE}:async=1:min_comp={half}:min_hard_comp={half}:first_pts={cut.first_pts}"
        parts += [placed, "asetpts=N/SR/TB", FORMAT]
    else:
        parts += ["asetpts=N/SR/TB", f"aresample={AUDIO_RATE}", FORMAT]
    if cut.lead_samples:
        parts += [f"atrim=start_sample={cut.lead_samples}", "asetpts=N/SR/TB"]
    if cut.silence_samples:
        parts.append(f"adelay=delays={cut.silence_samples}S:all=1")
    parts += [f"atrim=end_sample={length}", "asetpts=N/SR/TB"]
    return parts


def _clip(clip: CompositionClip, position: int, source: AudioInput, fps: Fraction) -> str:
    planned = clip.plan
    # Reconstruct the full effect clock's origin. Adjacent windows sliced at their
    # original positions share this origin, including the fractional-rate sample grid.
    # Process the complete source first: trimming before atempo would restart its phase.
    origin = planned.start_frame - clip.window_start
    sample_origin = samples_for(origin, fps)
    total = samples_for(origin + planned.frames, fps) - sample_origin
    effects = planned.effects
    motion = clip.document["motion"]
    seconds = f"(t*{number(float(fps))})"
    gain = expression(motion, "gain_db", seconds)
    fixed = number(clip.track["gain_db"] + (effects.volume_db if effects else 0))
    pan = expression(motion, "pan", seconds)
    left = f"(1-max(0,{pan}))*{number(1 - max(0, clip.track['pan']))}"
    right = f"(1+min(0,{pan}))*{number(1 + min(0, clip.track['pan']))}"
    amplitude = "0" if effects and effects.mute else f"pow(10,(({gain})+{fixed})/20)"
    parts = _source(clip, source.cut, fps)
    if effects and effects.speed_percent != 100:
        parts.append(f"atempo={number(effects.speed_percent / 100)}")
    hold_start = effects.hold.start if effects else 0
    hold_end = effects.hold.end if effects else 0
    head = samples_for(origin + hold_start, fps) - sample_origin
    core = samples_for(origin + planned.frames - hold_end, fps) - samples_for(origin + hold_start, fps)
    # Tempo processing can produce a partial frame beyond the integer video core.
    # Bound the core before padding either hold, so held frames remain silent.
    parts += [f"apad=whole_len={core}", f"atrim=end_sample={core}", "asetpts=N/SR/TB"]
    if head:
        parts.append(f"adelay=delays={head}S:all=1")
    parts += [f"apad=whole_len={total}", f"atrim=end_sample={total}", "asetpts=N/SR/TB"]
    if effects and effects.fade.audio_in:
        length = samples_for(origin + effects.fade.audio_in, fps) - sample_origin
        parts.append(f"afade=t=in:ss=0:ns={length}")
    if effects and effects.fade.audio_out:
        length = samples_for(origin + planned.frames, fps) - samples_for(
            origin + planned.frames - effects.fade.audio_out, fps
        )
        parts.append(f"afade=t=out:ss={total - length}:ns={length}")
    parts.append(f"aeval=exprs='val(0)*({amplitude})*({left})|val(1)*({amplitude})*({right})':channel_layout=stereo")
    if clip.window_start != 0 or clip.window_end != planned.frames:
        start = samples_for(origin + clip.window_start, fps) - sample_origin
        end = samples_for(origin + clip.window_end, fps) - sample_origin
        parts += [f"atrim=start_sample={start}:end_sample={end}", "asetpts=N/SR/TB"]
    return f"[{source.index}:a:0]{','.join(parts)}[audio{position}]"


def _silence(clip: CompositionClip, position: int, fps: Fraction) -> str:
    """A disabled clip inside a transition chain: silence of its visible length."""
    length = samples_for(clip.end, fps) - samples_for(clip.start, fps)
    return f"anullsrc=r={AUDIO_RATE}:cl=stereo,atrim=end_sample={length},{FORMAT}[audio{position}]"


def _chain(graph: list[str], plan: CompositionPlan, group: tuple[int, ...], number_: int) -> tuple[str, int, int]:
    """Join the clips of one transition chain; returns its label and absolute sample range."""
    fps = plan.fps
    first = plan.clips[group[0]]
    origin = samples_for(first.start, fps)
    end = samples_for(first.end, fps)
    current = f"audio{group[0]}"
    for left_index, right_index in pairwise(group):
        left, right = plan.clips[left_index], plan.clips[right_index]
        transition = left.plan.effects.transition_out if left.plan.effects else None
        if transition is None:
            raise ValueError("a transition chain needs a transition between its clips")
        overlap = end - samples_for(right.start, fps)
        target = f"across{number_}_{right_index}"
        if not transition.dips:
            # A cross-fade and every moving transition (push, slide, whip, wipe, zoom) cross-fade the sound.
            graph.append(f"[{current}][audio{right_index}]acrossfade=ns={overlap}:c1=tri:c2=tri[{target}]")
        else:
            # Same curves as the legacy sequence: outgoing first half, incoming second half.
            half = overlap // 2
            out, into = f"dipa{number_}_{right_index}", f"dipb{number_}_{right_index}"
            graph.append(f"[{current}]afade=t=out:ss={end - origin - overlap}:ns={max(1, half)}[{out}]")
            graph.append(f"[audio{right_index}]afade=t=in:ss={half}:ns={max(1, overlap - half)}[{into}]")
            graph.append(f"[{out}][{into}]acrossfade=ns={overlap}:c1=nofade:c2=nofade[{target}]")
        current = target
        end = samples_for(right.end, fps)
    return current, origin, end


def chunk_graph(plan: CompositionPlan, chunk: AudioChunk, inputs: Mapping[int, AudioInput]) -> str:
    """The graph of one chunk; its only output ``[a]`` has exactly the chunk's samples.

    ``inputs`` maps an index of ``plan.clips`` to the opened file of that (enabled) clip. Of a transition
    chain only the clips that sound in the chunk are processed: a neighbour outside it cannot reach in.
    """
    fps = plan.fps
    first, last = chunk_samples(plan, chunk.start, chunk.end)
    graph = BoundedGraph()
    members = set(chunk.clips)
    labels: list[str] = []
    for number_, group in enumerate(plan.groups):
        part = tuple(index for index in group if index in members)
        if not part or not any(plan.clips[index].enabled for index in part):
            continue
        for index in part:
            clip = plan.clips[index]
            graph.append(_clip(clip, index, inputs[index], fps) if clip.enabled else _silence(clip, index, fps))
        current, origin, end = _chain(graph, plan, part, number_)
        start, stop = max(origin, first), min(end, last)
        label = f"agroup{number_}"
        graph.append(
            f"[{current}]atrim=start_sample={start - origin}:end_sample={stop - origin},asetpts=N/SR/TB,"
            f"adelay=delays={start - first}S:all=1[{label}]"
        )
        labels.append(f"[{label}]")
    if labels:
        graph.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:duration=longest[mix]")
        source = "[mix]"
    else:
        source = f"anullsrc=r={AUDIO_RATE}:cl=stereo,"
    gain = number(plan.document["master_gain_db"])
    graph.append(
        f"{source}{FORMAT},volume={gain}dB,apad=whole_len={last - first},atrim=end_sample={last - first},"
        "asetpts=N/SR/TB[a]"
    )
    return ";".join(graph)


__all__ = ["AudioInput", "chunk_graph", "first_sample"]
