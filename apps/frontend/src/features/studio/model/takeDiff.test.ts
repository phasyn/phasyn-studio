// A take's length compared at its own frame rate: 補幀 2× doubles the frames and the rate, so its take is as long as
// the take it came from and the take strip must not tag it 「時長」 (10.3 秒 against 5.17 秒).
import { describe, expect, it } from "vitest";
import type { StudioTake } from "@/api/generated/contracts";
import { takeDifferences } from "./takeDiff";

function take(id: string, frames: number, fps: number | null): StudioTake {
  return {
    take_id: id,
    run_id: `run-${id}`,
    output_key: "final",
    created_at: "2026-11-21T10:00:00.000Z",
    state: "succeeded",
    prompt: "A girl on a café terrace.",
    seed: 7,
    frames,
    width: 768,
    height: 448,
    route: "ref2va-local",
    steps: null,
    asset: fps === null ? null : {
      asset_id: `asset-${id}`,
      kind: "final",
      file: { node_id: "node", file_id: `file-${id}`, media_type: "video/mp4", size_bytes: 1, sha256: "0".repeat(64), metadata: {} },
      source_latent: null,
      frame_count: frames,
      fps: { num: fps, den: 1 },
      width: 768,
      height: 448,
      complete: true,
      actual_settings: {},
    },
    video_latent: null,
    error: null,
    timings_ms: {},
  };
}

const lengthTags = (a: StudioTake, b: StudioTake) => takeDifferences(a, b, { fps: 24 }).filter((item) => item.key === "frames");

describe("takeDifferences length", () => {
  it("treats twice the frames at twice the rate as the same length", () => {
    expect(lengthTags(take("b", 248, 48), take("a", 124, 24))).toEqual([]);
  });

  it("still tags a take that is really longer", () => {
    const tags = lengthTags(take("b", 248, 24), take("a", 124, 24));
    expect(tags).toHaveLength(1);
    expect(tags[0]?.detail).toContain("10.3");
  });

  it("reads a take without a video at the project rate", () => {
    expect(lengthTags(take("b", 124, null), take("a", 124, 24))).toEqual([]);
  });
});
