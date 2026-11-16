// Data integrity of transitions on their cut. The editor's core runs the Controller's vectors of the transition command
// (contracts/examples/timeline-commands/transition.json), so both make the same document; the edits around a recorded
// cut (delete, trim, rearrange, export) keep what the clips lent the transition and give it back where it ends.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { executeEdit, type EditCommand } from "./commands";
import { exportSnapshot } from "./export";
import { createEditHistory } from "./history";
import { clipEnd, timelineDuration } from "./model";

interface WireTransition {
  op: "transition";
  clip_id: string;
  kind: string;
  frames?: number;
  direction?: string;
  easing?: "linear" | "ease_in" | "ease_out" | "ease_in_out";
  softness?: number;
  alignment?: "center" | "start" | "end";
  linked?: boolean;
}

interface TransitionVector {
  name: string;
  before: StudioTimeline;
  command: WireTransition;
  after?: StudioTimeline;
  reject_reason?: string;
}

function vectors(): TransitionVector[] {
  const path = fileURLToPath(new URL("../../../../../../contracts/examples/timeline-commands/transition.json", import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { vectors: TransitionVector[] }).vectors;
}

/** The editor's command of a wire command (fade_black and fade_white are stored as dips; the default length is 12). */
function editOf(command: WireTransition): EditCommand {
  const kind = command.kind === "fade_black" ? "dip_to_black" : command.kind === "fade_white" ? "dip_to_white" : command.kind;
  const options = { ...(command.direction ? { direction: command.direction } : {}), ...(command.easing ? { easing: command.easing } : {}), ...(command.softness !== undefined ? { softness: command.softness } : {}) };
  return { type: "transition", clipId: command.clip_id, kind: kind as Extract<EditCommand, { type: "transition" }>["kind"], frames: command.frames ?? 12, options, alignment: command.alignment, linked: command.linked !== false };
}

function counting(): (prefix: string) => string {
  let serial = 0;
  return (prefix) => `${prefix}-${++serial}`;
}

function edited(timeline: StudioTimeline, command: EditCommand): StudioTimeline {
  const snapshot = structuredClone(timeline);
  const result = executeEdit(timeline, command, counting());
  expect(timeline).toEqual(snapshot);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function clipOf(timeline: StudioTimeline, id: string): TimelineClip {
  const found = timeline.clips.find((clip) => clip.clip_id === id);
  if (!found) throw new Error(`no clip ${id}`);
  return found;
}

const motion = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, gain_db: 0, pan: 0, keyframes: {} };

/** Three whole takes on V1 with their sound on A1 (linked), a song across everything on A2. */
function film(): StudioTimeline {
  const source = (id: string, frames: number, kind: "video" | "audio" = "video") => ({ source_id: id, name: id, kind, file: null, duration_frames: frames, width: 64, height: 32, has_audio: true });
  const track = (id: string, kind: "video" | "audio", name: string) => ({ track_id: id, kind, name, locked: false, muted: false, solo: false, sync_lock: true, gain_db: 0, pan: 0 });
  const take = (id: string, sourceId: string, start: number): TimelineClip[] => (["video", "audio"] as const).map((kind) => ({
    clip_id: `${kind[0]}${id}`, source_id: sourceId, track_id: `${kind}-1`, name: id, start_frame: start, in_frame: 0, out_frame: 48, linked_id: `l${id}`, motion: structuredClone(motion),
  }));
  return {
    version: 2, fps: { num: 24, den: 1 }, master_gain_db: 0, placed_shot_ids: [],
    sources: [source("take-1", 48), source("take-2", 48), source("take-3", 48), source("song", 2400, "audio")],
    tracks: [track("video-1", "video", "V1"), track("audio-1", "audio", "A1"), track("audio-2", "audio", "A2")],
    clips: [...take("1", "take-1", 0), ...take("2", "take-2", 48), ...take("3", "take-3", 96), { clip_id: "song", source_id: "song", track_id: "audio-2", name: "song", start_frame: 0, in_frame: 0, out_frame: 400, motion: structuredClone(motion) }],
    captions: [{ caption_id: "c1", start_frame: 40, end_frame: 56, text: "Across", position: "bottom", size: "small" }],
    markers: [{ marker_id: "m1", frame: 50, name: "Hit", color: "blue" }],
  };
}

const crossfade = (clipId: string, frames = 12, alignment?: "center" | "start" | "end"): EditCommand => ({ type: "transition", clipId, kind: "crossfade", frames, alignment, linked: true });

describe("the transition command follows the Controller's vectors", () => {
  // A command the wire contract refuses by its shape (cut with an alignment) is the Controller's to check
  it.each(vectors().filter((vector) => vector.reject_reason !== "invalid_command"))("$name", (vector) => {
    const snapshot = structuredClone(vector.before);
    const result = executeEdit(vector.before, editOf(vector.command), counting());
    expect(vector.before).toEqual(snapshot);
    if (vector.after) expect(result.ok ? result.value : result.error).toEqual(vector.after);
    else expect(result.ok).toBe(false);
  });
});

describe("edits around a recorded cut keep the document whole", () => {
  it("applies over a song on a sync-locked track and undoes to the same document", () => {
    const original = film();
    const applied = edited(original, crossfade("v1"));
    expect(clipOf(applied, "song")).toEqual(clipOf(original, "song"));
    expect(applied.captions).toEqual(original.captions);
    expect(applied.markers).toEqual(original.markers);
    expect(timelineDuration(applied)).toBe(timelineDuration(original));
    expect(clipOf(applied, "v1").effects?.hold).toEqual({ end: 6 });
    expect(clipOf(applied, "v2")).toMatchObject({ start_frame: 42, effects: { hold: { start: 6 } } });
    const history = createEditHistory();
    history.record(original, applied);
    expect(history.undo(applied)).toEqual({ ok: true, value: original });
    expect(edited(applied, { type: "transition", clipId: "v1", kind: "cut", frames: 0, linked: true })).toEqual(original);
  });

  it("deleting the incoming clip leaves the outgoing one ending at the cut, and a ripple closes from there", () => {
    const applied = edited(film(), crossfade("v1"));
    const lifted = edited(applied, { type: "delete", clipIds: ["v2"], linked: true });
    expect(clipOf(lifted, "v1")).toEqual(clipOf(film(), "v1"));
    expect(clipOf(lifted, "v3").start_frame).toBe(96);
    const song = { ...film(), clips: film().clips.filter((clip) => clip.clip_id !== "song") };
    const rippled = edited(edited(song, crossfade("v1")), { type: "delete", clipIds: ["v2"], ripple: true, linked: true });
    expect(clipOf(rippled, "v1")).toEqual(clipOf(film(), "v1"));
    expect(clipOf(rippled, "v3").start_frame).toBe(48);
  });

  it("deleting the outgoing clip with a ripple moves the incoming one to its start, back at its in point", () => {
    const song = { ...film(), clips: film().clips.filter((clip) => clip.clip_id !== "song") };
    const rippled = edited(edited(song, crossfade("v1")), { type: "delete", clipIds: ["v1"], ripple: true, linked: true });
    expect(clipOf(rippled, "v2")).toEqual({ ...clipOf(film(), "v2"), start_frame: 0 });
    expect(clipOf(rippled, "v3").start_frame).toBe(48);
  });

  it("a trim moves the cut with the edge that moved; removing the transition then gives back only what is still hidden", () => {
    const applied = edited(film(), crossfade("v1"));
    const trimmed = edited(applied, { type: "trim", clipId: "v1", edge: "out", delta: -2, linked: true });
    const transition = clipOf(trimmed, "v1").effects?.transition_out;
    expect(transition).toMatchObject({ frames: 10, cut: { alignment: "center", outgoing: { frames: 6, freeze: 6 }, incoming: { frames: 4, freeze: 6 } } });
    const removed = edited(trimmed, { type: "transition", clipId: "v1", kind: "cut", frames: 0, linked: true });
    // The trim moved the cut two frames into the frames v2 held before its first one: those two stay shown
    expect(clipOf(removed, "v1")).toEqual({ ...clipOf(film(), "v1"), output_window: { start_frame: 0, end_frame: 46 } });
    expect(clipOf(removed, "v2")).toEqual({ ...clipOf(film(), "v2"), start_frame: 46, effects: { hold: { start: 2 } } });
    expect(clipEnd(clipOf(removed, "v1"))).toBe(clipOf(removed, "v2").start_frame);
    expect(timelineDuration(removed)).toBe(timelineDuration(film()));
  });

  it("a ripple trim moves the cut with both clips", () => {
    const song = { ...film(), clips: film().clips.filter((clip) => clip.clip_id !== "song") };
    const applied = edited(song, crossfade("v2", 8, "start"));
    const rolled = edited(applied, { type: "trim", clipId: "v2", edge: "out", delta: -4, ripple: true, linked: true });
    expect(clipOf(rolled, "v2").effects?.transition_out).toEqual(clipOf(applied, "v2").effects?.transition_out);
    expect(clipOf(rolled, "v3").start_frame).toBe(clipOf(applied, "v3").start_frame - 4);
  });

  it("a rearrange that separates a recorded cut closes up where the cuts are", () => {
    const applied = edited(edited(film(), crossfade("v1")), crossfade("v2"));
    const moved = edited(applied, { type: "rearrange", clipIds: ["v2"], targetId: "v1", side: "before", linked: true });
    expect(clipOf(moved, "v2")).toEqual({ ...clipOf(film(), "v2"), start_frame: 0 });
    expect(clipOf(moved, "v1")).toEqual({ ...clipOf(film(), "v1"), start_frame: 48 });
    expect(clipOf(moved, "v3")).toEqual(clipOf(film(), "v3"));
  });

  it("exports the overlap without the cut", () => {
    const applied = edited(film(), crossfade("v1"));
    const snapshot = exportSnapshot(applied);
    expect(clipOf(snapshot, "v1").effects?.transition_out).toEqual({ kind: "crossfade", frames: 12 });
    expect(clipOf(snapshot, "v1").effects?.hold).toEqual({ end: 6 });
  });
});
