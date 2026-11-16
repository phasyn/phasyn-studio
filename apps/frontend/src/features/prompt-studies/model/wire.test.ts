// 與 qimg 元件、主控研究文件相接的純函式：元件呼叫的 run 組法（範例元件組合的接線）、生成 run 的參數覆寫、結果與伺服器文件的解讀、套用到 Image Studio。
import { describe, expect, it } from "vitest";
import type { WireRun } from "@/api/types";
import { normalizeDeletionPlan } from "./normalize";
import { renderedImages, runPreview } from "./ops";
import { FILE, fileRef } from "./testFixtures";

describe("結果解讀", () => {
  const run = (outputs: Record<string, unknown>, steps: Record<string, unknown> = {}): WireRun => ({
    run_id: "r",
    state: "succeeded",
    request: { pipeline: { pipeline_id: "p", label: "", inputs: [], steps: [], outputs: {} }, inputs: {} },
    created_at: "",
    finished_at: "",
    steps,
    outputs,
    recording_ids: [],
    error: null,
  });
  const typed = (type_id: string, value: unknown) => ({ type_id, value });

  it("生成結果取白底版與透明版的 ImageAsset；預覽只取站內網址", () => {
    const asset = { asset_id: "a", file: fileRef("white"), width: 1024, height: 1024 };
    const images = renderedImages(run({ image_white: typed("image.asset.v1", asset), image: typed("image.asset.v1", { ...asset, file: fileRef("rgba") }) }));
    expect(images.white?.file.file_id).toBe("white");
    expect(images.rgba?.file.file_id).toBe("rgba");
    expect(renderedImages(run({ image: { type_id: "media.image.v1", file: fileRef("plain") } })).rgba).toEqual({ file: fileRef("plain"), asset: null });
    expect(runPreview(run({}, { dit: { preview: { url: "/api/runs/r/preview", step: 3, total: 40 } } }))).toMatchObject({ stepId: "dit", step: 3, total: 40 });
    expect(runPreview(run({}, { dit: { preview: { url: "https://elsewhere/x" } } }))).toBeNull();
    expect(runPreview(run({}, { dit: { preview: { url: "//elsewhere/x.png" } } }))).toBeNull(); // another host, not a path
  });
});

describe("伺服器文件的解讀", () => {

  it("刪除範圍：缺 counts 或來源時為 null；未知的 action／status 用保守值", () => {
    expect(normalizeDeletionPlan({}, "s", "all")).toBeNull();
    const plan = normalizeDeletionPlan({ counts: {}, source: { file: FILE, action: "delete" }, runs: [{ run_id: "r1", action: "bogus", status: "bogus" }], can_delete: true }, "s", "all");
    expect(plan).toMatchObject({ study_id: "s", mode: "all", dry_run: true, can_delete: true, counts: { versions: 0 }, source: { action: "delete", status: "kept" } });
    expect(plan?.runs[0]).toMatchObject({ action: "keep", status: "planned", role: "unknown" });
  });
});
