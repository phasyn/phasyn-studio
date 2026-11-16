// Weight download summaries: totals count a file shared by two sets once, linkable
// files are not downloaded, partial files only count what is left, files of another size are downloaded only when
// replacing; the reasons a download cannot start are checked in order. The data is synthetic.
import { describe, expect, it } from "vitest";
import type { WeightFileStatus, WeightSetStatus, WeightsView } from "@/api/generated/contracts";
import { downloadBlockedReason, weightsTotals } from "./weightsModel";

function file(path: string, size: number, status: WeightFileStatus["status"], extra: Partial<WeightFileStatus> = {}): WeightFileStatus {
  return { path, size, status, partial_bytes: null, link_from: null, ...extra };
}

function set(setId: string, files: WeightFileStatus[], dest = "repo"): WeightSetStatus {
  return {
    set_id: setId,
    label: setId,
    repo: "org/model",
    revision: "a".repeat(40),
    license: { name: "License", url: "https://example.test", note: null },
    dest,
    files_total: files.length,
    bytes_total: 0,
    files_present: 0,
    bytes_present: 0,
    files_missing: 0,
    bytes_missing: 0,
    files_mismatch: 0,
    bytes_mismatch: 0,
    files_linkable: 0,
    bytes_linkable: 0,
    bytes_partial: 0,
    files,
  };
}

function view(sets: WeightSetStatus[], patch: Partial<WeightsView> = {}): WeightsView {
  return {
    component_id: "dit",
    root: "/models",
    root_exists: true,
    sets,
    notes: [],
    free_bytes: 10_000,
    source: { endpoint: "https://huggingface.co", token: false },
    job: null,
    ...patch,
  };
}

const MIXED = view([
  set("a", [file("LICENSE", 10, "present"), file("A/model.bin", 1000, "missing"), file("A/shared.bin", 500, "missing", { link_from: "repo/B/shared.bin" })]),
  set("b", [file("LICENSE", 10, "present"), file("B/model.bin", 800, "partial", { partial_bytes: 300 }), file("B/config.json", 40, "mismatch")]),
]);

describe("downloadBlockedReason", () => {
  const stopped = { state: "stopped" as const };
  const reason = (v: WeightsView, patch: { accepted?: boolean; stale?: boolean; state?: "stopped" | "ready" | "error"; replace?: boolean } = {}) =>
    downloadBlockedReason({ descriptor: { state: patch.state ?? stopped.state }, view: v, totals: weightsTotals(v, patch.replace ?? false), accepted: patch.accepted ?? true, stale: patch.stale ?? false });

  it("checks the Node, the job, the plan, the component, the files, the disk and the license in order", () => {
    expect(reason(MIXED, { stale: true })).toMatch(/Node 離線/);
    expect(reason(view(MIXED.sets, { job: { ...job(), state: "running" } }))).toBe("下載進行中");
    expect(reason(view([]))).toBe("這個元件沒有可以下載的權重");
    expect(reason(view(MIXED.sets, { root: null, notes: ["未設定 load.model_path（模型根目錄）"] }))).toBe("未設定 load.model_path（模型根目錄）");
    expect(reason(MIXED, { state: "ready" })).toMatch(/元件停止時才能下載/);
    expect(reason(view(MIXED.sets, { free_bytes: 100 }))).toMatch(/磁碟剩餘空間不足/);
    expect(reason(MIXED, { accepted: false })).toMatch(/授權條款/);
    expect(reason(MIXED)).toBeNull();
    expect(reason(MIXED, { state: "error" })).toBeNull();
  });

  it("says what is left when nothing is missing", () => {
    expect(reason(view([set("a", [file("x", 1, "present")])]))).toBe("沒有缺少的檔案");
    const onlyMismatch = view([set("a", [file("x", 1, "mismatch")])]);
    expect(reason(onlyMismatch)).toMatch(/取代大小不同的檔案/);
    expect(reason(onlyMismatch, { replace: true })).toBeNull();
  });
});

function job() {
  return {
    job_id: "00000000-0000-4000-8000-000000000001",
    component_id: "dit",
    state: "failed" as const,
    started_at: "2026-11-04T00:00:00.000Z",
    finished_at: "2026-11-04T00:01:00.000Z",
    sets: ["a"],
    files_total: 2,
    files_done: 1,
    files_linked: 0,
    bytes_total: 1000,
    bytes_done: 250,
    current: null,
    error: null,
  };
}
