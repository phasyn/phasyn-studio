import { contractFixture, fixtureValue } from "@/test/fixtures";
import adjustmentVectors from "@contracts/examples/timeline-commands/add-adjustment.json";
import { describe, expect, it } from "vitest";
import type { StudioTimeline, TimelineClip, TimelineKeyframe } from "@/api/generated/contracts";
import { NODE_A_ID } from "@/test/ids";
import { ADJUSTMENT_TRANSITION } from "./adjustment";
import { createAdjustmentLayer } from "./adjustmentLayer";
import { executeEdit, type EditCommand } from "./commands";
import { createEditHistory } from "./history";
import { compositingChannels } from "./animation";
import { evaluateCurve, upsertCurveKey } from "./curves";
import { createTextLayer } from "./textLayer";
import { editCommand } from "./timelineGeometry";
import { clipDuration, clipEnd, motionAt, processedDuration, sourceBoundary, sourceFrameAtTimeline, toProcessingFrame, MOTION_CHANNELS } from "./model";
import { animationChannels } from "./animationChannels";
import { audioFadeFactor, cameraView, videoFadeFactor } from "./previewMath";

function clip(id = "clip-a", frames = 24): TimelineClip {
  return {
    clip_id: id, source_id: "source-a", track_id: "video-a", name: "Synthetic clip",
    start_frame: 0, in_frame: 0, out_frame: frames,
    motion: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, gain_db: 0, pan: 0, keyframes: {} },
  };
}
function timeline(): StudioTimeline {
  return {
    version: 1, fps: { num: 24, den: 1 }, master_gain_db: 0,
    sources: [{
      source_id: "source-a", name: "Synthetic source", kind: "video", duration_frames: 24,
      width: 64, height: 32, has_audio: true,
      file: { node_id: NODE_A_ID, file_id: "00000000-0000-4000-8000-00000000f001", size_bytes: 1, sha256: "a".repeat(64), media_type: "video/mp4", metadata: {} },
    }],
    tracks: [{ track_id: "video-a", name: "V1", kind: "video", locked: false, muted: false, solo: false, sync_lock: true, gain_db: 0, pan: 0 }],
    clips: [clip()],
    captions: [
      { caption_id: "caption-before", start_frame: 0, end_frame: 10, text: "Before insert", position: "bottom", size: "small" },
      { caption_id: "caption-after", start_frame: 10, end_frame: 20, text: "After insert", position: "bottom", size: "small" },
    ],
    markers: [{ marker_id: "marker-a", frame: 20, name: "Synthetic marker", color: "blue" }],
  };
}

function groupedTimeline(): StudioTimeline {
  const value = timeline();
  value.sources = value.sources.map((source) => ({ ...source, duration_frames: 1000 }));
  const template = fixtureValue(value.tracks[0], "editBoundary.test.ts");
  value.tracks = (["video", "audio"] as const).flatMap((kind) => [0, 1, 2].map((index) => ({ ...template, kind, track_id: `${kind}-${String(index)}`, name: `${kind}-${String(index)}` })));
  value.clips = (["video", "audio"] as const).flatMap((kind) => [
    { ...clip(`${kind}-first`, 20), track_id: `${kind}-0`, linked_id: "first-link" },
    { ...clip(`${kind}-second`, 20), track_id: `${kind}-1`, start_frame: 40, linked_id: "second-link" },
  ]);
  value.captions = []; value.markers = [];
  return value;
}
function transitionTimeline(): StudioTimeline {
  const value = timeline();
  value.sources = value.sources.map((source) => ({ ...source, duration_frames: 1000 }));
  value.tracks.push({ ...fixtureValue(value.tracks[0], "editBoundary.test.ts"), kind: "audio", track_id: "audio-a", name: "A1" });
  value.clips = (["video", "audio"] as const).flatMap((kind) => [0, 1, 2].map((index) => ({
    ...clip(`${kind}-${String(index)}`, 100), track_id: `${kind}-a`, start_frame: index * 80, linked_id: `link-${String(index)}`,
    ...(index < 2 ? { effects: { transition_out: { kind: "crossfade" as const, frames: 20 } } } : {}),
  })));
  value.captions = []; value.markers = [];
  return value;
}

function expectVisibleInterval(value: TimelineClip, start: number, duration: number, sourceIn: number, sourceOut: number): void {
  expect(value.start_frame).toBe(start); expect(clipDuration(value)).toBe(duration);
  expect(sourceBoundary(value, "in")).toBe(sourceIn); expect(sourceBoundary(value, "out")).toBe(sourceOut);
}
function expectPreservedSample(after: TimelineClip, local: number, before: TimelineClip, previousLocal: number, sourceShift = 0): void {
  expect(sourceFrameAtTimeline(after, after.start_frame + local)).toBe(sourceFrameAtTimeline(before, before.start_frame + previousLocal) + sourceShift);
  const afterMotion = motionAt(after, after.start_frame + local); const beforeMotion = motionAt(before, before.start_frame + previousLocal);
  for (const key of MOTION_CHANNELS) expect(afterMotion[key]).toBeCloseTo(beforeMotion[key], 7);
  const previousChannels = compositingChannels(before);
  const channels = compositingChannels(after);
  expect(channels.map((channel) => channel.key)).toEqual(previousChannels.map((channel) => channel.key));
  for (const channel of channels) {
    const previous = fixtureValue(previousChannels.find((item) => item.key === channel.key), "editBoundary.test.ts");
    expect(evaluateCurve(channel.keys, toProcessingFrame(after, local), channel.fallback)).toBeCloseTo(evaluateCurve(previous.keys, toProcessingFrame(before, previousLocal), previous.fallback), 7);
  }
}
function phasedTimeline(): StudioTimeline {
  const value = timeline();
  value.sources = value.sources.map((source) => ({ ...source, duration_frames: 200 }));
  const keys: TimelineKeyframe[] = [{ frame: 0, value: 0.1, interpolation: "bezier", bezier: [0.15, 0.8, 0.85, 0.2], curve_range: [0.15, 0.85] }, { frame: 108, value: 0.8, interpolation: "linear" }];
  value.clips = [{
    ...clip("phased", 130), in_frame: 10,
    effects: { speed_percent: 125, hold: { start: 5, end: 7 }, frame_step: 3, fade: { video_in: 12, video_out: 14, audio_in: 9, audio_out: 13 }, camera: { zoom_percent: 110, shake_px: 4, shake_frames: 31 } },
    motion: { ...clip().motion, keyframes: { x: keys, opacity: structuredClone(keys), gain_db: structuredClone(keys) } },
    effect_stack: [{ kind: "color", effect_id: "color-a", enabled: true, brightness: 0, contrast: 1, saturation: 1, keyframes: { brightness: structuredClone(keys) } }],
    mask: { kind: "rectangle", x: 0.1, y: 0.1, width: 0.5, height: 0.5, feather: 0, invert: false, keyframes: { x: structuredClone(keys) } },
  }];
  value.captions = []; value.markers = [];
  return value;
}

describe("timeline edit data-integrity boundaries", () => {
  it("clears both history directions when an external source changes SHA", () => {
    const original = timeline();
    const first = { ...original, clips: original.clips.map((item) => ({ ...item, name: "First edit" })) };
    const second = { ...first, clips: first.clips.map((item) => ({ ...item, name: "Second edit" })) };
    const history = createEditHistory();
    history.record(original, first);
    history.record(first, second);
    const undone = history.undo(second);
    expect(undone?.ok).toBe(true);
    if (!(undone?.ok === true)) throw new Error("Expected a valid history fixture");
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(true);
    const rebound = {
      ...undone.value,
      sources: undone.value.sources.map((source) => ({ ...source, file: source.file ? { ...source.file, sha256: "b".repeat(64) } : null })),
    };
    const snapshot = structuredClone(rebound);
    // The Controller's answer to this editor's own save (a source bound to another take) keeps the steps
    history.reconcile(rebound, false);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(true);
    // The same document loaded again from outside is the same edit on the same media
    history.reconcile(structuredClone(rebound), true);
    expect(history.canUndo()).toBe(true);
    // A document loaded from outside with other media cannot reuse the steps
    const elsewhere = { ...rebound, sources: rebound.sources.map((source) => ({ ...source, file: source.file ? { ...source.file, sha256: "c".repeat(64) } : null })) };
    history.reconcile(elsewhere, true);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.undo(rebound)).toBeNull();
    expect(history.redo(rebound)).toBeNull();
    expect(rebound).toEqual(snapshot);
  });

  it("refuses undo beyond the latest source extent without consuming the edit", () => {
    const original = timeline();
    const edited = { ...original, clips: [clip("clip-a", 12)] };
    const live = { ...edited, sources: edited.sources.map((source) => ({ ...source, duration_frames: 12 })) };
    const snapshot = structuredClone(live);
    const history = createEditHistory();
    history.record(original, edited);
    history.reconcile(live, false);
    const version = history.snapshot();
    expect(history.undo(live)?.ok).toBe(false);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
    expect(history.snapshot()).toBe(version);
    expect(history.undo(live)?.ok).toBe(false);
    expect(live).toEqual(snapshot);
    const repaired = { ...live, sources: live.sources.map((source) => ({ ...source, duration_frames: 24 })) };
    expect(history.undo(repaired)).toEqual({ ok: true, value: original });
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });

  it("keeps an exclusive caption end at the insertion boundary", () => {
    const original = timeline();
    const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "place", clips: [clip("inserted-clip", 5)], mode: "insert", at: 10, duration: 5 }, (prefix) => `${prefix}-tail`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.captions).toEqual([
      { caption_id: "caption-before", start_frame: 0, end_frame: 10, text: "Before insert", position: "bottom", size: "small" },
      { caption_id: "caption-after", start_frame: 15, end_frame: 25, text: "After insert", position: "bottom", size: "small" },
    ]);
    expect(original).toEqual(snapshot);
  });

  it("keeps a silent middle slide atomic with the neighbours' linked audio", () => {
    const original = timeline();
    const audioTrack = { ...fixtureValue(original.tracks[0], "editBoundary.test.ts"), track_id: "audio-a", name: "A1", kind: "audio" as const };
    original.tracks.push(audioTrack);
    original.clips = [
      { ...clip("left", 10), linked_id: "left-link" },
      { ...clip("middle", 10), start_frame: 10 },
      { ...clip("right", 10), start_frame: 20, linked_id: "right-link" },
      { ...clip("left-audio", 10), track_id: "audio-a", linked_id: "left-link" },
      { ...clip("right-audio", 10), track_id: "audio-a", start_frame: 20, linked_id: "right-link" },
    ];
    const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "slide", clipId: "middle", delta: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    for (const id of ["left", "left-audio"]) expectVisibleInterval(fixtureValue(result.value.clips.find((item) => item.clip_id === id), "editBoundary.test.ts"), 0, 12, 0, 12);
    for (const id of ["right", "right-audio"]) expectVisibleInterval(fixtureValue(result.value.clips.find((item) => item.clip_id === id), "editBoundary.test.ts"), 22, 8, 2, 10);
    expect(original).toEqual(snapshot);
    audioTrack.locked = true;
    const locked = structuredClone(original);
    expect(executeEdit(original, { type: "slide", clipId: "middle", delta: 2 }).ok).toBe(false);
    expect(original).toEqual(locked);
  });

  it("leaves the document and command unchanged when an insertion exceeds source handles", () => {
    const original = timeline();
    const snapshot = structuredClone(original);
    const inserted = clip("invalid-clip", 25);
    const insertedSnapshot = structuredClone(inserted);
    // The range can be inserted, but its source extent fails final validation after shifting edits.
    const result = executeEdit(original, { type: "place", clips: [inserted], mode: "insert", at: 10, duration: 25 }, (prefix) => `${prefix}-tail`);
    expect(result.ok).toBe(false);
    expect(original).toEqual(snapshot);
    expect(inserted).toEqual(insertedSnapshot);
  });

  it.each(["complete group", "locked member", "locked destination", "collision", "track overflow"])("keeps group movement atomic: %s", (scenario) => {
    const original = groupedTimeline();
    if (scenario === "locked member") fixtureValue(original.tracks.find((track) => track.track_id === "audio-1"), "editBoundary.test.ts").locked = true;
    if (scenario === "locked destination") fixtureValue(original.tracks.find((track) => track.track_id === "audio-2"), "editBoundary.test.ts").locked = true;
    if (scenario === "collision") original.clips.push({ ...clip("occupied", 20), track_id: "video-2", start_frame: 50 });
    const command: EditCommand = { type: "move", clipId: "video-first", clipIds: ["video-first", "video-second"], startFrame: 10, trackId: scenario === "track overflow" ? "video-2" : "video-1" };
    const snapshot = structuredClone(original); const commandSnapshot = structuredClone(command);
    const result = executeEdit(original, command);
    expect(original).toEqual(snapshot);
    expect(command).toEqual(commandSnapshot);
    expect(result.ok).toBe(scenario === "complete group" || scenario === "collision");
    if (!result.ok) return;
    if (scenario === "collision") {
      // A move overwrites what it lands on (as in Premiere): the occupied clip gives up the moved span, nothing else changes
      const moved = result.value.clips.filter((item) => item.clip_id === "video-first" || item.clip_id === "video-second");
      for (const other of result.value.clips.filter((item) => item.track_id === "video-2" && !moved.includes(item))) {
        for (const item of moved.filter((entry) => entry.track_id === "video-2")) expect(other.start_frame >= clipEnd(item) || clipEnd(other) <= item.start_frame).toBe(true);
      }
      const history = createEditHistory();
      history.record(original, result.value);
      expect(history.undo(result.value)).toEqual({ ok: true, value: original });
      return;
    }
    expect(result.value.clips).toHaveLength(original.clips.length);
    for (const before of original.clips) {
      const kind = before.track_id.startsWith("video") ? "video" : "audio";
      expect(result.value.clips.find((item) => item.clip_id === before.clip_id)).toEqual({ ...before, start_frame: before.start_frame + 10, track_id: `${kind}-${String(before.clip_id.endsWith("first") ? 1 : 2)}` });
    }
    const history = createEditHistory();
    history.record(original, result.value);
    expect(history.undo(result.value)).toEqual({ ok: true, value: original });
    expect(history.canUndo()).toBe(false);
  });

  it.each([
    { name: "move group together", command: { type: "move", clipId: "video-0", clipIds: ["video-0", "video-1", "video-2"], startFrame: 10, trackId: "video-a" }, starts: [10, 90, 170], lengths: [100, 100, 100], overlaps: [20, 20, undefined] },
    { name: "move apart", command: { type: "move", clipId: "video-0", startFrame: 300, trackId: "video-a" }, starts: [300, 80, 160], lengths: [100, 100, 100], overlaps: [undefined, 20, undefined] },
    { name: "trim transition", command: { type: "trim", clipId: "video-0", edge: "out", delta: -10 }, starts: [0, 80, 160], lengths: [90, 100, 100], overlaps: [10, 20, undefined] },
    { name: "ripple trim transition", command: { type: "trim", clipId: "video-0", edge: "out", delta: -10, ripple: true }, starts: [0, 70, 150], lengths: [90, 100, 100], overlaps: [20, 20, undefined] },
    { name: "delete middle", command: { type: "delete", clipIds: ["video-1"] }, starts: [0, undefined, 160], lengths: [100, undefined, 100], overlaps: [undefined, undefined, undefined] },
    { name: "ripple delete middle", command: { type: "delete", clipIds: ["video-1"], ripple: true }, starts: [0, undefined, 100], lengths: [100, undefined, 100], overlaps: [undefined, undefined, undefined] },
    { name: "ripple delete head", command: { type: "delete", clipIds: ["video-0"], ripple: true }, starts: [undefined, 0, 80], lengths: [undefined, 100, 100], overlaps: [undefined, 20, undefined] },
  ] satisfies { name: string; command: EditCommand; starts: (number | undefined)[]; lengths: (number | undefined)[]; overlaps: (number | undefined)[] }[])("preserves surviving source intervals through $name", ({ command, starts, lengths, overlaps }) => {
    const original = transitionTimeline(); const snapshot = structuredClone(original);
    const result = executeEdit(original, command);
    expect(original).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.sources).toEqual(original.sources);
    for (const kind of ["video", "audio"]) for (const index of [0, 1, 2]) {
      const before = fixtureValue(original.clips.find((item) => item.clip_id === `${kind}-${String(index)}`), "editBoundary.test.ts");
      const after = result.value.clips.find((item) => item.clip_id === before.clip_id);
      if (starts[index] === undefined) { expect(after).toBeUndefined(); continue; }
      expect(after).toMatchObject({ clip_id: before.clip_id, source_id: before.source_id, track_id: before.track_id, motion: before.motion });
      expectVisibleInterval(fixtureValue(after, "editBoundary.test.ts"), starts[index], fixtureValue(lengths[index], "editBoundary.test.ts"), 0, fixtureValue(lengths[index], "editBoundary.test.ts"));
      for (let frame = 0; frame < clipDuration(fixtureValue(after, "editBoundary.test.ts")); frame += 1) expectPreservedSample(fixtureValue(after, "editBoundary.test.ts"), frame, before, frame);
      const transition = after?.effects?.transition_out;
      expect(transition?.kind === "crossfade" ? transition.frames : undefined).toBe(overlaps[index]);
    }
  });

  it.each([
    { type: "move", clipId: "video-0", startFrame: 90, trackId: "video-a" },
    { type: "trim", clipId: "video-0", edge: "out", delta: 1000 },
    { type: "split", clipIds: ["video-0"], frame: 90 },
  ] satisfies EditCommand[])("keeps source, effects and transitions untouched when an edit cannot preserve them: $type", (command) => {
    const original = transitionTimeline(); const snapshot = structuredClone(original);
    const result = executeEdit(original, command);
    expect(result.ok).toBe(false);
    expect(original).toEqual(snapshot);
  });

  it.each([false, true])("cuts only the requested source/caption interval across transitions (extract=%s)", (ripple) => {
    const original = transitionTimeline();
    original.captions = [{ caption_id: "spanning-caption", start_frame: 70, end_frame: 110, text: "Synthetic caption", position: "bottom", size: "small" }];
    original.markers = [80, 85, 90, 95].map((frame) => ({ marker_id: `marker-${String(frame)}`, frame, name: "Synthetic marker", color: "blue" as const }));
    const snapshot = structuredClone(original); let serial = 0;
    const result = executeEdit(original, { type: "rangeDelete", startFrame: 85, endFrame: 90, ripple }, (prefix) => `${prefix}-fragment-${String(++serial)}`);
    expect(original).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.sources).toEqual(original.sources);
    expect(result.value.clips).toHaveLength(10);
    for (const kind of ["video", "audio"]) {
      const fragments = result.value.clips.filter((item) => item.track_id === `${kind}-a`);
      const intervals = fragments.map((item) => [item.start_frame, clipDuration(item), sourceBoundary(item, "in"), sourceBoundary(item, "out"), item.effects?.transition_out?.kind === "crossfade" ? item.effects.transition_out.frames : 0]);
      expect(intervals).toEqual([
        [0, 85, 0, 85, 5], [ripple ? 85 : 90, 10, 90, 100, 10],
        [80, 5, 0, 5, 0], [ripple ? 85 : 90, 90, 10, 100, 20], [ripple ? 155 : 160, 100, 0, 100, 0],
      ]);
      for (const fragment of fragments) for (let frame = 0; frame < clipDuration(fragment); frame += 1) expect(sourceFrameAtTimeline(fragment, fragment.start_frame + frame)).toBe(sourceBoundary(fragment, "in") + frame);
    }
    expect(result.value.captions.map((caption) => [caption.start_frame, caption.end_frame, caption.text])).toEqual([[70, 85, "Synthetic caption"], [ripple ? 85 : 90, ripple ? 105 : 110, "Synthetic caption"]]);
    expect(new Set(result.value.captions.map((caption) => caption.caption_id)).size).toBe(2);
    expect(result.value.captions.every((caption) => caption.caption_id !== "spanning-caption")).toBe(true);
    expect(result.value.markers.map((marker) => [marker.marker_id, marker.frame])).toEqual(ripple ? [["marker-80", 80], ["marker-90", 85], ["marker-95", 90]] : original.markers.map((marker) => [marker.marker_id, marker.frame]));
    const history = createEditHistory(); history.record(original, result.value);
    expect(history.undo(result.value)).toEqual({ ok: true, value: original });
    expect(history.canUndo()).toBe(false);
  });

  it.each(["split", "insert", "overwrite", "lift", "extract"] as const)("keeps staggered linked members with their surviving side during %s", (operation) => {
    const original = groupedTimeline();
    original.clips = [
      { ...clip("whole-right", 100), track_id: "audio-0", start_frame: 50, linked_id: "staggered" },
      { ...clip("crossing", 100), track_id: "video-0", linked_id: "staggered" },
    ];
    const command: EditCommand = operation === "split" ? { type: "split", clipIds: ["crossing"], frame: 20 }
      : operation === "insert" || operation === "overwrite" ? { type: "place", clips: [{ ...clip("inserted", 20), track_id: "video-0" }, { ...clip("inserted-audio", 20), track_id: "audio-0" }], mode: operation, at: 20, duration: 20 }
      : { type: "rangeDelete", startFrame: 20, endFrame: 40, ripple: operation === "extract" };
    const snapshot = structuredClone(original); let serial = 0;
    const result = executeEdit(original, command, (prefix) => `${prefix}-part-${String(++serial)}`);
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    const head = fixtureValue(result.value.clips.find((item) => item.clip_id === "crossing"), "editBoundary.test.ts");
    const tail = fixtureValue(result.value.clips.find((item) => item.track_id === "video-0" && item.clip_id !== "crossing" && item.clip_id !== "inserted"), "editBoundary.test.ts");
    const complete = fixtureValue(result.value.clips.find((item) => item.clip_id === "whole-right"), "editBoundary.test.ts");
    expect(head.linked_id).toBe("staggered");
    expect(tail.linked_id).toBeDefined(); expect(tail.linked_id).not.toBe(head.linked_id);
    expect(complete.linked_id).toBe(tail.linked_id);
    expectVisibleInterval(complete, operation === "insert" ? 70 : operation === "extract" ? 30 : 50, 100, 0, 100);
    const retainedStart = operation === "split" || operation === "insert" ? 20 : 40;
    expectVisibleInterval(tail, operation === "insert" || operation === "overwrite" || operation === "lift" ? 40 : 20, 100 - retainedStart, retainedStart, 100);
    const beforeTail = fixtureValue(original.clips.find((item) => item.clip_id === "crossing"), "editBoundary.test.ts");
    for (let frame = 0; frame < clipDuration(tail); frame += 1) expectPreservedSample(tail, frame, beforeTail, retainedStart + frame);
    const moved = executeEdit(result.value, { type: "move", clipId: tail.clip_id, startFrame: tail.start_frame + 200, trackId: tail.track_id });
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.value.clips.find((item) => item.clip_id === head.clip_id)?.start_frame).toBe(head.start_frame);
    expect(moved.value.clips.find((item) => item.clip_id === complete.clip_id)?.start_frame).toBe(complete.start_frame + 200);
    const history = createEditHistory(); history.record(original, result.value);
    expect(history.undo(result.value)).toEqual({ ok: true, value: original });
  });

  it("rejects relinking an otherwise untouched locked member of a split range group", () => {
    const original = groupedTimeline();
    original.clips = [
      { ...clip("crossing", 100), track_id: "video-0", linked_id: "staggered" },
      { ...clip("whole-right", 100), track_id: "audio-0", start_frame: 50, linked_id: "staggered" },
    ];
    fixtureValue(original.tracks.find((track) => track.track_id === "audio-0"), "editBoundary.test.ts").locked = true;
    const snapshot = structuredClone(original);
    expect(executeEdit(original, { type: "rangeDelete", startFrame: 20, endFrame: 40, ripple: false }).ok).toBe(false);
    expect(original).toEqual(snapshot);
  });

  it.each(["roll", "slide"] as const)("retains original transition pairs and linked source geometry through %s", (operation) => {
    const original = transitionTimeline(); const snapshot = structuredClone(original);
    const gesture = editCommand(original, fixtureValue(original.clips.find((item) => item.clip_id === "video-1"), "editBoundary.test.ts"), operation === "roll" ? "rollIn" : "slide", 5, "video-a", true);
    if (!gesture.ok) throw new Error(gesture.error);
    const result = executeEdit(original, gesture.value);
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    for (const kind of ["video", "audio"]) {
      const left = fixtureValue(result.value.clips.find((item) => item.clip_id === `${kind}-0`), "editBoundary.test.ts");
      const middle = fixtureValue(result.value.clips.find((item) => item.clip_id === `${kind}-1`), "editBoundary.test.ts");
      const right = fixtureValue(result.value.clips.find((item) => item.clip_id === `${kind}-2`), "editBoundary.test.ts");
      expectVisibleInterval(left, 0, 105, 0, 105);
      expectVisibleInterval(middle, 85, operation === "roll" ? 95 : 100, operation === "roll" ? 5 : 0, 100);
      expectVisibleInterval(right, operation === "slide" ? 165 : 160, operation === "slide" ? 95 : 100, operation === "slide" ? 5 : 0, 100);
      expect(left.effects?.transition_out).toEqual({ kind: "crossfade", frames: 20 });
      expect(middle.effects?.transition_out).toEqual({ kind: "crossfade", frames: 20 });
      expect(clipEnd(left) - middle.start_frame).toBe(20);
      expect(clipEnd(middle) - right.start_frame).toBe(20);
      expect(clipEnd(right)).toBe(260);
    }
    const history = createEditHistory(); history.record(original, result.value);
    expect(history.undo(result.value)).toEqual({ ok: true, value: original });
  });

  it.each(["roll", "slide"] as const)("rejects a transitioned %s when linked source handles are unavailable", (operation) => {
    const original = transitionTimeline(); const snapshot = structuredClone(original);
    const command: EditCommand = operation === "roll" ? { type: "roll", leftId: "video-0", rightId: "video-1", delta: -1 }
      : { type: "slide", clipId: "video-1", delta: -1 };
    expect(executeEdit(original, command).ok).toBe(false);
    expect(original).toEqual(snapshot);
  });

  it("preserves source samples when splitting outside transition overlaps", () => {
    const original = transitionTimeline(); const snapshot = structuredClone(original); let serial = 0;
    const result = executeEdit(original, { type: "split", clipIds: ["video-1"], frame: 140 }, (prefix) => `${prefix}-part-${String(++serial)}`);
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    for (const kind of ["video", "audio"]) {
      const before = fixtureValue(original.clips.find((item) => item.clip_id === `${kind}-1`), "editBoundary.test.ts");
      const fragments = result.value.clips.filter((item) => item.track_id === before.track_id && (item.clip_id === before.clip_id || item.start_frame === 140));
      expect(fragments).toHaveLength(2);
      for (const fragment of fragments) for (let frame = 0; frame < clipDuration(fragment); frame += 1) {
        const at = fragment.start_frame + frame;
        expect(sourceFrameAtTimeline(fragment, at)).toBe(sourceFrameAtTimeline(before, at));
      }
      expect(fragments.find((item) => item.start_frame === 140)?.effects?.transition_out).toEqual({ kind: "crossfade", frames: 20 });
      expect(result.value.clips.find((item) => item.clip_id === `${kind}-0`)?.effects?.transition_out).toEqual({ kind: "crossfade", frames: 20 });
    }
  });

  it("slips linked source samples without changing transition geometry", () => {
    const original = transitionTimeline(); const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "slip", clipId: "video-1", delta: 5 });
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    for (const before of original.clips) {
      const after = fixtureValue(result.value.clips.find((item) => item.clip_id === before.clip_id), "editBoundary.test.ts");
      expect(after.start_frame).toBe(before.start_frame); expect(after.effects).toEqual(before.effects);
      expect(clipDuration(after)).toBe(clipDuration(before));
      for (let frame = 0; frame < clipDuration(after); frame += 1) expectPreservedSample(after, frame, before, frame, before.linked_id === "link-1" ? 5 : 0);
    }
  });

  it.each(["locked intersection", "locked following clip"])("rejects the whole range edit at the data boundary: %s", (scenario) => {
    const original = timeline();
    if (scenario === "locked intersection") fixtureValue(original.tracks[0], "editBoundary.test.ts").locked = true;
    if (scenario === "locked following clip") { fixtureValue(original.tracks[0], "editBoundary.test.ts").locked = true; fixtureValue(original.clips[0], "editBoundary.test.ts").start_frame = 20; }
    const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "rangeDelete", startFrame: 1, endFrame: 2, ripple: true });
    expect(result.ok).toBe(false);
    expect(original).toEqual(snapshot);
  });
});


describe("generated text and automated clip edit integrity", () => {
  it("extends generated text left without consuming nonexistent source handles", () => {
    const original = timeline(); original.clips = []; original.captions = []; original.markers = [];
    let serial = 0;
    const created = createTextLayer(original, 240, 64, 32, (prefix) => `${prefix}-${String(++serial)}`);
    if (!created.ok) throw new Error(created.error);
    const snapshot = structuredClone(created.value.timeline);
    const result = executeEdit(created.value.timeline, { type: "trim", clipId: created.value.clipId, edge: "in", delta: -24 });
    expect(created.value.timeline).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    expectVisibleInterval(fixtureValue(result.value.clips[0], "editBoundary.test.ts"), 216, 144, 0, 144);
    expect(result.value.clips[0]?.effects?.title).toMatchObject({ start_frame: 0, end_frame: null });
    expect(result.value.clips[0]?.effects?.title?.text).toBe(snapshot.clips[0]?.effects?.title?.text);
  });

  it("preserves effect and mask curve phases across destructive range cuts", () => {
    const original = timeline(); original.captions = []; original.markers = [];
    const keys = [{ frame: 0, value: 0.1, interpolation: "bezier" as const, bezier: [0.1, 0.8, 0.9, 0.2] }, { frame: 24, value: 0.8, interpolation: "linear" as const }];
    fixtureValue(original.clips[0], "editBoundary.test.ts").effect_stack = [{ kind: "color", effect_id: "color-a", enabled: true, brightness: 0, contrast: 1, saturation: 1, keyframes: { brightness: keys } }];
    fixtureValue(original.clips[0], "editBoundary.test.ts").mask = { kind: "rectangle", x: 0.1, y: 0.1, width: 0.5, height: 0.5, feather: 0, invert: false, keyframes: { x: keys } };
    const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "rangeDelete", startFrame: 8, endFrame: 16, ripple: false });
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    for (const fragment of result.value.clips) for (const channel of compositingChannels(fragment)) {
      if (!channel.keys.length) continue;
      for (let frame = 0; frame <= clipDuration(fragment); frame += 1) expect(evaluateCurve(channel.keys, toProcessingFrame(fragment, frame), channel.fallback)).toBeCloseTo(evaluateCurve(keys, fragment.start_frame + frame, 0), 7);
    }
  });

  it("rejects malformed Bezier automation before recording an edit", () => {
    const original = timeline(); const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "patchClip", clipId: "clip-a", patch: { effect_stack: [{ kind: "blur", effect_id: "blur-a", enabled: true, radius: 4, keyframes: { radius: [{ frame: 0, value: 4, interpolation: "bezier" }] } }] } });
    expect(result.ok).toBe(false); expect(original).toEqual(snapshot);
  });
});


describe("output-window and timing edit data-integrity boundaries", () => {
  it.each([false, true])("retains fractional source sampling through a destructive range edit (extract=%s)", (ripple) => {
    const original = timeline(); original.captions = []; original.markers = [];
    fixtureValue(original.clips[0], "editBoundary.test.ts").effects = { speed_percent: 125, frame_step: 3 };
    const before = fixtureValue(original.clips[0], "editBoundary.test.ts"); const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "rangeDelete", startFrame: 1, endFrame: 2, ripple });
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    const fragments = result.value.clips.toSorted((a, b) => a.start_frame - b.start_frame);
    expect(fragments).toHaveLength(2);
    expect(clipDuration(fixtureValue(fragments[0], "editBoundary.test.ts"))).toBe(1); expect(clipDuration(fixtureValue(fragments[1], "editBoundary.test.ts"))).toBe(17);
    for (const [index, fragment] of fragments.entries()) for (let frame = 0; frame < clipDuration(fragment); frame += 1) expectPreservedSample(fragment, frame, before, (index === 0 ? 0 : 2) + frame);
  });

  it.each([2, 8, 16, 65, 104])("preserves source, animation and effect samples on both sides of arbitrary split %s", (at) => {
    const original = phasedTimeline(); const before = fixtureValue(original.clips[0], "editBoundary.test.ts"); const snapshot = structuredClone(original);
    expect(clipDuration(before)).toBe(108);
    const result = executeEdit(original, { type: "split", clipIds: [before.clip_id], frame: at });
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.clips).toHaveLength(2);
    expect(result.value.clips.map(clipDuration)).toEqual([at, 108 - at]);
    for (const fragment of result.value.clips) for (let frame = 0; frame < clipDuration(fragment); frame += 1) {
      const previous = fragment.start_frame + frame;
      expectPreservedSample(fragment, frame, before, previous);
      const processing = toProcessingFrame(fragment, frame);
      expect(videoFadeFactor(fragment.effects, processedDuration(fragment), processing)).toBe(videoFadeFactor(before.effects, processedDuration(before), previous));
      expect(audioFadeFactor(fragment.effects, processedDuration(fragment), processing)).toBe(audioFadeFactor(before.effects, processedDuration(before), previous));
      expect(cameraView(fragment.effects, processing, 64, 32)).toEqual(cameraView(before.effects, previous, 64, 32));
    }
  });

  it("keeps all 128 keys and isolates mutable animation data when splitting between keys", () => {
    const original = timeline(); original.captions = []; original.markers = [];
    original.sources = original.sources.map((source) => ({ ...source, duration_frames: 256 }));
    const keys: TimelineKeyframe[] = Array.from({ length: 128 }, (_, index) => ({ frame: index * 2, value: index / 160, interpolation: "bezier", bezier: [0.1, 0.8, 0.9, 0.2], curve_range: [0.2, 0.8] }));
    const before = clip("dense", 256); before.motion.keyframes.x = keys;
    before.effect_stack = [{ kind: "color", effect_id: "dense-color", enabled: true, brightness: 0, contrast: 1, saturation: 1, keyframes: { brightness: structuredClone(keys) } }];
    before.mask = { kind: "rectangle", x: 0, y: 0, width: 0.5, height: 0.5, feather: 0, invert: false, keyframes: { x: structuredClone(keys) } };
    original.clips = [before]; const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "split", clipIds: [before.clip_id], frame: 1 });
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    const head = fixtureValue(result.value.clips.find((item) => item.start_frame === 0), "editBoundary.test.ts");
    const tail = fixtureValue(result.value.clips.find((item) => item.start_frame === 1), "editBoundary.test.ts");
    for (const channel of animationChannels(before, "video").filter((item) => item.keys.length)) {
      const headKeys = fixtureValue(animationChannels(head, "video").find((item) => item.key === channel.key), "editBoundary.test.ts").keys;
      const tailKeys = fixtureValue(animationChannels(tail, "video").find((item) => item.key === channel.key), "editBoundary.test.ts").keys;
      expect(headKeys).toHaveLength(128); expect(tailKeys).toHaveLength(128);
      expect(headKeys).toEqual(channel.keys); expect(tailKeys).toEqual(channel.keys);
      expect(headKeys).not.toBe(channel.keys); expect(tailKeys).not.toBe(channel.keys); expect(headKeys).not.toBe(tailKeys);
      expect(headKeys[0]).not.toBe(channel.keys[0]); expect(tailKeys[0]).not.toBe(channel.keys[0]); expect(headKeys[0]).not.toBe(tailKeys[0]);
      expect(headKeys[0]?.bezier).not.toBe(channel.keys[0]?.bezier); expect(tailKeys[0]?.bezier).not.toBe(channel.keys[0]?.bezier); expect(headKeys[0]?.bezier).not.toBe(tailKeys[0]?.bezier);
      expect(headKeys[0]?.curve_range).not.toBe(channel.keys[0]?.curve_range); expect(tailKeys[0]?.curve_range).not.toBe(channel.keys[0]?.curve_range); expect(headKeys[0]?.curve_range).not.toBe(tailKeys[0]?.curve_range);
    }
    const tailSnapshot = structuredClone(tail);
    fixtureValue(fixtureValue(head.motion.keyframes.x, "editBoundary.test.ts")[0], "editBoundary.test.ts").value = 0.5;
    fixtureValue(fixtureValue(fixtureValue(head.motion.keyframes.x, "editBoundary.test.ts")[0], "editBoundary.test.ts").bezier, "editBoundary.test.ts")[0] = 0.4;
    fixtureValue(fixtureValue(fixtureValue(head.motion.keyframes.x, "editBoundary.test.ts")[0], "editBoundary.test.ts").curve_range, "editBoundary.test.ts")[0] = 0.3;
    expect(tail).toEqual(tailSnapshot); expect(original).toEqual(snapshot);
  });

  it("restores trimmed output without consuming handles or restarting retained effect phases", () => {
    const original = phasedTimeline(); const before = fixtureValue(original.clips[0], "editBoundary.test.ts"); const snapshot = structuredClone(original);
    let current = original;
    for (const command of [
      { type: "trim", clipId: before.clip_id, edge: "in", delta: 7 },
      { type: "trim", clipId: before.clip_id, edge: "out", delta: -9 },
      { type: "trim", clipId: before.clip_id, edge: "in", delta: -7 },
      { type: "trim", clipId: before.clip_id, edge: "out", delta: 9 },
    ] satisfies EditCommand[]) {
      const prior = structuredClone(current); const result = executeEdit(current, command);
      expect(current).toEqual(prior);
      if (!result.ok) throw new Error(result.error);
      current = result.value;
    }
    const restored = fixtureValue(current.clips[0], "editBoundary.test.ts");
    expectVisibleInterval(restored, 0, 108, 10, 130);
    expect(restored.effects).toEqual(before.effects); expect(restored.motion).toEqual(before.motion);
    expect(restored.effect_stack).toEqual(before.effect_stack); expect(restored.mask).toEqual(before.mask);
    for (let frame = 0; frame < clipDuration(before); frame += 1) expectPreservedSample(restored, frame, before, frame);
    expect(original).toEqual(snapshot);
  });

  it.each(["speed", "hold"] as const)("applies %s to the visible source and animation of an ordinary split", (operation) => {
    const original = timeline(); original.captions = []; original.markers = [];
    fixtureValue(original.clips[0], "editBoundary.test.ts").motion.keyframes.x = [{ frame: 12, value: 0.1, interpolation: "bezier", bezier: [0.1, 0.8, 0.9, 0.2], curve_range: [0.2, 0.8] }, { frame: 24, value: 0.9, interpolation: "linear" }];
    const split = executeEdit(original, { type: "split", clipIds: ["clip-a"], frame: 12 });
    if (!split.ok) throw new Error(split.error);
    const before = fixtureValue(split.value.clips.find((item) => item.start_frame === 12), "editBoundary.test.ts");
    const snapshot = structuredClone(split.value);
    const result = executeEdit(split.value, { type: "patchClip", clipId: before.clip_id, patch: { effects: operation === "speed" ? { speed_percent: 200 } : { hold: { start: 3, end: 2 } } } });
    expect(split.value).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    const after = fixtureValue(result.value.clips.find((item) => item.clip_id === before.clip_id), "editBoundary.test.ts");
    expectVisibleInterval(after, 12, operation === "speed" ? 6 : 17, 12, 24);
    expect(result.value.clips.find((item) => item.clip_id === "clip-a")).toEqual(snapshot.clips.find((item) => item.clip_id === "clip-a"));
    if (operation === "speed") for (let frame = 0; frame < 6; frame += 1) expectPreservedSample(after, frame, before, frame * 2);
    else {
      for (let frame = 0; frame < 12; frame += 1) expectPreservedSample(after, frame + 3, before, frame);
      for (const frame of [0, 1, 2]) expect(sourceFrameAtTimeline(after, after.start_frame + frame)).toBe(12);
      for (const frame of [15, 16]) expect(sourceFrameAtTimeline(after, after.start_frame + frame)).toBe(23);
    }
    expect(after.motion.keyframes.x?.[0]?.interpolation).toBe("bezier");
    expect(after.motion.keyframes.x?.[0]?.bezier).toEqual(before.motion.keyframes.x?.[0]?.bezier);
    expect(after.motion.keyframes.x?.[0]?.curve_range).toEqual([0.2, 0.8]);
  });

  it.each(["fractional source phase", "integer tempo phase", "frame-step phase", "fractional animation time"] as const)("rejects the whole linked timing edit without discarding %s", (scenario) => {
    const original = groupedTimeline();
    original.clips = [
      { ...clip("timing-video", 24), track_id: "video-0", start_frame: 12, linked_id: "timing-link", output_window: { start_frame: 12, end_frame: 24 } },
      { ...clip("timing-audio", 24), track_id: "audio-0", start_frame: 12, linked_id: "timing-link", output_window: { start_frame: 12, end_frame: 24 } },
    ];
    const peer = fixtureValue(original.clips[1], "editBoundary.test.ts");
    if (scenario !== "fractional animation time") {
      peer.output_window = scenario === "integer tempo phase" ? { start_frame: 2, end_frame: 14 } : { start_frame: 1, end_frame: 13 };
      peer.effects = scenario === "fractional source phase" ? { speed_percent: 125 } : scenario === "integer tempo phase" ? { speed_percent: 150 } : { frame_step: 3 };
    } else peer.motion.keyframes.gain_db = [{ frame: 0, value: 0, interpolation: "linear" }, { frame: 13, value: -6, interpolation: "linear" }, { frame: 24, value: 0, interpolation: "linear" }];
    const command: EditCommand = { type: "patchClip", clipId: "timing-video", patch: { effects: { speed_percent: 200 } } };
    const snapshot = structuredClone(original); const commandSnapshot = structuredClone(command);
    expect(executeEdit(original, command).ok).toBe(false);
    expect(original).toEqual(snapshot); expect(command).toEqual(commandSnapshot);
  });

  it("changes only the requested hold edge without restoring a cropped-away hold", () => {
    const original = timeline(); original.captions = []; original.markers = [];
    original.sources = original.sources.map((source) => ({ ...source, duration_frames: 100 }));
    original.clips = [{ ...clip("held-window", 100), start_frame: 20, effects: { hold: { start: 0, end: 10 } }, output_window: { start_frame: 20, end_frame: 40 } }];
    const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "patchClip", clipId: "held-window", patch: { effects: { hold: { start: 5, end: 10 } } } });
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    const after = fixtureValue(result.value.clips[0], "editBoundary.test.ts");
    expectVisibleInterval(after, 20, 25, 20, 40);
    expect(after.effects?.hold).toEqual({ start: 5, end: 0 });
    for (let frame = 0; frame < 5; frame += 1) expect(sourceFrameAtTimeline(after, after.start_frame + frame)).toBe(20);
    for (let frame = 0; frame < 20; frame += 1) expectPreservedSample(after, frame + 5, fixtureValue(original.clips[0], "editBoundary.test.ts"), frame);
  });

  it("preserves curve progress across a hold/core boundary whose time scale changes", () => {
    const original = timeline(); original.captions = []; original.markers = [];
    const before: TimelineClip = { ...clip("held-curve", 10), effects: { hold: { start: 10 } } };
    const keys: TimelineKeyframe[] = [{ frame: 0, value: 0, interpolation: "linear" }, { frame: 20, value: 1, interpolation: "linear" }];
    before.motion.keyframes.x = keys;
    before.effect_stack = [{ kind: "color", effect_id: "held-color", enabled: true, brightness: 0, contrast: 1, saturation: 1, keyframes: { brightness: structuredClone(keys) } }];
    before.mask = { kind: "rectangle", x: 0, y: 0, width: 0.5, height: 0.5, feather: 0, invert: false, keyframes: { x: structuredClone(keys) } };
    original.clips = [before]; const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "patchClip", clipId: before.clip_id, patch: { effects: { hold: { start: 20 } } } });
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    const after = fixtureValue(result.value.clips[0], "editBoundary.test.ts");
    expect(clipDuration(after)).toBe(30);
    expect(motionAt(after, 20).x).toBeCloseTo(0.5, 8);
    for (let frame = 0; frame < 30; frame += 1) expectPreservedSample(after, frame, before, frame <= 20 ? frame / 2 : frame - 10);
    expect(motionAt(after, 30).x).toBe(1);
  });

  it.each([-1, 1])("slips a visible window by %s using its own available source handles", (delta) => {
    const original = timeline(); original.captions = []; original.markers = [];
    original.sources = original.sources.map((source) => ({ ...source, duration_frames: 100 }));
    const before: TimelineClip = { ...clip("slip-window", 100), start_frame: 10, output_window: { start_frame: 20, end_frame: 40 } };
    original.clips = [before]; const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "slip", clipId: before.clip_id, delta });
    expect(original).toEqual(snapshot);
    if (!result.ok) throw new Error(result.error);
    const after = fixtureValue(result.value.clips[0], "editBoundary.test.ts");
    expectVisibleInterval(after, 10, 20, 20 + delta, 40 + delta);
    for (let frame = 0; frame < 20; frame += 1) expectPreservedSample(after, frame, before, frame, delta);
  });

  it("applies a new fade to the visible edge without restoring the opposite hidden fade", () => {
    const original = timeline(); original.captions = []; original.markers = [];
    fixtureValue(original.sources[0], "editBoundary.test.ts").duration_frames = 100;
    original.clips = [{ ...clip("fade-window", 100), start_frame: 20, effects: { fade: { video_in: 0, video_out: 10 } }, output_window: { start_frame: 20, end_frame: 40 } }];
    const snapshot = structuredClone(original);
    const result = executeEdit(original, { type: "patchClip", clipId: "fade-window", patch: { effects: { fade: { video_in: 5, video_out: 10 } } } });
    if (!result.ok) throw new Error(result.error);
    const after = fixtureValue(result.value.clips[0], "editBoundary.test.ts");
    expectVisibleInterval(after, 20, 20, 20, 40);
    expect(after.effects?.fade?.video_out).toBe(0);
    expect(videoFadeFactor(after.effects, processedDuration(after), 0)).toBe(0);
    expect(videoFadeFactor(after.effects, processedDuration(after), 5)).toBe(1);
    expect(original).toEqual(snapshot);
  });

  it("allows an existing key update at capacity but rejects a new key atomically", () => {
    const original = timeline(); original.captions = []; original.markers = [];
    fixtureValue(original.sources[0], "editBoundary.test.ts").duration_frames = 256; original.clips = [clip("capacity", 256)];
    const keys: TimelineKeyframe[] = Array.from({ length: 128 }, (_, index) => ({ frame: index * 2, value: 0.5, interpolation: "linear" }));
    fixtureValue(original.clips[0], "editBoundary.test.ts").motion.keyframes.opacity = keys;
    const snapshot = structuredClone(original);
    const update = (frame: number) => executeEdit(original, { type: "patchClip", clipId: "capacity", patch: { motion: { ...fixtureValue(original.clips[0], "editBoundary.test.ts").motion, keyframes: { opacity: upsertCurveKey(keys, frame, 0.7) } } } });
    expect(update(2).ok).toBe(true); expect(update(3).ok).toBe(false);
    expect(original).toEqual(snapshot);
  });

  it("preserves Bezier shape and curve ranges when inserting and replacing an automation key", () => {
    const keys: TimelineKeyframe[] = [{ frame: 0, value: 0.1, interpolation: "bezier", bezier: [0.12, 0.9, 0.8, 0.1], curve_range: [0.2, 0.9] }, { frame: 24, value: 0.9, interpolation: "linear" }];
    const snapshot = structuredClone(keys);
    const inserted = upsertCurveKey(keys, 7, evaluateCurve(keys, 7, 0));
    expect(keys).toEqual(snapshot); expect(inserted).toHaveLength(3);
    expect(inserted[0]?.bezier).toEqual(keys[0]?.bezier); expect(inserted[1]?.bezier).toEqual(keys[0]?.bezier);
    expect(inserted[0]?.curve_range?.[0]).toBe(0.2); expect(inserted[0]?.curve_range?.[1]).toBeCloseTo(97 / 240, 10);
    expect(inserted[1]?.curve_range?.[0]).toBeCloseTo(97 / 240, 10); expect(inserted[1]?.curve_range?.[1]).toBe(0.9);
    for (let frame = 0; frame <= 24; frame += 1) expect(evaluateCurve(inserted, frame, 0)).toBeCloseTo(evaluateCurve(keys, frame, 0), 7);
    const insertedSnapshot = structuredClone(inserted);
    const replaced = upsertCurveKey(inserted, 7, 0.5);
    expect(replaced.find((key) => key.frame === 7)).toEqual({ ...inserted[1], value: 0.5 });
    expect(inserted).toEqual(insertedSnapshot); expect(keys).toEqual(snapshot);
  });
});


describe("linked timing and hidden-animation preservation boundaries", () => {
  it("propagates only the requested speed or hold edge to a linked peer", () => {
    const original = groupedTimeline();
    original.clips = [
      { ...clip("timing-primary", 100), track_id: "video-0", linked_id: "timing-pair", effects: { speed_percent: 100, hold: { start: 5, end: 11 } } },
      { ...clip("timing-peer", 100), track_id: "audio-0", linked_id: "timing-pair", effects: { speed_percent: 125, hold: { start: 3, end: 7 }, volume_db: -6 } },
    ];
    const snapshot = structuredClone(original);
    for (const scenario of [
      { effects: { speed_percent: 200, hold: { start: 5, end: 11 } }, peer: { speed_percent: 200, hold: { start: 3, end: 7 } }, duration: 60 },
      { effects: { speed_percent: 100, hold: { start: 9, end: 11 } }, peer: { speed_percent: 125, hold: { start: 9, end: 7 } }, duration: 96 },
      { effects: { speed_percent: 100, hold: { start: 5, end: 13 } }, peer: { speed_percent: 125, hold: { start: 3, end: 13 } }, duration: 96 },
    ]) {
      const command: EditCommand = { type: "patchClip", clipId: "timing-primary", patch: { effects: scenario.effects } };
      const commandSnapshot = structuredClone(command);
      const result = executeEdit(original, command);
      expect(original).toEqual(snapshot); expect(command).toEqual(commandSnapshot);
      if (!result.ok) throw new Error(result.error);
      const peer = fixtureValue(result.value.clips.find((item) => item.clip_id === "timing-peer"), "editBoundary.test.ts");
      expect(peer.effects).toMatchObject({ ...scenario.peer, volume_db: -6 });
      expectVisibleInterval(peer, 0, scenario.duration, 0, 100);
      expect(result.value.clips.find((item) => item.clip_id === "timing-primary")?.effects).toMatchObject(scenario.effects);
    }
  });

  it("rejects materialization atomically when it would discard hidden motion, effect or mask keys", () => {
    const keys: TimelineKeyframe[] = [{ frame: 0, value: 0.1, interpolation: "bezier", bezier: [0.1, 0.8, 0.9, 0.2], curve_range: [0.2, 0.8] }, { frame: 100, value: 0.8, interpolation: "linear" }];
    for (const channel of ["motion", "effect", "mask"] as const) {
      const original = groupedTimeline();
      original.sources = original.sources.map((source) => ({ ...source, duration_frames: 100 }));
      const hidden: TimelineClip = { ...clip("hidden-primary", 100), track_id: "video-0", linked_id: "hidden-pair", output_window: { start_frame: 20, end_frame: 40 } };
      if (channel === "motion") hidden.motion.keyframes.x = structuredClone(keys);
      else if (channel === "effect") hidden.effect_stack = [{ kind: "color", effect_id: "hidden-color", enabled: true, brightness: 0, contrast: 1, saturation: 1, keyframes: { brightness: structuredClone(keys) } }];
      else hidden.mask = { kind: "rectangle", x: 0, y: 0, width: 0.5, height: 0.5, feather: 0, invert: false, keyframes: { x: structuredClone(keys) } };
      // This first peer is representable; a later failure must not commit its partial update.
      original.clips = [{ ...clip("safe-peer", 100), track_id: "audio-0", linked_id: "hidden-pair", output_window: { start_frame: 20, end_frame: 40 } }, hidden];
      const snapshot = structuredClone(original);
      for (const command of [
        { type: "slip", clipId: hidden.clip_id, delta: 1 },
        { type: "patchClip", clipId: hidden.clip_id, patch: { effects: { speed_percent: 200 } } },
      ] satisfies EditCommand[]) {
        const commandSnapshot = structuredClone(command);
        expect(executeEdit(original, command).ok).toBe(false);
        expect(original).toEqual(snapshot); expect(command).toEqual(commandSnapshot);
      }
    }
  });

  it("keeps hidden animation restorable when a slip fits the complete source range", () => {
    const original = timeline(); original.captions = []; original.markers = [];
    original.sources = original.sources.map((source) => ({ ...source, duration_frames: 200 }));
    const keys: TimelineKeyframe[] = [{ frame: 0, value: 0.1, interpolation: "bezier", bezier: [0.1, 0.8, 0.9, 0.2], curve_range: [0.2, 0.8] }, { frame: 100, value: 0.8, interpolation: "linear" }];
    const before: TimelineClip = { ...clip("preserved-window", 120), in_frame: 20, start_frame: 10, output_window: { start_frame: 20, end_frame: 40 } };
    before.motion.keyframes.x = structuredClone(keys);
    before.effect_stack = [{ kind: "color", effect_id: "preserved-color", enabled: true, brightness: 0, contrast: 1, saturation: 1, keyframes: { brightness: structuredClone(keys) } }];
    before.mask = { kind: "rectangle", x: 0, y: 0, width: 0.5, height: 0.5, feather: 0, invert: false, keyframes: { x: structuredClone(keys) } };
    original.clips = [before]; const snapshot = structuredClone(original);
    for (const delta of [-1, 1]) {
      const slipped = executeEdit(original, { type: "slip", clipId: before.clip_id, delta });
      expect(original).toEqual(snapshot);
      if (!slipped.ok) throw new Error(slipped.error);
      const after = fixtureValue(slipped.value.clips[0], "editBoundary.test.ts");
      expectVisibleInterval(after, 10, 20, 40 + delta, 60 + delta);
      expect(after.output_window).toEqual(before.output_window);
      expect(after.motion).toEqual(before.motion); expect(after.effect_stack).toEqual(before.effect_stack); expect(after.mask).toEqual(before.mask);
      const slippedSnapshot = structuredClone(slipped.value);
      const extended = executeEdit(slipped.value, { type: "trim", clipId: before.clip_id, edge: "out", delta: 60 });
      expect(slipped.value).toEqual(slippedSnapshot);
      if (!extended.ok) throw new Error(extended.error);
      const restored = fixtureValue(extended.value.clips[0], "editBoundary.test.ts");
      const expected = { ...before, output_window: { start_frame: 20, end_frame: 100 } };
      expectVisibleInterval(restored, 10, 80, 40 + delta, 120 + delta);
      for (let frame = 0; frame < 80; frame += 1) expectPreservedSample(restored, frame, expected, frame, delta);
    }
    expect(original).toEqual(snapshot);
  });
});


describe("adjustment layer edit integrity", () => {
  const counting = () => {
    let serial = 0;
    return (prefix: string) => `${prefix}-${String(++serial)}`;
  };
  /** The film of timeline() with a second, free video track on top and an adjustment layer added at frame 10. */
  function adjusted(): { film: StudioTimeline; layer: string } {
    const original = timeline(); original.captions = []; original.markers = [];
    original.tracks.push({ ...fixtureValue(original.tracks[0], "editBoundary.test.ts"), track_id: "video-b", name: "V2" });
    const created = createAdjustmentLayer(original, 10, 64, 32, counting());
    if (!created.ok) throw new Error(created.error);
    return { film: created.value.timeline, layer: created.value.clipId };
  }
  const layerOf = (film: StudioTimeline, id: string) => fixtureValue(film.clips.find((item) => item.clip_id === id), "editBoundary.test.ts");

  it("goes where the Controller's add_adjustment puts it: over everything that plays there, on a new track when needed", () => {
    const vectors = adjustmentVectors.vectors;
    // The editor adds one at the playhead with the defaults: the vectors without a track, a length or a name of their own
    const plain = vectors.filter((vector) => Boolean(vector.after && Object.keys(vector.command).every((key) => key === "op" || key === "at_frame")));
    expect(plain.length).toBeGreaterThanOrEqual(3);
    for (const vector of plain) {
      const before = contractFixture("StudioTimeline", vector.before);
      const snapshot = structuredClone(before);
      const created = createAdjustmentLayer(before, vector.command.at_frame, 768, 448, counting());
      expect(vector.before).toEqual(snapshot);
      expect(created.ok ? created.value.timeline : created.error).toEqual(vector.after);
    }
  });

  it("is trimmed, cut, moved and rippled like any clip and keeps its range from 0", () => {
    const { film, layer } = adjusted();
    expect(layerOf(film, layer)).toMatchObject({ track_id: "video-b", start_frame: 10, in_frame: 0, out_frame: 120 });
    expect(film.sources.find((source) => source.kind === "adjustment")).toMatchObject({ file: null, has_audio: false, width: 64, height: 32, duration_frames: 100000 });
    const snapshot = structuredClone(film);
    const grown = executeEdit(film, { type: "trim", clipId: layer, edge: "in", delta: -10 });
    if (!grown.ok) throw new Error(grown.error);
    expect(layerOf(grown.value, layer)).toMatchObject({ start_frame: 0, in_frame: 0, out_frame: 130 });
    expect(clipEnd(layerOf(grown.value, layer))).toBe(130);
    const cut = executeEdit(film, { type: "split", clipIds: [layer], frame: 50 });
    if (!cut.ok) throw new Error(cut.error);
    const parts = cut.value.clips.filter((item) => item.source_id === layerOf(film, layer).source_id);
    expect(parts.map((part) => [part.start_frame, clipEnd(part), part.in_frame])).toEqual([[10, 50, 0], [50, 130, 0]]);
    const moved = executeEdit(film, { type: "move", clipId: layer, startFrame: 200, trackId: "video-b" });
    if (!moved.ok) throw new Error(moved.error);
    expect(layerOf(moved.value, layer).start_frame).toBe(200);
    const rippled = executeEdit(film, { type: "trim", clipId: layer, edge: "out", delta: -20, ripple: true });
    if (!rippled.ok) throw new Error(rippled.error);
    expect(clipEnd(layerOf(rippled.value, layer))).toBe(110);
    expect(film).toEqual(snapshot);
  });

  it("refuses motion, speed, sound and transitions with why, and takes effects, colour, fades, a mask, opacity and a blend mode", () => {
    const { film, layer } = adjusted();
    const snapshot = structuredClone(film);
    const original = layerOf(film, layer);
    for (const patch of [
      { motion: { ...original.motion, scale: 1.5 } },
      { motion: { ...original.motion, keyframes: { x: [{ frame: 0, value: 0.1, interpolation: "linear" as const }] } } },
      { effects: { speed_percent: 150 } },
      { effects: { hold: { start: 4 } } },
      { effects: { camera: { zoom_percent: 120 } } },
      { effects: { volume_db: -6 } },
    ]) {
      const refused = executeEdit(film, { type: "patchClip", clipId: layer, patch });
      expect(refused.ok ? null : refused.error).toMatch(/^調整圖層/);
      expect(film).toEqual(snapshot);
    }
    // A shot cut right before the layer on its track: no transition into it, none out of it
    const neighbour: TimelineClip = { ...clip("neighbour", 24), track_id: "video-b", start_frame: 130 };
    const lined = { ...film, clips: [...film.clips, { ...clip("before", 10), track_id: "video-b" }, neighbour] };
    for (const command of [
      { type: "transition", clipId: "before", kind: "crossfade", frames: 4 },
      { type: "transition", clipId: layer, kind: "push", frames: 4 },
    ] satisfies EditCommand[]) {
      const refused = executeEdit(lined, command);
      expect(refused.ok ? null : refused.error).toBe(ADJUSTMENT_TRANSITION);
    }
    const look = executeEdit(film, {
      type: "patchClip",
      clipId: layer,
      patch: {
        effect_stack: [{ kind: "glow", effect_id: "glow-a", enabled: true, intensity: 1, radius: 16, threshold: 0.6 }],
        effects: { color: { saturation: 0 }, fade: { video_in: 6, video_out: 6 } },
        mask: { kind: "ellipse", x: 0.1, y: 0.1, width: 0.8, height: 0.8, feather: 0.1, invert: false },
        motion: { ...original.motion, opacity: 0.8, keyframes: { opacity: [{ frame: 0, value: 0, interpolation: "linear" }, { frame: 12, value: 1, interpolation: "linear" }] } },
        blend_mode: "screen",
      },
    });
    expect(look.ok ? null : look.error).toBeNull();
    expect(film).toEqual(snapshot);
  });
});
