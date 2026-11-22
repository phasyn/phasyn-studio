// The project list and the open project's status bar count the film the same way: a shot whose take no longer matches
// its settings is 需更新 in both, and shots left off the timeline are not counted.
import { describe, expect, it } from "vitest";
import type { StudioTimeline, TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { studioProject, studioShot, studioTake } from "@/test/fixtures/studio";
import { NODE_A_ID } from "@/test/ids";
import { filmProgress } from "./filmProgress";

const MOTION = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, gain_db: 0, pan: 0, keyframes: {} };

function source(shotId: string): TimelineSource {
  return {
    source_id: `src-${shotId}`, name: shotId, kind: "video", duration_frames: 124, width: 768, height: 448, has_audio: true, shot_id: shotId, take_id: `take-${shotId}`,
    file: { node_id: NODE_A_ID, file_id: "00000000-0000-4000-8000-00000000f001", size_bytes: 1, sha256: "a".repeat(64), media_type: "video/mp4", metadata: {} },
  };
}

function clip(shotId: string, start: number): TimelineClip {
  return { clip_id: `v-${shotId}`, source_id: `src-${shotId}`, track_id: "video-1", name: shotId, start_frame: start, in_frame: 0, out_frame: 124, motion: MOTION };
}

function timeline(placed: readonly string[]): StudioTimeline {
  return {
    version: 1, fps: { num: 24, den: 1 }, master_gain_db: 0,
    sources: placed.map(source),
    tracks: [{ track_id: "video-1", name: "V1", kind: "video", locked: false, muted: false, solo: false, sync_lock: true, gain_db: 0, pan: 0 }],
    clips: placed.map((id, index) => clip(id, index * 124)), captions: [], markers: [],
  };
}

describe("filmProgress", () => {
  const take = (id: string) => studioTake({ take_id: `take-${id}`, prompt: "a paper boat on a rainy street", seed: 42 });
  const ready = studioShot({ shot_id: "ready", takes: [take("ready")], active_take_id: "take-ready" });
  const changed = studioShot({ shot_id: "changed", prompt: "a new prompt", takes: [take("changed")], active_take_id: "take-changed" });
  const empty = studioShot({ shot_id: "empty" });
  const offFilm = studioShot({ shot_id: "off", takes: [take("off")], active_take_id: "take-off" });

  it("counts ready and 需更新 shots of the film, not shots off the timeline", () => {
    const project = studioProject({ shots: [ready, changed, empty, offFilm], timeline: timeline(["ready", "changed", "empty"]) });
    expect(filmProgress(project)).toEqual({ ready: 1, total: 3, stale: 1 });
  });

  it("follows the live timeline when one is given (the editor's unsaved state)", () => {
    const project = studioProject({ shots: [ready, changed, empty, offFilm], timeline: timeline(["ready"]) });
    expect(filmProgress(project, timeline(["ready", "changed", "off"]))).toEqual({ ready: 2, total: 3, stale: 1 });
  });
});
