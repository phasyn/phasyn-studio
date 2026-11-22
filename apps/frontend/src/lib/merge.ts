// SettingsPatch semantics: objects merge recursively, arrays are replaced whole,
// and null is a literal value (not a deletion).
import { cloneJson, isRecord, joinPath, valuesEqual, type JsonObject } from "./json";

/** 套用 patch，回傳新物件；原值不被修改。 */
export function applyMergePatch(target: JsonObject, patch: JsonObject): JsonObject;
export function applyMergePatch(target: unknown, patch: unknown): unknown;
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isRecord(patch) || !isRecord(target)) return cloneJson(patch);
  const out: JsonObject = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isRecord(value) && isRecord(current) ? applyMergePatch(current, value) : cloneJson(value);
  }
  return out;
}

export interface PatchDiff {
  /** 只含變更欄位的 patch；沒有變更時為 undefined。 */
  patch: JsonObject | undefined;
  /** 草稿中被移除、但 merge patch 無法表達的欄位（伺服器會保留原值）。 */
  removedPaths: string[];
}

/** 由「基準 → 草稿」計算最小 merge patch；`applyMergePatch(base, patch)` 會得到草稿（不含被移除的欄位）。 */
export function diffToPatch(base: unknown, draft: unknown, path = ""): PatchDiff {
  if (!isRecord(base) || !isRecord(draft)) {
    if (valuesEqual(base, draft)) return { patch: undefined, removedPaths: [] };
    // 非 object 的根層級無法以 merge patch 表達「整份替換為非 object」：交由呼叫端處理。
    return { patch: isRecord(draft) ? cloneJson(draft) : undefined, removedPaths: [] };
  }
  const patch: JsonObject = {};
  const removedPaths: string[] = [];
  for (const [key, next] of Object.entries(draft)) {
    if (next === undefined) continue;
    const childPath = joinPath(path, key);
    const previous = base[key];
    if (isRecord(next) && isRecord(previous)) {
      const child = diffToPatch(previous, next, childPath);
      if (child.patch) patch[key] = child.patch;
      removedPaths.push(...child.removedPaths);
    } else if (!(key in base) || !valuesEqual(previous, next)) {
      patch[key] = cloneJson(next);
    }
  }
  for (const key of Object.keys(base)) {
    if (base[key] !== undefined && (!(key in draft) || draft[key] === undefined)) removedPaths.push(joinPath(path, key));
  }
  return { patch: Object.keys(patch).length > 0 ? patch : undefined, removedPaths };
}
