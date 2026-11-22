// The work list's rows: titles without the project prefix every Studio run carries, and the one 「進行中」 count that the
// list tab, the status bar and the Render tab's badge share.
import { describe, expect, it } from "vitest";
import { pipeline, run } from "@/test/fixtures/pipeline";
import { activeWorkCount, runTitle, workItems } from "./workItems";

const graph = pipeline("transcribe-local", []);

describe("runTitle", () => {
  it("drops the 「Studio: <project> · 」 prefix of a render", () => {
    expect(runTitle(run(graph, { label: "Studio: 測試｜A · 鏡頭一" }), "測試｜A")).toBe("鏡頭一");
  });

  it("drops the 「<project>・」 prefix of transcription and voice lines", () => {
    expect(runTitle(run(graph, { label: "測試｜N6-N13 前端驗收・辨識台詞・鏡頭一・00:00:00:00" }), "測試｜N6-N13 前端驗收")).toBe("辨識台詞・鏡頭一・00:00:00:00");
    expect(runTitle(run(graph, { label: "Demo · Transcribe · Shot 1" }), "Demo")).toBe("Transcribe · Shot 1");
  });

  it("keeps a label that only starts like the project title", () => {
    expect(runTitle(run(graph, { label: "專案 AB・辨識台詞" }), "專案 A")).toBe("專案 AB・辨識台詞");
    expect(runTitle(run(graph, { label: "專案 A・" }), "專案 A")).toBe("專案 A・");
    expect(runTitle(run(graph, { label: "辨識台詞" }), "")).toBe("辨識台詞");
  });
});

describe("activeWorkCount", () => {
  it("counts the project's running jobs only, not finished ones or the lab tools that name the project", () => {
    const transcribe = run(graph, { run_id: "r-transcribe", state: "running", label: "P・辨識台詞・鏡頭一", inputs: {} });
    const withNote = { ...transcribe, request: { ...transcribe.request, origin: { note: JSON.stringify({ kind: "transcribe" }) } } };
    const tool = run(graph, { run_id: "r-tool", state: "running", label: "lab tool" });
    const done = { ...withNote, run_id: "r-done", state: "succeeded" as const };
    const items = workItems([], [withNote, tool, done], "P");
    expect(items.map((item) => [item.runId, item.studio, item.state])).toEqual([
      ["r-transcribe", true, "rendering"],
      ["r-tool", false, "rendering"],
      ["r-done", true, "succeeded"],
    ]);
    expect(activeWorkCount(items)).toBe(1);
  });
});

describe("video checks", () => {
  it("lists a 「檢查影片」 run with the project's work under 影片檢查, not under 其他工具", () => {
    const check = run(pipeline("prepare-control-and-review-local", []), { run_id: "r-check", label: "影片檢查 · 鏡頭二 · Take 1" });
    const noted = { ...check, request: { ...check.request, origin: { note: JSON.stringify({ project_id: "P", shot_id: "s2", take_id: "t1", asset_id: "a1" }) } } };
    const [item] = workItems([], [noted], "P");
    expect(item).toMatchObject({ kind: "check", kindLabel: "影片檢查", studio: true });
  });
});
