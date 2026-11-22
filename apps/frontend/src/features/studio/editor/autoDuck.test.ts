import { fixtureValue } from "@/test/fixtures";
// Auto-duck (baked keys): the trigger track's switched-on clips become merged ranges; each lowered clip gets gain_db
// keys base -> base+amount -> base around every range that touches it (inside its own processed timebase), its earlier
// gain_db keys are replaced, other channels are untouched, and every refusal leaves the document as it was.
import { describe, expect, it } from "vitest";
import type { StudioTimeline, TimelineClip, TimelineTrack } from "@/api/generated/contracts";
import { NODE_A_ID } from "@/test/ids";
import { duckKeys, duckTrack, GAIN_DB_MIN, secondsToFrames, triggerRanges } from "./autoDuck";
import { executeEdit } from "./commands";
import { commandLabel } from "./historyLabels";
import { timelineProblem } from "./validation";

const MOTION = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, gain_db: 0, pan: 0, keyframes: {} };
const SETTINGS = { amountDb: -10, attackFrames: 4, releaseFrames: 8 };

function track(id: string, kind: TimelineTrack["kind"], extra: Partial<TimelineTrack> = {}): TimelineTrack {
  return { track_id: id, name: id, kind, locked: false, muted: false, solo: false, sync_lock: true, gain_db: 0, pan: 0, ...extra };
}

function clip(id: string, trackId: string, start: number, frames: number, extra: Partial<TimelineClip> = {}): TimelineClip {
  return { clip_id: id, source_id: "src-a", track_id: trackId, name: id, start_frame: start, in_frame: 0, out_frame: frames, motion: structuredClone(MOTION), ...extra };
}

/** Music on A2 (0-200), two voice lines on A1 (40-60 and 100-130), a switched-off line (150-160). */
function film(extra: TimelineClip[] = []): StudioTimeline {
  return {
    version: 2,
    fps: { num: 24, den: 1 },
    master_gain_db: 0,
    sources: [{
      source_id: "src-a", name: "Synthetic source", kind: "video", duration_frames: 1000, width: 64, height: 36, has_audio: true,
      file: { node_id: NODE_A_ID, file_id: "00000000-0000-4000-8000-00000000f001", size_bytes: 1, sha256: "a".repeat(64), media_type: "video/mp4", metadata: {} },
    }],
    tracks: [track("audio-1", "audio"), track("audio-2", "audio"), track("video-1", "video")],
    clips: [
      clip("music", "audio-2", 0, 200),
      clip("line-1", "audio-1", 40, 20),
      clip("line-2", "audio-1", 100, 30),
      clip("line-off", "audio-1", 150, 10, { enabled: false }),
      ...extra,
    ],
    captions: [],
    markers: [],
  };
}

const DUCK = { type: "duck" as const, trackId: "audio-2", triggerTrackId: "audio-1", ...SETTINGS };

describe("trigger ranges", () => {
  it("lists the switched-on trigger clips and merges ranges closer than attack plus release", () => {
    expect(triggerRanges(film(), "audio-1", SETTINGS)).toEqual([[40, 60], [100, 130]]);
    const close = film([clip("line-3", "audio-1", 66, 10)]); // 66 - 60 = 6 <= 4 + 8: merged into the first range
    expect(triggerRanges(close, "audio-1", SETTINGS)).toEqual([[40, 76], [100, 130]]);
  });
});

describe("duck keys", () => {
  it("ramps down before each range, holds, and ramps back after it, pinned at the clip edges", () => {
    const keys = duckKeys(fixtureValue(film().clips[0], "autoDuck.test.ts"), [[40, 60]], SETTINGS);
    expect(keys.map((key) => [key.frame, key.value])).toEqual([[0, 0], [36, 0], [40, -10], [60, -10], [68, 0], [200, 0]]);
    expect(keys.every((key) => key.interpolation === "linear")).toBe(true);
  });

  it("keeps the lowered level when a range began before the clip", () => {
    const late = clip("late", "audio-2", 50, 40); // starts inside the 40-60 range
    const keys = duckKeys(late, [[40, 60]], SETTINGS);
    expect(keys[0]).toMatchObject({ frame: 0, value: -10 });
    expect(keys.map((key) => key.frame)).toEqual([0, 10, 18, 40]);
  });

  it("clamps at the gain floor", () => {
    const quiet = clip("quiet", "audio-2", 0, 100, { motion: { ...structuredClone(MOTION), gain_db: -55 } });
    const keys = duckKeys(quiet, [[40, 60]], SETTINGS);
    expect(Math.min(...keys.map((key) => key.value))).toBe(GAIN_DB_MIN);
  });

  it("returns no keys for a clip no range reaches", () => {
    expect(duckKeys(clip("far", "audio-2", 300, 20), [[40, 60]], SETTINGS)).toEqual([]);
  });
});

describe("duck command", () => {
  it("writes valid gain_db keys on the lowered track only, replacing earlier ones, and keeps other channels", () => {
    const before = film();
    fixtureValue(before.clips[0], "autoDuck.test.ts").motion.keyframes = { gain_db: [{ frame: 5, value: -3, interpolation: "hold" }], opacity: [{ frame: 0, value: 1, interpolation: "linear" }] };
    const result = executeEdit(before, DUCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(timelineProblem(result.value)).toBeNull();
    const music = fixtureValue(result.value.clips.find((item) => item.clip_id === "music"), "autoDuck.test.ts");
    expect(music.motion.keyframes.gain_db?.map((key) => key.frame)).toEqual([0, 36, 40, 60, 68, 96, 100, 130, 138, 200]);
    expect(music.motion.keyframes.opacity).toEqual(fixtureValue(before.clips[0], "autoDuck.test.ts").motion.keyframes.opacity);
    // The trigger clips and the original document are unchanged
    expect(result.value.clips.filter((item) => item.track_id === "audio-1")).toEqual(before.clips.filter((item) => item.track_id === "audio-1"));
    expect(fixtureValue(before.clips[0], "autoDuck.test.ts").motion.keyframes.gain_db).toHaveLength(1);
  });

  it("refuses a locked or video target, the same track as trigger, an empty trigger and an out-of-range amount", () => {
    const locked = film();
    locked.tracks[1] = track("audio-2", "audio", { locked: true });
    for (const [timeline, command] of [
      [locked, DUCK],
      [film(), { ...DUCK, trackId: "video-1" }],
      [film(), { ...DUCK, triggerTrackId: "audio-2" }],
      [film(), { ...DUCK, triggerTrackId: "video-1" }],
      [film(), { ...DUCK, amountDb: 3 }],
      [film(), { ...DUCK, attackFrames: 0 }],
    ] as const) {
      const snapshot = structuredClone(timeline);
      const result = executeEdit(timeline, command);
      expect(result.ok).toBe(false);
      expect(timeline).toEqual(snapshot);
    }
  });

  it("refuses when a clip would need more than 128 gain keys", () => {
    const busy = film(Array.from({ length: 40 }, (_, index) => clip(`blip-${String(index)}`, "video-1", index * 5, 1)));
    const outcome = duckTrack(busy, "audio-2", "video-1", { amountDb: -10, attackFrames: 1, releaseFrames: 1 });
    expect(outcome).toEqual({ ok: false, reason: "too-many-keys" });
  });

  it("has a history label and converts seconds to whole frames, at least one", () => {
    expect(commandLabel(DUCK)).toBeTruthy();
    expect(secondsToFrames(0.2, 24)).toBe(5);
    expect(secondsToFrames(0, 24)).toBe(1);
  });
});
