// The final mix audition can be heard before every shot is rendered: an unrendered shot's time stays silent (a gap)
// instead of blocking the request, while a real export still refuses it.
import { describe, expect, it } from "vitest";
import type { StudioTimeline, TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { studioProject } from "@/test/fixtures/studio";
import { NODE_A_ID } from "@/test/ids";
import { sequenceExport } from "./export";

const MOTION = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, gain_db: 0, pan: 0, keyframes: {} };
const TARGET = { node_id: NODE_A_ID, component_id: "concat" };

function source(id: string, rendered: boolean): TimelineSource {
  return {
    source_id: id, name: id, kind: "video", duration_frames: 48, width: 768, height: 448, has_audio: true,
    file: rendered ? { node_id: NODE_A_ID, file_id: "00000000-0000-4000-8000-00000000f001", size_bytes: 1, sha256: "a".repeat(64), media_type: "video/mp4", metadata: {} } : null,
  };
}

function clips(id: string, start: number): TimelineClip[] {
  const base = { source_id: id, name: id, start_frame: start, in_frame: 0, out_frame: 48, linked_id: `link-${id}`, motion: MOTION };
  return [{ ...base, clip_id: `v-${id}`, track_id: "video-1" }, { ...base, clip_id: `a-${id}`, track_id: "audio-1" }];
}

function film(): StudioTimeline {
  return {
    version: 2, fps: { num: 24, den: 1 }, master_gain_db: 0,
    sources: [source("rendered", true), source("pending", false)],
    tracks: [
      { track_id: "video-1", name: "V1", kind: "video", locked: false, muted: false, solo: false, sync_lock: true, gain_db: 0, pan: 0 },
      { track_id: "audio-1", name: "A1", kind: "audio", locked: false, muted: false, solo: false, sync_lock: true, gain_db: 0, pan: 0 },
    ],
    clips: [...clips("rendered", 0), ...clips("pending", 48)], captions: [], markers: [],
  };
}

describe("sequenceExport with unrendered shots", () => {
  const project = studioProject({ timeline: film() });

  it("refuses an export while a shot waits for its render", () => {
    const result = sequenceExport(project, TARGET);
    expect(result.body).toBeNull();
    expect(result.problems).toEqual(["「pending」尚未完成渲染"]);
  });

  it("lets the mix audition leave the unrendered shot silent and says which", () => {
    const result = sequenceExport(project, TARGET, { unrendered: "gap" });
    expect(result.problems).toEqual([]);
    expect(result.body).not.toBeNull();
    expect(result.gaps).toEqual(["pending"]);
    expect(result.timeline?.clips.map((clip) => clip.clip_id)).toEqual(["v-rendered", "a-rendered"]);
    expect(result.totalFrames).toBe(96);
  });

  it("still has nothing to mix when no shot is rendered", () => {
    const none = studioProject({ timeline: { ...film(), sources: [source("rendered", false), source("pending", false)] } });
    expect(sequenceExport(none, TARGET, { unrendered: "gap" }).problems).toEqual(["還沒有任何已渲染的鏡頭可以混音"]);
  });
});
