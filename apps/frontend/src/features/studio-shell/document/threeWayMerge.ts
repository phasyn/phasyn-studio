// Field-level three-way merge for "overwrite with this version" after a revision conflict.
//
// base   = the version this tab last loaded or saved (what both sides started from)
// latest = the server's newest version (someone else's save)
// mine   = this tab's draft
//
// A field only one side changed takes that side's value, so a change saved elsewhere (another tab muting A1, an agent
// adding a shot) survives an overwrite from a stale tab. A field both sides changed to different values is a conflict
// the person resolves field by field. Objects merge key by key; arrays of records that carry an id (track_id, shot_id,
// clip_id…) merge element by element, keeping the server's order and appending this tab's new elements; any other
// array is one value.
import { isRecord, valuesEqual } from "@/lib/json";

export type Side = "latest" | "mine";

export interface MergeConflict {
  /** A readable path such as timeline.tracks[audio-1].muted */
  path: string;
  base: unknown;
  latest: unknown;
  mine: unknown;
}

export interface MergeResult {
  merged: unknown;
  /** Fields both sides changed differently; `merged` holds the server's value there until a choice is applied. */
  conflicts: MergeConflict[];
  /** Fields this tab changed and the merge keeps (what the overwrite will write over the server's version). */
  mineApplied: string[];
  /** Fields the server changed and the merge keeps (what a whole-document overwrite would have lost). */
  latestKept: string[];
}

const ID_KEYS = ["track_id", "shot_id", "clip_id", "take_id", "item_id", "source_id", "caption_id", "marker_id", "export_id", "id"] as const;
// Marks a key or element one version does not have (distinct from a stored undefined or null)
const MISSING = Symbol("missing");

function idKeyOf(...arrays: unknown[][]): string | null {
  const items = arrays.flat();
  if (items.length === 0) return null;
  for (const key of ID_KEYS) {
    if (items.every((item) => isRecord(item) && typeof item[key] === "string")) return key;
  }
  return null;
}

function label(item: unknown, key: string): string {
  return isRecord(item) ? String(item[key]) : "?";
}

/** Merges base/latest/mine; see the module comment. */
export function threeWayMerge(base: unknown, latest: unknown, mine: unknown): MergeResult {
  const result: MergeResult = { merged: undefined, conflicts: [], mineApplied: [], latestKept: [] };
  result.merged = mergeAt("", base, latest, mine, result);
  return result;
}

function mergeAt(path: string, base: unknown, latest: unknown, mine: unknown, out: MergeResult): unknown {
  const same = (a: unknown, b: unknown) => (a === MISSING || b === MISSING ? a === b : valuesEqual(a, b));
  if (same(latest, mine)) return latest;
  if (same(base, mine)) {
    out.latestKept.push(...changedPaths(path, base, latest));
    return latest;
  }
  if (same(base, latest)) {
    out.mineApplied.push(...changedPaths(path, base, mine));
    return mine;
  }
  // Both sides changed: go deeper where the shape allows it
  if (isRecord(latest) && isRecord(mine)) {
    const from = isRecord(base) ? base : {};
    const merged: Record<string, unknown> = {};
    const keys = [...new Set([...Object.keys(latest), ...Object.keys(mine), ...Object.keys(from)])];
    for (const key of keys) {
      const value = mergeAt(
        path ? `${path}.${key}` : key,
        key in from ? from[key] : MISSING,
        key in latest ? latest[key] : MISSING,
        key in mine ? mine[key] : MISSING,
        out,
      );
      if (value !== MISSING) merged[key] = value;
    }
    return merged;
  }
  if (Array.isArray(latest) && Array.isArray(mine)) {
    const from = Array.isArray(base) ? base : [];
    const key = idKeyOf(from, latest, mine);
    if (key) {
      const index = (items: unknown[]) => new Map(items.map((item) => [label(item, key), item]));
      const b = index(from);
      const l = index(latest);
      const m = index(mine);
      const order = [...l.keys(), ...[...m.keys()].filter((id) => !l.has(id))];
      for (const id of b.keys()) if (!order.includes(id)) order.push(id);
      const merged: unknown[] = [];
      for (const id of order) {
        const value = mergeAt(`${path}[${id}]`, b.has(id) ? b.get(id) : MISSING, l.has(id) ? l.get(id) : MISSING, m.has(id) ? m.get(id) : MISSING, out);
        if (value !== MISSING) merged.push(value);
      }
      return merged;
    }
  }
  out.conflicts.push({ path, base: base === MISSING ? undefined : base, latest: latest === MISSING ? undefined : latest, mine: mine === MISSING ? undefined : mine });
  return latest;
}

/** The leaf fields that differ between two versions of one subtree (records by key, id arrays by id), for reports. */
function changedPaths(path: string, before: unknown, after: unknown): string[] {
  if (before !== MISSING && after !== MISSING && valuesEqual(before, after)) return [];
  if (isRecord(before) && isRecord(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      changedPaths(path ? `${path}.${key}` : key, key in before ? before[key] : MISSING, key in after ? after[key] : MISSING),
    );
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const key = idKeyOf(before, after);
    if (key) {
      const b = new Map(before.map((item) => [label(item, key), item]));
      const a = new Map(after.map((item) => [label(item, key), item]));
      return [...new Set([...b.keys(), ...a.keys()])].flatMap((id) =>
        b.has(id) && a.has(id) ? changedPaths(`${path}[${id}]`, b.get(id), a.get(id)) : [`${path}[${id}]`],
      );
    }
  }
  return [path || "(document)"];
}

/** Applies the person's choice for each conflict (default: the server's value) and returns the document to save. */
export function resolveConflicts(base: unknown, latest: unknown, mine: unknown, choices: ReadonlyMap<string, Side>): unknown {
  const first = threeWayMerge(base, latest, mine);
  if (first.conflicts.every((conflict) => (choices.get(conflict.path) ?? "latest") === "latest")) return first.merged;
  // Re-merge with "mine" pinned on the chosen paths: the chosen value wins as if the server had not touched it
  const pinned = new Set(first.conflicts.filter((conflict) => choices.get(conflict.path) === "mine").map((conflict) => conflict.path));
  return pin("", first.merged, mine, pinned);
}

function pin(path: string, merged: unknown, mine: unknown, pinned: ReadonlySet<string>): unknown {
  if (pinned.has(path)) return mine;
  if (isRecord(merged)) {
    const mineRecord = isRecord(mine) ? mine : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(merged)) out[key] = pin(path ? `${path}.${key}` : key, value, mineRecord[key], pinned);
    // A key only "mine" has, pinned as a conflict (the server deleted it, this tab edited it)
    for (const key of Object.keys(mineRecord)) if (!(key in out) && pinned.has(path ? `${path}.${key}` : key)) out[key] = mineRecord[key];
    return out;
  }
  if (Array.isArray(merged) && Array.isArray(mine)) {
    const key = idKeyOf(merged, mine);
    if (key) {
      const mineById = new Map(mine.map((item) => [label(item, key), item]));
      const out = merged.map((item) => pin(`${path}[${label(item, key)}]`, item, mineById.get(label(item, key)), pinned));
      for (const [id, item] of mineById) if (!merged.some((x) => label(x, key) === id) && pinned.has(`${path}[${id}]`)) out.push(item);
      return out;
    }
  }
  return merged;
}
