// The project list keeps up with changes made elsewhere (another tab, an agent through phasynctl, a sync tool) while it is
// open: the Controller's list is read again every OUTSIDE_SAVES_POLL_MS, so a stale table never stays on screen.
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioProjectSummary } from "@/api/generated/contracts";
import { installFakeApi } from "@/test/fakeApi";
import { renderWithProviders } from "@/test/render";
import { OUTSIDE_SAVES_POLL_MS } from "./document/useOutsideSaves";
import { ProjectTable } from "./ProjectTable";

const item = (id: string, title: string): StudioProjectSummary => ({
  project_id: id, title, revision: 1, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", shot_count: 0, rendered_shot_count: 0,
});

afterEach(() => { vi.useRealTimers(); });

describe("ProjectTable", () => {
  it("shows a project renamed or added elsewhere without reloading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let items = [item("p-a", "夜景")];
    installFakeApi({ "GET /api/studio/projects": () => ({ items }) });
    renderWithProviders(<ProjectTable pickedId={null} onPick={vi.fn<(id: string) => void>()} onOpen={vi.fn<(id: string) => void>()} metaOf={() => ""} />);
    expect(await screen.findByText("夜景")).toBeInTheDocument();
    items = [item("p-a", "夜景（改名）"), item("p-b", "雨巷")];
    await vi.advanceTimersByTimeAsync(OUTSIDE_SAVES_POLL_MS + 100);
    expect(await screen.findByText("夜景（改名）")).toBeInTheDocument();
    expect(screen.getByText("雨巷")).toBeInTheDocument();
  });
});

describe("ProjectTable rendered column", () => {
  it("shows the Studio's own count with 需更新, and the Controller's summary until it is known", async () => {
    installFakeApi({ "GET /api/studio/projects": () => ({ items: [{ ...item("p-a", "夜景"), shot_count: 2, rendered_shot_count: 2 }, { ...item("p-b", "雨巷"), shot_count: 3, rendered_shot_count: 1 }] }) });
    const progressHook = () => (row: StudioProjectSummary) => (row.project_id === "p-a" ? { ready: 0, total: 2, stale: 2 } : null);
    renderWithProviders(<ProjectTable pickedId={null} onPick={vi.fn<(id: string) => void>()} onOpen={vi.fn<(id: string) => void>()} metaOf={() => ""} useProgress={progressHook} />);
    const night = (await screen.findByText("夜景")).closest("button");
    expect(night).toHaveTextContent("0/2");
    expect(night).toHaveTextContent("需更新 2");
    const rain = screen.getByText("雨巷").closest("button");
    expect(rain).toHaveTextContent("1/3");
    expect(rain).not.toHaveTextContent("需更新");
  });
});
