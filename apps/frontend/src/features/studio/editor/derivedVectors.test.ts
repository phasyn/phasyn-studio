// The film order of shots, the shot a continuation starts from and the frame it reads are computed in three places:
// the Controller and this editor. Both run the vectors of contracts/examples/timeline-derived,
// so a render never starts from another frame than the film shows.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StudioTake, StudioTimeline } from "@/api/generated/contracts";
import { studioProject, studioShot } from "@/test/fixtures";
import { frameSelection, predecessor } from "../model/continuity";
import { filmOrder } from "./sources";

function vectors<T>(name: string): T[] {
  const path = fileURLToPath(new URL(`../../../../../../contracts/examples/timeline-derived/${name}.json`, import.meta.url));
  const document = JSON.parse(readFileSync(path, "utf8")) as { vectors: T[] };
  return document.vectors;
}

function projectOf(shotIds: readonly string[], timeline: StudioTimeline) {
  return studioProject({ shots: shotIds.map((shot_id) => studioShot({ shot_id })), timeline, format: { width: 64, height: 32, fps: timeline.fps } });
}

interface FilmOrderVector {
  name: string;
  shot_ids: string[];
  timeline: StudioTimeline;
  expected: { placed: string[]; unplaced: string[] };
}

interface PreviousShotVector {
  name: string;
  shot_ids: string[];
  shot_id: string;
  timeline: StudioTimeline;
  expected: { shot_id: string | null; clip_id?: string; last_source_frame?: number; reason?: "first" | "not_placed" };
}

interface ContinuityFrameVector {
  name: string;
  last_source_frame: number;
  fps: StudioTimeline["fps"];
  take: StudioTake | null;
  planned_frames: number;
  expected: number | null;
}

describe("derived timeline facts follow the shared vectors", () => {
  it.each(vectors<FilmOrderVector>("film-order"))("film order: $name", (vector) => {
    const order = filmOrder(projectOf(vector.shot_ids, vector.timeline), vector.timeline);
    expect({ placed: order.placed.map((shot) => shot.shot_id), unplaced: order.unplaced.map((shot) => shot.shot_id) }).toEqual(vector.expected);
  });

  it.each(vectors<PreviousShotVector>("previous-shot"))("previous shot: $name", (vector) => {
    const result = predecessor(projectOf(vector.shot_ids, vector.timeline), vector.shot_id);
    const found = result.previous ? { shot_id: result.previous.shot.shot_id, last_source_frame: result.previous.lastSourceFrame } : { shot_id: null };
    const { clip_id: _clip, reason: _reason, ...expected } = vector.expected;
    expect(found).toEqual(expected);
  });

  it.each(vectors<ContinuityFrameVector>("continuity-frame"))("continuity frame: $name", (vector) => {
    const previous = { shot: studioShot({ shot_id: "previous", frames: vector.planned_frames }), lastSourceFrame: vector.last_source_frame, fps: vector.fps };
    const selection = frameSelection(previous, vector.take);
    expect(selection.position === "index" ? selection.frame_index : null).toBe(vector.expected);
  });
});
