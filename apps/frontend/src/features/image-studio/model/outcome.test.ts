// 從 run 讀回 take：這張圖的步驟（上游）、成功／失敗／生成中、中間預覽、讀回動作（含自動加入素材庫）與進度文字。
import { describe, expect, it } from "vitest";
import type { WireRun } from "@/api/types";
import type { StudioImageTake } from "../types";
import { catalog, project, qimgComponents, run, RUN_ID, t2iPipeline } from "./imageFixtures";
import { asPreview, takePreview } from "./outcome";
import { planImageRender } from "./plan";
import { deriveImageRoutes } from "./routes";

const routes = deriveImageRoutes([t2iPipeline()], catalog(qimgComponents()));

function batchRun(autoLibrary = false) {
  const doc = project([{ image_shot_id: "s1", batch: 2, seed: 5, seed_mode: "increment" }]);
  const shot = doc.image_shots?.[0];
  if (!shot) throw new Error("fixture");
  const result = planImageRender(doc, shot, ["t0", "t1"], { routes, autoLibrary });
  if (!result.plan) throw new Error(result.problem);
  const takes: StudioImageTake[] = result.plan.branches.map((branch, index) => ({
    take_id: `t${index}`,
    run_id: RUN_ID,
    created_at: "2026-10-18T00:00:00Z",
    state: "rendering",
    seed: branch.seed,
    image: null,
    image_white: null,
    library_item_id: null,
    timings_ms: {},
    error: null,
    params_snapshot: branch.snapshot as unknown as Record<string, unknown>,
  }));
  const withTakes = { ...doc, image_shots: [{ ...shot, takes }] };
  return { doc: withTakes, takes, body: result.plan.body };
}

const done = (outputs: Record<string, unknown> = {}) => ({ state: "succeeded", started_at: "2026-10-18T00:00:01Z", finished_at: "2026-10-18T00:00:03Z", outputs });

describe("中間預覽", () => {
  const preview = (step: number, seq: number, extra: Record<string, unknown> = {}) => ({
    seq,
    step,
    total: 40,
    width: 384,
    height: 384,
    media_type: "image/jpeg",
    size_bytes: 20_000,
    note: "vae_thumbnail",
    at: `2026-10-18T00:00:${String(seq).padStart(2, "0")}Z`,
    url: `/api/runs/${RUN_ID}/steps/dit_1/preview?seq=${seq}`,
    ...extra,
  });

  it("步驟結束（不是 running）或 run 結束就沒有預覽；不完整或不是主控路徑的資料不採用", () => {
    const { takes, body } = batchRun();
    const ended = run(body, { te: done(), dit_1: { state: "succeeded", preview: preview(40, 12) } });
    expect(takes[1] && takePreview(ended, takes[1])).toBeNull();
    const finished = { ...run(body, { te: done(), dit_1: { state: "running", preview: preview(5, 5) } }), state: "succeeded" } as WireRun;
    expect(takes[1] && takePreview(finished, takes[1])).toBeNull();
    expect(asPreview(preview(5, 5, { url: "http://evil.example/x" }))).toBeNull();
    expect(asPreview(preview(5, 5, { total: 0 }))).toBeNull();
    expect(asPreview({ url: "/api/runs/x", step: 1 })).toBeNull();
    expect(asPreview(preview(5, 5, { note: null }))?.note).toBeNull();
  });
});
