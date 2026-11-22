// Boundary test of multi-select project removal (destructive): which rows a click, Shift+click or select-all picks,
// that the open project is never a target, and that the run sends one DELETE per project in order with the revision
// the list showed, keeps going after a failure and treats an already-removed project as removed.
import { describe, expect, it } from "vitest";
import type { StorageCleanRequest, StorageCleanResult, StudioProjectSummary } from "@/api/generated/contracts";
import { ApiError } from "@/api/http";
import { uid } from "@/test/ids";
import { cleanProjectMedia, mergeScopes, NO_SELECTION, projectMediaScope, pruneSelection, removalTargets, removeSequentially, selectAllState, toggleAll, toggleRow, type RowSelection } from "./projectRemovalModel";

const item = (id: string, revision = 1): StudioProjectSummary => ({
  project_id: id, title: `專案 ${id}`, revision, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", shot_count: 2, rendered_shot_count: 1,
});
const ORDER = ["a", "b", "c", "d", "e"];
const ids = (selection: RowSelection) => [...selection.ids].sort();

describe("row selection", () => {
  it("toggles one row per click and selects a range with Shift", () => {
    let selection = toggleRow(NO_SELECTION, ORDER, "b", false);
    expect(ids(selection)).toEqual(["b"]);
    selection = toggleRow(selection, ORDER, "e", true);
    expect(ids(selection)).toEqual(["b", "c", "d", "e"]);
    // Shift+click on a selected row clears the range from the anchor (e) back to it
    selection = toggleRow(selection, ORDER, "c", true);
    expect(ids(selection)).toEqual(["b"]);
    expect(toggleRow(selection, ORDER, "b", false).ids.size).toBe(0);
  });

  it("treats Shift without a visible anchor as a single click and ignores rows that cannot be selected", () => {
    expect(ids(toggleRow(NO_SELECTION, ORDER, "c", true))).toEqual(["c"]);
    const hiddenAnchor: RowSelection = { ids: new Set(["z"]), anchor: "z" };
    expect(ids(toggleRow(hiddenAnchor, ORDER, "b", true))).toEqual(["b", "z"]);
    expect(toggleRow(NO_SELECTION, ORDER, "open-project", false)).toBe(NO_SELECTION);
  });

  it("selects all visible rows, then none, and reports partial selection", () => {
    expect(selectAllState(NO_SELECTION, ORDER)).toBe("none");
    const all = toggleAll(NO_SELECTION, ORDER);
    expect(ids(all)).toEqual(ORDER);
    expect(selectAllState(all, ORDER)).toBe("all");
    expect(selectAllState(toggleRow(all, ORDER, "a", false), ORDER)).toBe("some");
    expect(toggleAll(all, ORDER).ids.size).toBe(0);
    expect(selectAllState(all, ["a", "b"])).toBe("all");
  });

  it("drops rows that are no longer on screen", () => {
    const selection: RowSelection = { ids: new Set(["a", "c"]), anchor: "c" };
    expect(pruneSelection(selection, ORDER)).toBe(selection);
    const pruned = pruneSelection(selection, ["a", "b"]);
    expect(ids(pruned)).toEqual(["a"]);
    expect(pruned.anchor).toBeNull();
  });

  it("never targets the open project, even when its id is in the selection", () => {
    const rows = ORDER.map((id) => item(id));
    const selection: RowSelection = { ids: new Set(["d", "b", "open"]), anchor: null };
    expect(removalTargets([...rows, item("open")], selection, "open").map((row) => row.project_id)).toEqual(["b", "d"]);
    expect(removalTargets(rows, { ids: new Set(["b"]), anchor: null }, "b")).toEqual([]);
  });
});

describe("removeSequentially", () => {
  it("sends one request at a time, in order, with each project's revision", async () => {
    const sent: string[] = [];
    let inFlight = 0;
    const outcomes = await removeSequentially([item("a", 3), item("b", 7)], async (id, revision) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      sent.push(`${id}@${String(revision)}`);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(sent).toEqual(["a@3", "b@7"]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["removed", "removed"]);
  });

  it("reports a failure for that project only and treats NOT_FOUND as already removed", async () => {
    const progress: number[] = [];
    const outcomes = await removeSequentially(
      [item("a"), item("b"), item("c")],
      (id) => {
        if (id === "a") return Promise.reject(new ApiError(409, { code: "REVISION_CONFLICT", message: "版本不符" }, "conflict"));
        if (id === "b") return Promise.reject(new ApiError(404, { code: "NOT_FOUND", message: "不存在" }, "missing"));
        return Promise.resolve(null);
      },
      (_outcome, done) => { progress.push(done); },
    );
    expect(outcomes.map((outcome) => [outcome.item.project_id, outcome.status])).toEqual([["a", "failed"], ["b", "gone"], ["c", "removed"]]);
    expect(progress).toEqual([1, 2, 3]);
  });

  it("does nothing for an empty selection", async () => {
    expect(await removeSequentially([], () => Promise.reject(new Error("must not be called")))).toEqual([]);
  });
});

describe("project media cleanup", () => {
  const ref = (fileId: string) => ({ node_id: uid(9001).toUpperCase(), file_id: fileId, sha256: "a".repeat(64), size_bytes: 3, media_type: "image/png", metadata: {} });

  it("collects every run id and file reference of the project, at any depth", () => {
    const doc = {
      shots: [{ takes: [{ run_id: uid(1), generation_run_id: uid(2), asset: { file: ref(uid(3)) } }] }],
      exports: [{ run_id: uid(4) }],
      library: [{ file: ref(uid(5)), source: { kind: "run_output", run_id: uid(1) } }],
      note: "run_id: not-a-uuid",
      timeline: { sources: [{ file: ref(uid(3)) }] },
    };
    const scope = projectMediaScope("p1", doc);
    expect(scope.project_ids).toEqual(["p1"]);
    expect([...scope.run_ids].sort()).toEqual([uid(1), uid(2), uid(4)].sort());
    expect(scope.files.map((key) => key.file_id).sort()).toEqual([uid(3), uid(5)].sort());
    expect(scope.files.every((key) => key.node_id === uid(9001))).toBe(true);
    expect(mergeScopes([scope, projectMediaScope("p2", { exports: [{ run_id: uid(4) }] })])).toEqual({
      project_ids: ["p1", "p2"], run_ids: scope.run_ids, files: scope.files,
    });
  });

  it("plans first and deletes only the planned items; an empty plan deletes nothing", async () => {
    const bodies: StorageCleanRequest[] = [];
    const answer = (items: string[]): StorageCleanResult => ({
      dry_run: true, categories: ["runs", "files"], options: { min_age_hours: 0, recordings_older_than_days: 30, include_standalone_runs: false },
      scope: null, truncated: false, nodes: [], started_at: "", finished_at: "",
      totals: { runs: { count: 0, size_bytes: 0 }, files: { count: 0, size_bytes: 0 }, remote_cache: { count: 0, size_bytes: 0 }, latents: { count: 0, size_bytes: 0 }, recordings: { count: 0, size_bytes: 0 } },
      items: items.map((id) => ({ item_id: id, category: "runs", status: "planned", label: id, node_id: null, size_bytes: 1, created_at: null })),
    });
    const scope = { project_ids: ["p1"], run_ids: [uid(1)], files: [] };
    await cleanProjectMedia(scope, (body) => { bodies.push(body); return Promise.resolve(answer(body.dry_run ? [`run:${uid(1)}`] : [])); });
    expect(bodies.map((body) => [body.dry_run, body.items])).toEqual([[true, undefined], [false, [`run:${uid(1)}`]]]);
    expect(bodies[0]).toMatchObject({ categories: ["runs", "files"], options: { min_age_hours: 0 }, scope });

    bodies.length = 0;
    await cleanProjectMedia(scope, (body) => { bodies.push(body); return Promise.resolve(answer([])); });
    expect(bodies).toHaveLength(1);
    expect(await cleanProjectMedia({ project_ids: [], run_ids: [], files: [] }, () => Promise.reject(new Error("must not be called")))).toBeNull();
  });
});
