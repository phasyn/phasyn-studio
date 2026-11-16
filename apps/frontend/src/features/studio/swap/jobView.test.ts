import { describe, expect, it } from "vitest";
import type { StudioShot } from "@/api/generated/contracts";
import { newProject, newShot } from "../model/project";
import { take } from "../model/studioFixtures";
import type { SegmentView, SwapProgress } from "./job";
import { cancelScope } from "./jobView";

const EMPTY_COUNTS: SwapProgress["counts"] = { pending: 0, rendering: 0, done: 0, stale: 0, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 };

function segment(shot: StudioShot, index: number, state: SegmentView["state"]): SegmentView {
  return { shot, index, status: state === "done" ? "ready" : state === "rendering" ? "rendering" : "empty", state, latest: shot.takes.at(-1) ?? null, error: null };
}

function progressOf(patch: Partial<SwapProgress>): SwapProgress {
  return { segments: [], counts: EMPTY_COUNTS, playable: 0, activeRunIds: [], remaining: [], latestExport: null, exportCurrent: false, exportProblem: null, phase: "pending", ...patch };
}

describe("下一批與取消範圍", () => {

  it("取消前說明：這個 run 還沒完成的段數、已完成會保留", () => {
    const project = newProject("p");
    const runId = "00000000-0000-4000-8000-0000000000aa";
    const done = { ...newShot(project), takes: [take({ run_id: runId, output_key: "final_0", state: "succeeded" })] };
    const rendering = [1, 2].map((n) => ({ ...newShot(project), takes: [take({ run_id: runId, output_key: `final_${n}`, state: "rendering", asset: null })] }));
    const other = { ...newShot(project), takes: [take({ run_id: "other", state: "rendering", asset: null })] };
    const progress = progressOf({
      segments: [segment(done, 0, "done"), ...rendering.map((shot, index) => segment(shot, index + 1, "rendering")), segment(other, 3, "rendering")],
      playable: 1,
    });
    const scope = cancelScope(progress, runId);
    expect(scope).toMatchObject({ inRun: 2, finished: 1 });
    expect(scope.text).toContain("還沒完成的 2 段會停止");
    expect(scope.text).toContain("已完成的 1 段保留");
  });
});
