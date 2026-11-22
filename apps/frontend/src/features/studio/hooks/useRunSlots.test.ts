import { describe, expect, it } from "vitest";
import type { WireRun } from "@/api/types";
import { runSlots, takesRunSlot } from "./useRunSlots";

function run(id: string, steps: Record<string, string>, purpose?: "proxy"): WireRun {
  return {
    run_id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    state: "running",
    request: { pipeline: { pipeline_id: `p${id}`, label: `run ${id}`, inputs: [], outputs: {}, steps: [] }, inputs: {}, label: `run ${id}`, ...(purpose ? { purpose } : {}) },
    created_at: "2026-11-21T00:00:00Z",
    finished_at: null,
    steps: Object.fromEntries(Object.entries(steps).map(([key, state]) => [key, { state }])),
    outputs: {},
    recording_ids: [],
    error: null,
  };
}

describe("run slots", () => {
  it("counts only runs with a running step", () => {
    expect(takesRunSlot(run("1", { a: "running", b: "pending" }))).toBe(true);
    expect(takesRunSlot(run("2", { a: "waiting", b: "pending" }))).toBe(false);
    expect(takesRunSlot(run("3", { a: "running" }, "proxy"))).toBe(false);
  });

  it("does not block a new run while the other runs only wait for a GPU", () => {
    const running = [run("1", { dit: "running" }), run("2", { dit: "waiting" }), run("3", { dit: "waiting" })];
    const slots = runSlots(running, 2);
    expect(slots.blockedReason).toBeNull();
    expect(slots.activeRunIds).toHaveLength(3);
  });

  it("blocks when every slot computes and names only the computing runs", () => {
    const running = [run("1", { dit: "running" }), run("2", { vae: "running" }), run("3", { dit: "waiting" })];
    const slots = runSlots(running, 2);
    expect(slots.blockedReason).toContain("run 1");
    expect(slots.blockedReason).toContain("run 2");
    expect(slots.blockedReason).not.toContain("run 3");
  });

  it("assumes one slot while the limit is unknown", () => {
    expect(runSlots([run("1", { a: "running" })], null).blockedReason).not.toBeNull();
    expect(runSlots([run("1", { a: "waiting" })], null).blockedReason).toBeNull();
  });
});
