import { isListed } from "@/lib/json";
// The film order of shots, the shot a continuation starts from and the frame it reads are computed in three places:
// the Controller and this editor. Both run the vectors of contracts/examples/timeline-derived,
// so a render never starts from another frame than the film shows.
import filmVectors from "@contracts/examples/timeline-derived/film-order.json";
import previousVectors from "@contracts/examples/timeline-derived/previous-shot.json";
import frameVectors from "@contracts/examples/timeline-derived/continuity-frame.json";
import { describe, expect, it } from "vitest";
import type { StudioTimeline } from "@/api/generated/contracts";
import { studioProject, studioShot, studioTake, mediaAsset, contractFixture } from "@/test/fixtures";
import { frameSelection, predecessor } from "../model/continuity";
import { filmOrder } from "./sources";

function projectOf(shotIds: readonly string[], timeline: StudioTimeline) {
  return studioProject({ shots: shotIds.map((shot_id) => studioShot({ shot_id })), timeline, format: { width: 64, height: 32, fps: timeline.fps } });
}

describe("derived timeline facts follow the shared vectors", () => {
  it.each(filmVectors.vectors)("film order: $name", (vector) => {
    const timeline = contractFixture("StudioTimeline", vector.timeline);
    const order = filmOrder(projectOf(vector.shot_ids, timeline), timeline);
    expect({ placed: order.placed.map((shot) => shot.shot_id), unplaced: order.unplaced.map((shot) => shot.shot_id) }).toEqual(vector.expected);
  });

  it.each(previousVectors.vectors)("previous shot: $name", (vector) => {
    const result = predecessor(projectOf(vector.shot_ids, contractFixture("StudioTimeline", vector.timeline)), vector.shot_id);
    const found = result.previous ? { shot_id: result.previous.shot.shot_id, last_source_frame: result.previous.lastSourceFrame } : { shot_id: null };
    const expected = vector.expected;
    expect(found).toEqual("last_source_frame" in expected ? { shot_id: expected.shot_id, last_source_frame: expected.last_source_frame } : { shot_id: expected.shot_id });
  });

  it.each(frameVectors.vectors)("continuity frame: $name", (vector) => {
    const previous = { shot: studioShot({ shot_id: "previous", frames: vector.planned_frames }), lastSourceFrame: vector.last_source_frame, fps: vector.fps };
    const raw = vector.take;
    const take = raw && (() => {
      const state = raw.state;
      if (!isListed(state, ["succeeded", "failed"] as const)) throw new Error("Unexpected continuity fixture take status");
      return studioTake({ state, frames: raw.frames, asset: raw.asset ? mediaAsset(raw.asset) : null });
    })();
    const selection = frameSelection(previous, take);
    expect(selection.position === "index" ? selection.frame_index : null).toBe(vector.expected);
  });
});
