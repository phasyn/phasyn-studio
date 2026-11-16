// 文件差異：物件逐 key 遞迴展平；陣列視為單一 leaf（與 merge patch「陣列整體替換」一致）。
import { isRecord, joinPath, valuesEqual } from "./json";

export type DiffKind = "added" | "removed" | "changed";

export interface DiffEntry {
  path: string;
  kind: DiffKind;
  before: unknown;
  after: unknown;
}

export function flattenLeaves(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const visit = (current: unknown, path: string) => {
    if (isRecord(current) && Object.keys(current).length > 0) {
      for (const key of Object.keys(current).sort()) {
        if (current[key] !== undefined) visit(current[key], joinPath(path, key));
      }
      return;
    }
    out.set(path, current);
  };
  visit(value, prefix);
  return out;
}

export function diffDocuments(before: unknown, after: unknown, prefix = ""): DiffEntry[] {
  const left = flattenLeaves(before, prefix);
  const right = flattenLeaves(after, prefix);
  const entries: DiffEntry[] = [];
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const hasLeft = left.has(path);
    const hasRight = right.has(path);
    const a = left.get(path);
    const b = right.get(path);
    if (hasLeft && !hasRight) entries.push({ path, kind: "removed", before: a, after: undefined });
    else if (!hasLeft && hasRight) entries.push({ path, kind: "added", before: undefined, after: b });
    else if (!valuesEqual(a, b)) entries.push({ path, kind: "changed", before: a, after: b });
  }
  return entries;
}
