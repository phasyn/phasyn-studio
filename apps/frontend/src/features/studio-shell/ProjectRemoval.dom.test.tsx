// Boundary test of the multi-select removal UI (destructive): nothing is deleted before the confirmation, the
// confirmation names every project and what is kept, the open project cannot be selected, and a partial failure is
// reported per project.
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StudioProject, StudioProjectSummary } from "@/api/generated/contracts";
import { isRecord } from "@/lib/json";
import { fakeError, installFakeApi } from "@/test/fakeApi";
import { studioProject, studioShot, studioTake } from "@/test/fixtures/studio";
import { FIXED_TIME, uid } from "@/test/ids";
import { renderWithProviders } from "@/test/render";
import { ProjectRemovalPanel } from "./ProjectRemoval";
import { ProjectTable } from "./ProjectTable";

const item = (id: string, title: string, revision = 1): StudioProjectSummary => ({
  project_id: id, title, revision, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", shot_count: 2, rendered_shot_count: 1,
});
const ITEMS = [item("p-a", "夜景", 4), item("p-b", "雨巷", 2), item("p-c", "海邊", 9)];

describe("ProjectTable selection", () => {
  it("disables search, checkboxes, rows and the removal button while locked, and shows the result notice", async () => {
    installFakeApi({ "GET /api/studio/projects": () => ({ items: ITEMS }) });
    renderWithProviders(
      <ProjectTable pickedId={null} onPick={vi.fn<(id: string) => void>()} onOpen={vi.fn<(id: string) => void>()} metaOf={() => ""} onRequestRemove={vi.fn<(items: StudioProjectSummary[]) => void>()} locked notice="已移除 2 個專案。" />,
    );
    expect(await screen.findByRole("checkbox", { name: "選取「夜景」" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "全選列出的專案" })).toBeDisabled();
    expect(screen.getByRole("searchbox", { name: "搜尋專案名稱" })).toBeDisabled();
    for (const row of document.querySelectorAll("button[data-project-row]")) expect(row).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("已移除 2 個專案。");
  });

  it("selects with the checkboxes, Shift+click ranges and select-all, never the open project", async () => {
    installFakeApi({ "GET /api/studio/projects": () => ({ items: ITEMS }) });
    const onRequestRemove = vi.fn<(items: StudioProjectSummary[]) => void>();
    const { user } = renderWithProviders(
      <ProjectTable currentId="p-b" pickedId={null} onPick={vi.fn<(id: string) => void>()} onOpen={vi.fn<(id: string) => void>()} metaOf={() => ""} onRequestRemove={onRequestRemove} />,
    );
    const open = await screen.findByRole("checkbox", { name: "選取「雨巷」" });
    expect(open).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "全選列出的專案" }));
    expect(screen.getByRole("checkbox", { name: "選取「夜景」" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "選取「海邊」" })).toBeChecked();
    expect(open).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "移除 2 個專案" }));
    expect(onRequestRemove).toHaveBeenLastCalledWith([expect.objectContaining({ project_id: "p-a" }), expect.objectContaining({ project_id: "p-c" })]);

    await user.click(screen.getByRole("button", { name: "取消選取" }));
    expect(screen.queryByRole("button", { name: /^移除 / })).toBeNull();

    // Shift+click from the anchor selects the range between (the open project in it stays unselected)
    await user.click(screen.getByRole("checkbox", { name: "選取「海邊」" }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("checkbox", { name: "選取「夜景」" }));
    await user.keyboard("{/Shift}");
    expect(screen.getByRole("checkbox", { name: "選取「夜景」" })).toBeChecked();
    expect(open).not.toBeChecked();
    expect(screen.getByRole("button", { name: "移除 2 個專案" })).toBeInTheDocument();
  });
});

describe("ProjectRemovalPanel", () => {
  it("closes by itself when every project went, and locks its buttons while removing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    installFakeApi({
      "DELETE /api/studio/projects/p-a": async () => { await gate; return { project_id: "p-a", deleted: true }; },
      "DELETE /api/studio/projects/p-c": () => ({ project_id: "p-c", deleted: true }),
      "GET /api/studio/projects": () => ({ items: [] }),
    });
    const onRemoved = vi.fn<(message: string) => void>();
    const onClose = vi.fn<() => void>();
    const { user } = renderWithProviders(<ProjectRemovalPanel items={ITEMS.filter((entry) => entry.project_id !== "p-b")} layout="inline" onClose={onClose} onRemoved={onRemoved} />);
    await user.click(screen.getByRole("button", { name: "移除 2 個專案" }));
    expect(await screen.findByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /正在移除/u })).toHaveAttribute("aria-disabled", "true");
    release();
    await vi.waitFor(() => { expect(onRemoved).toHaveBeenCalledWith("已移除 2 個專案。"); });
    expect(screen.queryByRole("button", { name: "完成" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("deletes nothing until confirmed, then one DELETE per project with its revision, reporting each result", async () => {
    const api = installFakeApi({
      "DELETE /api/studio/projects/p-a": () => ({ project_id: "p-a", deleted: true }),
      "DELETE /api/studio/projects/p-b": () => fakeError(409, "REVISION_CONFLICT", "版本不符"),
      "DELETE /api/studio/projects/p-c": () => fakeError(404, "NOT_FOUND", "找不到"),
      "GET /api/studio/projects": () => ({ items: [ITEMS[1]] }),
    });
    const onClose = vi.fn<() => void>();
    const { user } = renderWithProviders(<ProjectRemovalPanel items={ITEMS} layout="inline" onClose={onClose} />);
    const deletes = () => api.calls.filter((call) => call.method === "DELETE");

    const list = screen.getByRole("list", { name: "要移除的專案" });
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual([expect.stringContaining("夜景"), expect.stringContaining("雨巷"), expect.stringContaining("海邊")]);
    expect(screen.getByText(/不會清除，仍保留在主控與 Node/u)).toBeInTheDocument();
    expect(deletes()).toHaveLength(0);

    await user.dblClick(screen.getByRole("button", { name: "移除 3 個專案" }));
    expect(await screen.findByText("已移除 2 個，1 個沒有移除。")).toBeInTheDocument();
    expect(deletes().map((call) => `${call.path}?revision=${call.query.get("revision") ?? ""}`)).toEqual([
      "/api/studio/projects/p-a?revision=4",
      "/api/studio/projects/p-b?revision=2",
      "/api/studio/projects/p-c?revision=9",
    ]);
    expect(screen.getByText("已移除")).toBeInTheDocument();
    expect(screen.getByText(/剛在別處被修改，沒有移除/u)).toBeInTheDocument();
    expect(screen.getByText("已不存在（先前已移除）")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cleans no media unless the box is ticked", async () => {
    const api = installFakeApi({
      "DELETE /api/studio/projects/p-a": () => ({ project_id: "p-a", deleted: true }),
      "GET /api/studio/projects": () => ({ items: [] }),
    });
    const { user } = renderWithProviders(<ProjectRemovalPanel items={ITEMS.slice(0, 1)} layout="inline" onClose={vi.fn<() => void>()} />);
    expect(screen.getByRole("checkbox", { name: "同時清除這些專案專屬的影片與圖片" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "移除 1 個專案" }));
    expect(await screen.findByText("已移除 1 個專案。")).toBeInTheDocument();
    expect(api.calls.filter((call) => call.path.startsWith("/api/storage") || call.method === "GET" && call.path === "/api/studio/projects/p-a")).toHaveLength(0);
  });

  it("with the box ticked: reads each project first, removes it, then deletes only the planned media of removed projects", async () => {
    const take = studioTake({ take_id: "t1", run_id: uid(1001) });
    const docs: Record<string, StudioProject> = {
      "p-a": studioProject({ project_id: "p-a", revision: 4, shots: [studioShot({ takes: [take], active_take_id: "t1" })] }),
      "p-b": studioProject({ project_id: "p-b", revision: 2 }),
    };
    const planned = [
      { item_id: `run:${uid(1001)}`, category: "runs", status: "planned", label: "render", node_id: null, size_bytes: 300, created_at: null },
    ];
    const result = (dryRun: boolean, status: string) => ({
      dry_run: dryRun, categories: ["runs", "files"], options: { min_age_hours: 0, recordings_older_than_days: 30, include_standalone_runs: false },
      scope: null, items: planned.map((item) => ({ ...item, status })), truncated: false, nodes: [], started_at: FIXED_TIME, finished_at: FIXED_TIME,
      totals: Object.fromEntries(["runs", "files", "remote_cache", "latents", "recordings"].map((c) => [c, { count: 0, size_bytes: 0 }])),
    });
    const api = installFakeApi({
      "GET /api/studio/projects/p-a": () => docs["p-a"],
      "GET /api/studio/projects/p-b": () => docs["p-b"],
      "DELETE /api/studio/projects/p-a": () => ({ project_id: "p-a", deleted: true }),
      "DELETE /api/studio/projects/p-b": () => fakeError(409, "REVISION_CONFLICT", "版本不符"),
      "POST /api/storage/clean": (request) => (isRecord(request.body) && request.body["dry_run"] === true ? result(true, "planned") : result(false, "deleted")),
      "GET /api/studio/projects": () => ({ items: [] }),
    });
    const { user } = renderWithProviders(<ProjectRemovalPanel items={ITEMS.slice(0, 2)} layout="inline" onClose={vi.fn<() => void>()} />);
    await user.click(screen.getByRole("checkbox", { name: "同時清除這些專案專屬的影片與圖片" }));
    expect(api.calls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "移除 2 個專案" }));
    expect(await screen.findByText(/已清除 1 項只屬於這些專案的影片與圖片/u)).toBeInTheDocument();

    const order = api.calls.map((call) => `${call.method} ${call.path}`);
    expect(order.indexOf("GET /api/studio/projects/p-a")).toBeLessThan(order.indexOf("DELETE /api/studio/projects/p-a"));
    const cleans = api.calls.filter((call) => call.path === "/api/storage/clean").map((call) => call.body);
    expect(cleans).toHaveLength(2);
    const [plan, apply] = cleans;
    // Only the removed project is in scope; p-b failed to delete, so its media is not touched
    expect(plan).toMatchObject({ dry_run: true, categories: ["runs", "files"], options: { min_age_hours: 0 }, scope: { project_ids: ["p-a"], run_ids: [uid(1001)] } });
    expect(apply).toMatchObject({ dry_run: false, items: [`run:${uid(1001)}`] });
  });

  it("closes without any request when cancelled", async () => {
    const api = installFakeApi({});
    const onClose = vi.fn<() => void>();
    const { user } = renderWithProviders(<ProjectRemovalPanel items={ITEMS.slice(0, 1)} layout="inline" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(api.calls).toHaveLength(0);
  });
});
