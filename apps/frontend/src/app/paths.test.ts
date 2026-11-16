import { describe, expect, it } from "vitest";
import { comparisonPath, componentPath, imageStudioPath, inferencePath, PATHS, recordingPath, runPath, videoStudioPath } from "./paths";

describe("link builders", () => {
  it("encode ids and keep the query formats links rely on", () => {
    expect(runPath("a/b")).toBe("/records/runs/a%2Fb");
    expect(recordingPath("r1", "?tab=parts")).toBe("/records/recordings/r1?tab=parts");
    expect(componentPath("node-a", "te:gpu0")).toBe("/admin/components?node=node-a&component=te%3Agpu0");
    expect(comparisonPath(["a", "b c"])).toBe("/records/comparisons?ids=a,b%20c");
    expect(comparisonPath([])).toBe(PATHS.comparisons);
    expect(inferencePath({ pipeline: "t2va-local", run: null })).toBe("/inference/run?pipeline=t2va-local");
    expect(inferencePath()).toBe(PATHS.inferenceRun);
    expect(videoStudioPath("render", "p 1")).toBe("/studio/render?project=p+1");
    expect(imageStudioPath()).toBe(PATHS.image);
    expect(imageStudioPath("p 1", "i 2")).toBe("/image?project=p+1&shot=i+2");
  });
});
