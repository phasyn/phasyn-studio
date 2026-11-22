// Boundary test of the storage cleanup UI (destructive): the dry run deletes nothing, the deletion waits for one
// confirmation, sends exactly the planned items still ticked with the plan's own categories and options, and the
// result is reported per item; cancelling the confirmation sends nothing.
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StorageCleanResult, StorageItem } from "@/api/generated/contracts";
import { isRecord } from "@/lib/json";
import { installFakeApi } from "@/test/fakeApi";
import { renderWithProviders } from "@/test/render";
import { CleanPanel } from "./StoragePage";

const ZERO = { count: 0, size_bytes: 0 };
const item = (id: string, label: string, category: StorageItem["category"] = "runs"): StorageItem => ({
  item_id: id, category, status: "planned", label, node_id: null, size_bytes: 1024, created_at: null,
});
const ITEMS = [item("run:a", "舊 run A"), item("run:b", "舊 run B"), item("file:n/f", "主控 檔案 f", "files")];

function answer(dryRun: boolean, items: StorageItem[]): StorageCleanResult {
  return {
    dry_run: dryRun, categories: ["runs", "files", "remote_cache"], options: { min_age_hours: 24, recordings_older_than_days: 30, include_standalone_runs: false },
    scope: null, items, truncated: false, nodes: [], started_at: "", finished_at: "",
    totals: { runs: ZERO, files: ZERO, remote_cache: ZERO, latents: ZERO, recordings: ZERO },
  };
}

describe("CleanPanel", () => {
  it("plans, waits for the confirmation, then deletes exactly the ticked items", async () => {
    const api = installFakeApi({
      "POST /api/storage/clean": (request) => {
        const body = isRecord(request.body) ? request.body : {};
        if (body["dry_run"] === true) return answer(true, ITEMS);
        const ids = Array.isArray(body["items"]) ? body["items"] : [];
        return answer(false, ITEMS.filter((row) => ids.includes(row.item_id)).map((row) => ({ ...row, status: "deleted" as const })));
      },
    });
    const { user } = renderWithProviders(<CleanPanel />);
    const bodies = () => api.calls.filter((call) => call.path === "/api/storage/clean").map((call) => (isRecord(call.body) ? call.body : {}));

    await user.click(screen.getByRole("button", { name: "試算可回收的空間" }));
    expect(await screen.findByText("舊 run A")).toBeInTheDocument();
    expect(bodies()).toEqual([{ dry_run: true, categories: ["runs", "files", "remote_cache"], options: { min_age_hours: 24, recordings_older_than_days: 30, include_standalone_runs: false } }]);

    await user.click(screen.getByRole("checkbox", { name: "刪除「舊 run B」" }));
    await user.click(screen.getByRole("button", { name: "刪除 2 項" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/永久刪除 2 項/u)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(bodies()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "刪除 2 項" }));
    await user.dblClick(within(await screen.findByRole("dialog")).getByRole("button", { name: "永久刪除" }));
    expect(await screen.findByText("已刪除 2 項，保留 0 項，未變更 0 項，失敗 0 項。")).toBeInTheDocument();
    expect(bodies()).toHaveLength(2);
    expect(bodies()[1]).toEqual({
      categories: ["runs", "files", "remote_cache"], dry_run: false,
      options: { min_age_hours: 24, recordings_older_than_days: 30, include_standalone_runs: false }, items: ["run:a", "file:n/f"],
    });
  });
});
