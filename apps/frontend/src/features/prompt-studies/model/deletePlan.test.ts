import { describe, expect, it } from "vitest";
import type { PromptStudyDeletionPlan } from "../types";
import { deleteBlockReason, deleteScopeLines } from "./deletePlan";
import { FILE } from "./testFixtures";

const plan = (overrides: Partial<PromptStudyDeletionPlan> = {}): PromptStudyDeletionPlan => ({
  study_id: "ps1",
  title: "茶壺",
  mode: "keep_images",
  revision: 4,
  dry_run: true,
  deleted: false,
  can_delete: true,
  blocking: [],
  counts: { versions: 3, tasks: 2, evaluations: 5, images: 6, runs_delete: 0, runs_keep: 0 },
  runs: [],
  source: { file: FILE, action: "keep", reason: "Studio 專案仍使用這張原圖", status: "kept" },
  ...overrides,
});

const row = (runId: string, action: PromptStudyDeletionPlan["runs"][number]["action"], files = 0, status: PromptStudyDeletionPlan["runs"][number]["status"] = "planned") => ({
  run_id: runId,
  role: files > 0 ? ("image" as const) : ("analysis" as const),
  action,
  reason: "",
  files,
  status,
  message: null,
});

describe("刪除範圍文字", () => {
  it("保留圖片：列出研究內容、保留的生成 run、原圖保留的原因與不可復原", () => {
    const lines = deleteScopeLines(plan({ runs: [row("r1", "keep", 2), row("r2", "keep", 2)], counts: { versions: 3, tasks: 2, evaluations: 5, images: 6, runs_delete: 0, runs_keep: 2 } }), "x").map((line) => line.text);
    expect(lines[0]).toBe("研究「茶壺」：3 個版本、2 個任務、5 筆比較、6 張生成圖的紀錄會被刪除");
    expect(lines).toContain("不刪除任何 run");
    expect(lines).toContain("保留 2 個產生圖片的 run（圖片仍在 Node 上）");
    expect(lines).toContain("保留原圖：Studio 專案仍使用這張原圖");
    expect(lines[lines.length - 1]).toBe("無法復原；只想先收起來請改用「封存」");
  });

  it("完整移除：刪除的 run 與檔案數、共用保留、已不存在、刪除原圖", () => {
    const lines = deleteScopeLines(
      plan({
        mode: "all",
        counts: { versions: 1, tasks: 1, evaluations: 1, images: 1, runs_delete: 2, runs_keep: 1 },
        runs: [row("r1", "delete", 3), row("r2", "delete", 0), row("r3", "shared", 1), row("r4", "missing")],
        source: { file: FILE, action: "delete", reason: "此研究獨占的上傳原圖", status: "planned" },
      }),
      "x",
    );
    expect(lines.find((line) => line.icon === "files")).toMatchObject({ tone: "warning", text: "刪除 2 個此研究獨占的 run（輸出檔與效能紀錄，共 3 個檔案）" });
    expect(lines.map((line) => line.text)).toContain("保留 1 個仍被其他研究或 Studio 專案使用的 run");
    expect(lines.map((line) => line.text)).toContain("1 個 run 已不存在（視為已刪除）");
    expect(lines.find((line) => line.icon === "source")).toMatchObject({ tone: "warning", text: "刪除這個研究獨占、上傳到主控的原圖" });
  });

  it("有執行中的任務或 run 時不能刪（主控的 blocking 原文）", () => {
    const blocked = plan({ can_delete: false, blocking: [{ code: "TASK_RUNNING", message: "任務 t1 仍標記為執行中；請先停止或標記為已中斷", task_id: "t1", run_id: null }] });
    expect(deleteBlockReason(blocked)).toBe("任務 t1 仍標記為執行中；請先停止或標記為已中斷");
    expect(deleteScopeLines(blocked, "x").some((line) => line.tone === "danger" && line.icon === "blocked")).toBe(true);
    expect(deleteBlockReason(plan())).toBeNull();
  });
});
