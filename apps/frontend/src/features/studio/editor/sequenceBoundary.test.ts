// Data-integrity boundaries of the edits that keep shots and the timeline one sequence: rearranging a shot's block,
// taking a shot out of the film, and reading the document the Controller answers (the Controller places shots and
// follows their takes; its rules are tested with it). Each edit must leave a valid document, change nothing it was
// not asked to change, and refuse as a whole when it cannot.
import { describe, expect, it } from "vitest";
import type { StudioTimeline, TimelineClip, TimelineSource, TimelineTrack } from "@/api/generated/contracts";
import { studioProject, studioShot } from "@/test/fixtures";
import { NODE_A_ID } from "@/test/ids";
import { projectReducer } from "../model/project";
import { asset, take } from "../model/studioFixtures";
import { executeEdit } from "./commands";
import { createEditHistory } from "./history";
import { clipEnd, trackClips } from "./model";
import { removeShotClips, withoutShot } from "./shotRemoval";
import { filmOrder, projectTimeline, shorterTakes } from "./sources";
import { timelineProblem } from "./validation";

const MOTION = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, gain_db: 0, pan: 0, keyframes: {} };

function track(id: string, kind: TimelineTrack["kind"]): TimelineTrack {
  return { track_id: id, name: id, kind, locked: false, muted: false, solo: false, sync_lock: true, gain_db: 0, pan: 0 };
}

function source(id: string, shotId: string, frames = 100, fileId = "00000000-0000-4000-8000-00000000f001"): TimelineSource {
  return {
    source_id: id,
    name: id,
    kind: "video",
    duration_frames: frames,
    width: 64,
    height: 32,
    has_audio: true,
    shot_id: shotId,
    take_id: `take-${shotId}`,
    file: { node_id: NODE_A_ID, file_id: fileId, size_bytes: 1, sha256: "a".repeat(64), media_type: "video/mp4", metadata: {} },
  };
}

function pair(name: string, sourceId: string, start: number, frames: number): TimelineClip[] {
  const base = { source_id: sourceId, name, start_frame: start, in_frame: 0, out_frame: frames, linked_id: `link-${name}`, motion: MOTION };
  return [
    { ...base, clip_id: `v-${name}`, track_id: "video-1" },
    { ...base, clip_id: `a-${name}`, track_id: "audio-1" },
  ];
}

/** Three shots back to back on V1 with linked sound on A1, a title on V2, a caption and a marker. */
function film(): StudioTimeline {
  return {
    version: 1,
    fps: { num: 24, den: 1 },
    master_gain_db: 0,
    sources: [source("src-1", "shot-1"), source("src-2", "shot-2"), source("src-3", "shot-3")],
    tracks: [track("video-1", "video"), track("video-2", "video"), track("audio-1", "audio")],
    clips: [...pair("one", "src-1", 0, 40), ...pair("two", "src-2", 40, 30), ...pair("three", "src-3", 70, 50), { clip_id: "overlay", source_id: "src-3", track_id: "video-2", name: "overlay", start_frame: 10, in_frame: 0, out_frame: 20, motion: MOTION }],
    captions: [{ caption_id: "caption", start_frame: 45, end_frame: 60, text: "caption", position: "bottom", size: "small" }],
    markers: [{ marker_id: "marker", frame: 70, name: "marker", color: "blue" }],
  };
}

const starts = (timeline: StudioTimeline, trackId: string) => trackClips(timeline, trackId).map((clip) => [clip.clip_id, clip.start_frame, clipEnd(clip)]);

describe("rearrange keeps every clip, its media range and the other tracks", () => {
  it("moves a shot's block in front of another without overwriting or touching unrelated tracks", () => {
    const before = film();
    const result = executeEdit(before, { type: "rearrange", clipIds: ["v-three"], targetId: "v-one", side: "before", linked: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(timelineProblem(result.value)).toBeNull();
    expect(starts(result.value, "video-1")).toEqual([["v-three", 0, 50], ["v-one", 50, 90], ["v-two", 90, 120]]);
    expect(starts(result.value, "audio-1")).toEqual([["a-three", 0, 50], ["a-one", 50, 90], ["a-two", 90, 120]]);
    expect(starts(result.value, "video-2")).toEqual(starts(before, "video-2"));
    expect(result.value.captions).toEqual(before.captions);
    expect(result.value.markers).toEqual(before.markers);
    const ranges = (timeline: StudioTimeline) => Object.fromEntries(timeline.clips.map((clip) => [clip.clip_id, [clip.source_id, clip.in_frame, clip.out_frame]]));
    expect(ranges(result.value)).toEqual(ranges(before));
  });

  it("refuses as a whole, leaving the document untouched, when linked clips would come apart", () => {
    const before = film();
    // The sound of shot three sits one frame later than its picture: the pair cannot stay aligned through a re-flow
    before.clips = before.clips.map((clip) => (clip.clip_id === "a-three" ? { ...clip, start_frame: 71, out_frame: 49 } : clip));
    const snapshot = structuredClone(before);
    const result = executeEdit(before, { type: "rearrange", clipIds: ["v-three"], targetId: "v-one", side: "before", linked: true });
    expect(result.ok).toBe(false);
    expect(before).toEqual(snapshot);
  });
});

describe("taking a shot out of the film", () => {
  it("removes its clips with their linked partners, closes the gap and drops only its sources", () => {
    const before = film();
    const result = withoutShot(before, "shot-2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(timelineProblem(result.value)).toBeNull();
    expect(result.value.sources.map((item) => item.source_id)).toEqual(["src-1", "src-3"]);
    expect(result.value.clips.some((clip) => clip.source_id === "src-2")).toBe(false);
    expect(starts(result.value, "video-1")).toEqual([["v-one", 0, 40], ["v-three", 40, 90]]);
    expect(starts(result.value, "audio-1")).toEqual([["a-one", 0, 40], ["a-three", 40, 90]]);
  });

  it("lifts the clips and leaves a gap when a sync-locked clip spans the place", () => {
    const before = film();
    // The overlay on the sync-locked V2 now runs from frame 30 to 60, across the cut at 40 where shot two starts
    before.clips = before.clips.map((clip) => (clip.clip_id === "overlay" ? { ...clip, start_frame: 30, out_frame: 30 } : clip));
    const result = removeShotClips(before, "shot-2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rippled).toBe(false);
    expect(timelineProblem(result.value.timeline)).toBeNull();
    expect(starts(result.value.timeline, "video-1")).toEqual([["v-one", 0, 40], ["v-three", 70, 120]]);
    expect(starts(result.value.timeline, "video-2")).toEqual(starts(before, "video-2"));
  });

  it("reports a locked track instead of removing half of a shot", () => {
    const before = film();
    before.tracks = before.tracks.map((item) => (item.track_id === "audio-1" ? { ...item, locked: true } : item));
    const snapshot = structuredClone(before);
    expect(withoutShot(before, "shot-2").ok).toBe(false);
    expect(before).toEqual(snapshot);
  });

  it("removes the shot and its clips in one project change", () => {
    const shots = ["shot-1", "shot-2", "shot-3"].map((shot_id) => studioShot({ shot_id, title: shot_id }));
    const project = studioProject({ shots, timeline: film() });
    const next = projectReducer(project, { type: "removeShot", shotId: "shot-2" });
    expect(next.shots.map((shot) => shot.shot_id)).toEqual(["shot-1", "shot-3"]);
    expect(next.timeline?.clips.some((clip) => clip.source_id === "src-2")).toBe(false);
    expect(filmOrder(next, next.timeline ?? film()).placed.map((shot) => shot.shot_id)).toEqual(["shot-1", "shot-3"]);
  });
});

describe("the editor reads the timeline the Controller answers and keeps its edits apart from the Controller's facts", () => {
  const format = { width: 64, height: 32, fps: { num: 24, den: 1 } };

  it("uses the saved document as it is, and an empty one for a project that has none yet", () => {
    const saved = film();
    const withTimeline = studioProject({ shots: [studioShot({ shot_id: "shot-1" })], timeline: saved, format });
    const result = projectTimeline(withTimeline);
    expect(result.ok && result.value).toBe(saved);
    expect(projectTimeline(withTimeline)).toBe(result);
    const none = projectTimeline(studioProject({ format }));
    expect(none.ok && [none.value.version, none.value.clips.length, none.value.tracks.map((item) => item.kind)]).toEqual([2, 0, ["video", "video", "audio", "audio"]]);
  });

  it("reports the take the Controller keeps waiting for a source, with its length on the timeline", () => {
    const waiting = take({ take_id: "take-new", frames: 30, asset: asset(30, 64, 32, "00000000-0000-4000-8000-00000000f002") });
    const timeline = film();
    const pending = { ...timeline, sources: timeline.sources.map((item) => (item.source_id === "src-1" ? { ...item, pending_take_id: "take-new" } : item)) };
    const shots = [studioShot({ shot_id: "shot-1", takes: [take({ take_id: "take-shot-1" }), waiting], active_take_id: "take-new" }), studioShot({ shot_id: "shot-2" }), studioShot({ shot_id: "shot-3" })];
    const project = studioProject({ shots, timeline: pending, format });
    expect(shorterTakes(project, pending)).toEqual([{ sourceId: "src-1", shotId: "shot-1", takeId: "take-new", durationFrames: 30 }]);
    expect(shorterTakes(project, timeline)).toEqual([]);
  });

  it("brings an undone step back with the binding it had and the Controller's current bookkeeping", () => {
    const before: StudioTimeline = { ...film(), placed_shot_ids: ["shot-1", "shot-2"] };
    const renamed = executeEdit(before, { type: "patchClip", clipId: "v-two", patch: { name: "renamed" } });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    const history = createEditHistory();
    history.record(before, renamed.value);
    // Since then the Controller bound shot one to another take (other media, other length) and placed shot three
    const live: StudioTimeline = {
      ...renamed.value,
      placed_shot_ids: ["shot-1", "shot-2", "shot-3"],
      migration_notes: ["note"],
      sources: renamed.value.sources.map((item) => (item.source_id === "src-1" && item.file ? { ...item, take_id: "take-new", duration_frames: 124, file: { ...item.file, sha256: "b".repeat(64) } } : item)),
    };
    history.reconcile(live, false);
    const undone = history.undo(live);
    expect(undone?.ok).toBe(true);
    if (!undone?.ok) return;
    expect(timelineProblem(undone.value)).toBeNull();
    expect(undone.value.clips).toEqual(before.clips);
    expect(undone.value.sources).toEqual(before.sources);
    expect([undone.value.placed_shot_ids, undone.value.migration_notes]).toEqual([["shot-1", "shot-2", "shot-3"], ["note"]]);
  });
});
