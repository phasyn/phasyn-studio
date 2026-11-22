// Multi-select removal of Studio projects (the project table's checkbox column): which rows are selected (click,
// Shift+click range, select-all of the filtered list), which of them may be removed (never the open project), and the
// sequential run over the existing per-project DELETE (one request at a time, each with the revision the list showed;
// a project that is already gone counts as removed, so running it again is harmless; a failure stops nothing else).
import type { StorageCleanRequest, StorageCleanResult, StorageFileKey, StudioProjectSummary } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import { isRecord } from "@/lib/json";

export interface RowSelection {
  readonly ids: ReadonlySet<string>;
  /** The last row clicked without Shift: the start of a Shift+click range (null: none). */
  readonly anchor: string | null;
}

export const NO_SELECTION: RowSelection = { ids: new Set(), anchor: null };

/**
 * One checkbox click. `order` is the visible, selectable rows in display order. Shift with an anchor that is still
 * visible sets every row between the anchor and `id` (both included) to the clicked row's new state; otherwise only
 * `id` flips. The anchor moves to `id` either way.
 */
export function toggleRow(selection: RowSelection, order: readonly string[], id: string, shift: boolean): RowSelection {
  if (!order.includes(id)) return selection;
  const next = new Set(selection.ids);
  const checked = !selection.ids.has(id);
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const range = shift && from >= 0 ? order.slice(Math.min(from, order.indexOf(id)), Math.max(from, order.indexOf(id)) + 1) : [id];
  for (const row of range) {
    if (checked) next.add(row);
    else next.delete(row);
  }
  return { ids: next, anchor: id };
}

/** The header checkbox: whether all, some or none of the visible selectable rows are selected. */
export function selectAllState(selection: RowSelection, order: readonly string[]): "all" | "some" | "none" {
  const count = order.filter((id) => selection.ids.has(id)).length;
  if (count === 0) return "none";
  return count === order.length ? "all" : "some";
}

/** The header checkbox click: all visible selectable rows when not all are selected, otherwise none. */
export function toggleAll(selection: RowSelection, order: readonly string[]): RowSelection {
  return selectAllState(selection, order) === "all" ? NO_SELECTION : { ids: new Set(order), anchor: null };
}

/** Keeps only the rows still visible (a new search or a removal): what is selected is always what is on screen. */
export function pruneSelection(selection: RowSelection, visible: readonly string[]): RowSelection {
  const ids = new Set(visible.filter((id) => selection.ids.has(id)));
  if (ids.size === selection.ids.size) return selection;
  return { ids, anchor: selection.anchor !== null && ids.has(selection.anchor) ? selection.anchor : null };
}

/** The selected projects in display order, without the open project (it cannot be removed while it is open). */
export function removalTargets(rows: readonly StudioProjectSummary[], selection: RowSelection, currentId: string | null): StudioProjectSummary[] {
  return rows.filter((item) => selection.ids.has(item.project_id) && item.project_id !== currentId);
}

export type RemovalOutcome =
  | { item: StudioProjectSummary; status: "removed" }
  /** The project was already gone (removed elsewhere, or a repeated run): nothing left to remove. */
  | { item: StudioProjectSummary; status: "gone" }
  | { item: StudioProjectSummary; status: "failed"; error: unknown };

/**
 * Removes the targets one at a time with `remove(projectId, revision)` and reports each outcome as it lands. NOT_FOUND
 * is "gone" (idempotent); any other error is "failed" for that project only and the run goes on. Never retries.
 */
export async function removeSequentially(
  targets: readonly StudioProjectSummary[],
  remove: (projectId: string, revision: number) => Promise<unknown>,
  onOutcome: (outcome: RemovalOutcome, done: number) => void = () => undefined,
): Promise<RemovalOutcome[]> {
  const outcomes: RemovalOutcome[] = [];
  for (const item of targets) {
    let outcome: RemovalOutcome;
    try {
      await remove(item.project_id, item.revision);
      outcome = { item, status: "removed" };
    } catch (error) {
      outcome = isApiError(error) && error.code === "NOT_FOUND" ? { item, status: "gone" } : { item, status: "failed", error };
    }
    outcomes.push(outcome);
    onOutcome(outcome, outcomes.length);
  }
  return outcomes;
}

// ── Optional media cleanup after removal (「同時清除這些專案專屬的影片與圖片」) ─────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SCOPE_LIMITS = { project_ids: 200, run_ids: 5000, files: 20000 } as const;

/** What a removed project named: its runs (any `run_id`/`*_run_id` field) and every file reference in it. */
export interface MediaScope {
  project_ids: string[];
  run_ids: string[];
  files: StorageFileKey[];
}

function isFileRef(value: Record<string, unknown>): boolean {
  return typeof value["node_id"] === "string" && typeof value["file_id"] === "string" && typeof value["sha256"] === "string" && typeof value["size_bytes"] === "number";
}

/** Collects the scope from a project document read before it is removed (any depth, iteratively). */
export function projectMediaScope(projectId: string, doc: unknown): MediaScope {
  const runs = new Set<string>();
  const files = new Map<string, StorageFileKey>();
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...(value as unknown[]));
    } else if (isRecord(value)) {
      if (isFileRef(value)) {
        const key = { node_id: String(value["node_id"]).toLowerCase(), file_id: String(value["file_id"]).toLowerCase() };
        files.set(`${key.node_id}/${key.file_id}`, key);
      }
      for (const [field, item] of Object.entries(value)) {
        if ((field === "run_id" || field.endsWith("_run_id")) && typeof item === "string" && UUID.test(item)) runs.add(item.toLowerCase());
        else stack.push(item);
      }
    }
  }
  return { project_ids: [projectId], run_ids: [...runs], files: [...files.values()] };
}

/** One scope for several removed projects (deduplicated, within the contract's limits). */
export function mergeScopes(scopes: readonly MediaScope[]): MediaScope {
  const projects = new Set(scopes.flatMap((scope) => scope.project_ids));
  const runs = new Set(scopes.flatMap((scope) => scope.run_ids));
  const files = new Map(scopes.flatMap((scope) => scope.files.map((key) => [`${key.node_id}/${key.file_id}`, key] as const)));
  return {
    project_ids: [...projects].slice(0, SCOPE_LIMITS.project_ids),
    run_ids: [...runs].slice(0, SCOPE_LIMITS.run_ids),
    files: [...files.values()].slice(0, SCOPE_LIMITS.files),
  };
}

/**
 * Plans the cleanup of the removed projects' own runs and files, then deletes exactly the planned items (the server
 * re-checks each one: anything another project, run, plan or pin still names is never planned). Null when there is
 * nothing in scope. Runs only after the projects are gone, so their own references no longer protect the media.
 */
export async function cleanProjectMedia(scope: MediaScope, clean: (body: StorageCleanRequest) => Promise<StorageCleanResult>): Promise<StorageCleanResult | null> {
  if (scope.project_ids.length === 0) return null;
  const body: StorageCleanRequest = { categories: ["runs", "files"], dry_run: true, options: { min_age_hours: 0 }, scope };
  const plan = await clean(body);
  if (plan.items.length === 0) return plan;
  return clean({ ...body, dry_run: false, items: plan.items.map((item) => item.item_id) });
}

/** The numbers the removal result reports about the media cleanup. */
export function mediaCleanupSummary(result: StorageCleanResult): { deleted: number; failed: number; bytes: number } {
  const deleted = result.dry_run ? [] : result.items.filter((item) => item.status === "deleted" || item.status === "missing");
  return {
    deleted: deleted.length,
    failed: result.dry_run ? 0 : result.items.filter((item) => item.status === "failed").length,
    bytes: deleted.reduce((sum, item) => sum + (item.size_bytes ?? 0), 0),
  };
}
