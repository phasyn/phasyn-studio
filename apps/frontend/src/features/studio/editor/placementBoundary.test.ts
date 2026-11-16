// Data-integrity boundaries of the edits that put copied clips, attributes and transitions into a document: a paste
// never leaves two clips overlapping on a track and keeps the pasted clips' offsets and layers; a transition placed on
// an edit spot never takes more frames than either clip has beside its other transition and changes nothing a clip
// showed between its cuts (the clips only run on past the cut); a dissolve on a free end keeps the clip's other keys;
// pasted attributes keep their keys inside the clip. Every refused edit leaves the document as it was.
import { describe, expect, it } from "vitest";
import type { StudioTimeline, TimelineClip, TimelineKeyframe, TimelineTrack } from "@/api/generated/contracts";
import { NODE_A_ID } from "@/test/ids";
import { activeTransition } from "../model/clipEffects";
import { ADJUSTMENT_TRANSITION } from "./adjustment";
import { copyClips, pasteClips, pasteTracks } from "./clipboard";
import { trackSpots } from "./editSpots";
import { clipDuration, clipEnd, sourceFrameAtTimeline, timelineDuration, trackClips, windowBounds, type AllocateId } from "./model";
import { pasteAttributes } from "./pasteAttributes";
import { cutOf } from "./transitionCut";
import { applyAtSpots, DEFAULT_AUDIO_TRANSITION, DEFAULT_VIDEO_TRANSITION, planAtSpot } from "./transitionPlacement";
import { timelineProblem } from "./validation";

const MOTION = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, gain_db: 0, pan: 0, keyframes: {} };

function track(id: string, kind: TimelineTrack["kind"]): TimelineTrack {
  return { track_id: id, name: id, kind, locked: false, muted: false, solo: false, sync_lock: true, gain_db: 0, pan: 0 };
}

function clip(id: string, trackId: string, start: number, frames: number, extra: Partial<TimelineClip> = {}): TimelineClip {
  return { clip_id: id, source_id: "src-a", track_id: trackId, name: id, start_frame: start, in_frame: 0, out_frame: frames, motion: structuredClone(MOTION), ...extra };
}

/** Linked picture and sound on V1/A1 (a crossfade between the first two), an overlay on V2, music on A2. */
function film(): StudioTimeline {
  const pair = (name: string, start: number, frames: number, extra: Partial<TimelineClip> = {}) => [
    clip(`v-${name}`, "video-1", start, frames, { linked_id: `link-${name}`, ...extra }),
    clip(`a-${name}`, "audio-1", start, frames, { linked_id: `link-${name}`, ...extra }),
  ];
  return {
    version: 2,
    fps: { num: 24, den: 1 },
    master_gain_db: 0,
    sources: [{
      source_id: "src-a", name: "Synthetic source", kind: "video", duration_frames: 1000, width: 64, height: 36, has_audio: true,
      file: { node_id: NODE_A_ID, file_id: "00000000-0000-4000-8000-00000000f001", size_bytes: 1, sha256: "a".repeat(64), media_type: "video/mp4", metadata: {} },
    }],
    tracks: [track("video-1", "video"), track("video-2", "video"), track("audio-1", "audio"), track("audio-2", "audio")],
    clips: [
      ...pair("one", 0, 48, { effects: { transition_out: { kind: "crossfade", frames: 8 } } }),
      ...pair("two", 40, 60),
      ...pair("three", 100, 30),
      clip("overlay", "video-2", 10, 30),
      clip("music", "audio-2", 0, 60),
    ],
    captions: [{ caption_id: "caption", start_frame: 50, end_frame: 70, text: "Synthetic caption", position: "bottom", size: "small" }],
    markers: [{ marker_id: "marker", frame: 100, name: "Synthetic marker", color: "blue" }],
  };
}

function counter(): AllocateId {
  let serial = 0;
  return (prefix) => `${prefix}-n${++serial}`;
}

/** Every track: each clip starts where the previous one ends, or overlaps it by exactly the previous one's transition. */
function expectNoOverlap(timeline: StudioTimeline): void {
  for (const { track_id } of timeline.tracks) {
    const ordered = trackClips(timeline, track_id);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      const overlap = clipEnd(previous) - current.start_frame;
      if (overlap > 0) expect(activeTransition(previous.effects)?.frames).toBe(overlap);
    }
  }
}

const ALL_TRACKS = new Set(["video-1", "video-2", "audio-1", "audio-2"]);

describe("a paste never overlaps clips and keeps what was copied", () => {
  const copies = [["v-three"], ["v-one", "v-two"], ["overlay"], ["music"], ["overlay", "v-three"]];
  const modes = ["overwrite", "insert"] as const;
  const frames = [0, 20, 44, 100, 115, 160];
  it.each(copies.flatMap((ids) => modes.flatMap((mode) => frames.map((at) => ({ ids, mode, at })))))("$mode $ids at $at", ({ ids, mode, at }) => {
    const original = film();
    const snapshot = structuredClone(original);
    const copied = copyClips(original, ids, true);
    if (!copied.ok) throw new Error(copied.error);
    const tracks = pasteTracks(original, copied.value, ALL_TRACKS);
    if (!tracks.ok) throw new Error(tracks.error);
    const result = pasteClips(original, copied.value, at, mode, tracks.value, counter());
    expect(original).toEqual(snapshot);
    // After the last clip of every track nothing stands in the way
    if (at >= 130) expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(timelineProblem(result.value.timeline)).toBeNull();
    expectNoOverlap(result.value.timeline);
    expect(result.value.end).toBe(at + copied.value.duration);
    // Offsets, lengths, source ranges and layers as copied: the lowest copied track of each kind lands on V1 / A1
    const pasted = result.value.selected.map((id) => result.value.timeline.clips.find((item) => item.clip_id === id)!);
    expect(pasted).toHaveLength(copied.value.clips.length);
    pasted.forEach((item, index) => {
      const copy = copied.value.clips[index]!;
      expect(item.start_frame).toBe(at + copy.start_frame);
      expect([clipDuration(item), item.in_frame, item.out_frame]).toEqual([clipDuration(copy), copy.in_frame, copy.out_frame]);
      expect(item.track_id).toBe(tracks.value.get(copy.track_id));
    });
  });

  it("lands on the lowest targeted track of each kind and keeps the layers' distance", () => {
    const original = film();
    const copied = copyClips(original, ["overlay", "v-three"], true);
    if (!copied.ok) throw new Error(copied.error);
    const all = pasteTracks(original, copied.value, ALL_TRACKS);
    expect(all.ok && Object.fromEntries(all.value)).toEqual({ "video-1": "video-1", "video-2": "video-2", "audio-1": "audio-1" });
    const upper = pasteTracks(original, copied.value, new Set(["video-2", "audio-2"]));
    expect(upper.ok).toBe(false);
    const single = copyClips(original, ["overlay"], true);
    if (!single.ok) throw new Error(single.error);
    const lowered = pasteTracks(original, single.value, ALL_TRACKS);
    expect(lowered.ok && Object.fromEntries(lowered.value)).toEqual({ "video-2": "video-1" });
  });
});

describe("a transition on an edit spot stays within both clips", () => {
  /** Short clips on V1 (5, 7 with a 3-frame transition into the next, 21 and 2 frames), an animated overlay, music; no sync lock. */
  function shortFilm(): StudioTimeline {
    const value = film();
    value.tracks = value.tracks.map((item) => ({ ...item, sync_lock: false }));
    value.clips = [
      clip("s1", "video-1", 0, 5),
      clip("s2", "video-1", 5, 7, { effects: { transition_out: { kind: "crossfade", frames: 3 } } }),
      clip("s3", "video-1", 9, 21),
      clip("s4", "video-1", 30, 2),
      clip("overlay", "video-2", 40, 12, { motion: { ...MOTION, keyframes: { opacity: [{ frame: 6, value: 0.5, interpolation: "linear" }] } } }),
      clip("m1", "audio-2", 0, 10),
      clip("m2", "audio-2", 10, 4),
    ];
    value.captions = [];
    value.markers = [];
    return value;
  }

  const room = (timeline: StudioTimeline, left: TimelineClip, right: TimelineClip) => {
    const ordered = trackClips(timeline, left.track_id);
    const before = ordered[ordered.indexOf(left) - 1];
    const incoming = before && clipEnd(before) - left.start_frame > 0 ? clipEnd(before) - left.start_frame : 0;
    return Math.min(clipDuration(left) - incoming, clipDuration(right) - (activeTransition(right.effects)?.frames ?? 0));
  };
  /** The frames a clip shows between its cuts: from the cut of the transition into it to the cut of its own. */
  const betweenCuts = (timeline: StudioTimeline, clip: TimelineClip) => {
    const ordered = trackClips(timeline, clip.track_id);
    const previous = ordered[ordered.indexOf(clip) - 1];
    const into = previous && clipEnd(previous) > clip.start_frame ? activeTransition(previous.effects) : null;
    const own = ordered[ordered.indexOf(clip) + 1] ? activeTransition(clip.effects) : null;
    return { start: clip.start_frame + (into ? cutOf(into).incoming.frames : 0), end: clipEnd(clip) - (own ? cutOf(own).outgoing.frames : 0) };
  };

  it.each(["video-1", "video-2", "audio-2"])("every spot of %s, one after another", (trackId) => {
    const original = shortFilm();
    expect(timelineProblem(original)).toBeNull();
    const snapshot = structuredClone(original);
    const spec = trackId.startsWith("audio") ? DEFAULT_AUDIO_TRANSITION : DEFAULT_VIDEO_TRANSITION;
    for (const spot of trackSpots(original, trackId)) {
      const plan = planAtSpot(original, spot, spec, true);
      if (!plan.ok || spot.kind !== "cut") continue;
      const left = original.clips.find((item) => item.clip_id === spot.leftId)!;
      const right = original.clips.find((item) => item.clip_id === spot.rightId)!;
      expect(plan.frames).toBeGreaterThanOrEqual(1);
      expect(plan.frames).toBeLessThanOrEqual(activeTransition(left.effects)?.frames ?? room(original, left, right));
    }
    const result = applyAtSpots(original, trackSpots(original, trackId).map((spot) => ({ spot, spec })), true, 12, counter());
    expect(original).toEqual(snapshot);
    expect(result.applied).toBeGreaterThan(0);
    const transitions = (timeline: StudioTimeline) => trackClips(timeline, trackId).filter((item) => activeTransition(item.effects)).length;
    if (trackId === "video-1") expect(transitions(result.timeline)).toBe(transitions(original) + 2);
    expect(timelineProblem(result.timeline)).toBeNull();
    expectNoOverlap(result.timeline);
    expect(timelineDuration(result.timeline)).toBe(timelineDuration(original));
    for (const after of result.timeline.clips) {
      const before = original.clips.find((item) => item.clip_id === after.clip_id)!;
      // A transition runs the clips on past their cut and a fade is drawn over them: between its cuts every clip shows
      // the frames it showed, where it showed them
      const shown = betweenCuts(original, before);
      expect(betweenCuts(result.timeline, after)).toEqual(shown);
      for (let frame = shown.start; frame < shown.end; frame += 1) expect(sourceFrameAtTimeline(after, frame)).toBe(sourceFrameAtTimeline(before, frame));
      const transition = activeTransition(after.effects);
      const next = trackClips(result.timeline, after.track_id).find((item) => item.start_frame === clipEnd(after) - (transition?.frames ?? 0) && item.clip_id !== after.clip_id);
      if (transition && next) {
        const ordered = trackClips(result.timeline, after.track_id);
        const previous = ordered[ordered.indexOf(after) - 1];
        const incoming = previous ? Math.max(0, clipEnd(previous) - after.start_frame) : 0;
        expect(transition.frames + incoming).toBeLessThanOrEqual(clipDuration(after));
        expect(transition.frames).toBeLessThanOrEqual(clipDuration(next) - (activeTransition(next.effects)?.frames ?? 0));
      }
    }
  });

  it("dissolves a free end of an upper track with opacity keys inside the clip, keeping its other keys", () => {
    const original = shortFilm();
    const overlay = original.clips.find((item) => item.clip_id === "overlay")!;
    const tail = trackSpots(original, "video-2").find((spot) => spot.kind === "tail")!;
    const result = applyAtSpots(original, [{ spot: tail, spec: DEFAULT_VIDEO_TRANSITION }], true, 12, counter());
    expect(result.applied).toBe(1);
    expect(timelineProblem(result.timeline)).toBeNull();
    const keys: TimelineKeyframe[] = result.timeline.clips.find((item) => item.clip_id === "overlay")!.motion.keyframes.opacity ?? [];
    const { start_frame: from, end_frame: to } = windowBounds(overlay);
    expect(keys[0]).toEqual(overlay.motion.keyframes.opacity?.[0]);
    expect(keys.every((key) => key.frame >= from && key.frame < to)).toBe(true);
    expect(keys.at(-1)).toMatchObject({ frame: to - 1, value: 0 });
    // At the head the dissolve may only run up to the clip's first key
    const head = trackSpots(result.timeline, "video-2").find((spot) => spot.kind === "head")!;
    const refused = planAtSpot(result.timeline, head, { ...DEFAULT_VIDEO_TRANSITION }, true, 12);
    expect(refused.ok).toBe(true);
    if (refused.ok) expect(refused.frames).toBeLessThan(6);
  });
});

describe("an adjustment layer and the transitions placed on its edges", () => {
  it("takes none on a cut, and a dissolve on its free end eases its effect in", () => {
    const original = film();
    original.sources.push({ source_id: "adjust", name: "adjust", kind: "adjustment", file: null, duration_frames: 100000, width: 64, height: 36, has_audio: false });
    // Right after the overlay on V2 (10–40): a cut between the two, and a free end at 70
    original.clips.push(clip("layer", "video-2", 40, 30, { source_id: "adjust" }));
    expect(timelineProblem(original)).toBeNull();
    const snapshot = structuredClone(original);
    const spots = trackSpots(original, "video-2");
    const cut = spots.find((spot) => spot.kind === "cut")!;
    for (const spec of [DEFAULT_VIDEO_TRANSITION, { ...DEFAULT_VIDEO_TRANSITION, kind: "push" as const }]) {
      expect(planAtSpot(original, cut, spec, true)).toEqual({ ok: false, reason: ADJUSTMENT_TRANSITION, applied: false });
    }
    const tail = spots.find((spot) => spot.kind === "tail" && spot.clipId === "layer")!;
    const result = applyAtSpots(original, [{ spot: tail, spec: DEFAULT_VIDEO_TRANSITION }], true, 12, counter());
    expect(original).toEqual(snapshot);
    expect(result.applied).toBe(1);
    expect(timelineProblem(result.timeline)).toBeNull();
    const layer = result.timeline.clips.find((item) => item.clip_id === "layer")!;
    expect(layer.motion.keyframes.opacity?.at(-1)).toMatchObject({ value: 0 });
  });
});

describe("pasted attributes keep their keys inside the clip", () => {
  it("cuts a longer curve at the end of a shorter clip and refuses a stack over its limit as a whole", () => {
    const original = film();
    const keys: TimelineKeyframe[] = [{ frame: 0, value: -0.2, interpolation: "linear" }, { frame: 59, value: 0.3, interpolation: "bezier", bezier: [0.2, 0.1, 0.4, 1] }];
    original.clips = original.clips.map((item) => (item.clip_id === "v-two" ? { ...item, motion: { ...item.motion, x: 0.1, keyframes: { x: keys } } } : item));
    const copied = copyClips(original, ["v-two"], false);
    if (!copied.ok) throw new Error(copied.error);
    const snapshot = structuredClone(original);
    const result = pasteAttributes(original, copied.value, ["v-three"], false, new Set(["motion", "opacity"]), counter());
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    expect(timelineProblem(result.value.timeline)).toBeNull();
    const target = result.value.timeline.clips.find((item) => item.clip_id === "v-three")!;
    const pasted = target.motion.keyframes.x ?? [];
    expect(pasted.length).toBeGreaterThan(0);
    expect(pasted.every((key) => key.frame >= 0 && key.frame <= clipDuration(target))).toBe(true);
    expect(target.motion.x).toBe(0.1);

    const stacked = structuredClone(original);
    const effect = { kind: "blur" as const, effect_id: "blur", enabled: true, radius: 2 };
    stacked.clips = stacked.clips.map((item) =>
      item.clip_id === "v-two" ? { ...item, effect_stack: [effect] } : item.clip_id === "v-three" ? { ...item, effect_stack: Array.from({ length: 8 }, (_, index) => ({ ...effect, effect_id: `blur-${index}` })) } : item,
    );
    const source = copyClips(stacked, ["v-two"], false);
    if (!source.ok) throw new Error(source.error);
    const full = structuredClone(stacked);
    expect(pasteAttributes(stacked, source.value, ["v-three"], false, new Set(["effects"]), counter()).ok).toBe(false);
    expect(stacked).toEqual(full);
  });
});
