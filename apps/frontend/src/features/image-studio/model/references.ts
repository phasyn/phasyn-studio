// 圖生圖的參考圖片（最多 4 張）：送出順序（order）、底圖（base_index＝排序後的索引，遮罩合成時保留它的畫面）、
// 新增／移除／上下移動，以及送出前的檢查。底圖跟著「那一張圖」走：上下移動時 base_index 會更新成它的新位置。
// 純函式；回傳新的 references／base_index，不改原物件。
import type { ImageLibraryItem, StudioImageReference, StudioImageShot } from "../types";
import { LIMITS } from "./constants";
import { t } from "@/i18n";

export type ReferencePatch = Pick<StudioImageShot, "references" | "base_index">;

/** 依 order 排序（同 order 保持原順序），並把 order 重新編成 0…n-1。 */
export function orderedReferences(references: readonly StudioImageReference[]): StudioImageReference[] {
  return references
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => a.ref.order - b.ref.order || a.index - b.index)
    .map(({ ref }, order) => (ref.order === order ? ref : { ...ref, order }));
}

/** 底圖的 item_id（沒有底圖或索引超出範圍時 null）。 */
export function baseItemId(shot: Pick<StudioImageShot, "references" | "base_index">): string | null {
  if (shot.base_index === null) return null;
  return orderedReferences(shot.references)[shot.base_index]?.item_id ?? null;
}

function withBase(references: StudioImageReference[], baseItem: string | null): ReferencePatch {
  const index = baseItem === null ? -1 : references.findIndex((ref) => ref.item_id === baseItem);
  return { references, base_index: index >= 0 ? index : null };
}

/** 加一張參考圖到最後；已存在或超過 4 張時回傳原因。第一張圖自動成為底圖（第一張＝合成底圖）。 */
export function addReference(shot: Pick<StudioImageShot, "references" | "base_index">, itemId: string): { patch: ReferencePatch; problem: null } | { patch: null; problem: string } {
  const ordered = orderedReferences(shot.references);
  if (ordered.some((ref) => ref.item_id === itemId)) return { patch: null, problem: t("這張圖已經在參考圖片中") };
  if (ordered.length >= LIMITS.references) return { patch: null, problem: t("參考圖片最多 {references} 張", { references: LIMITS.references }) };
  const references = [...ordered, { item_id: itemId, order: ordered.length }];
  const base = baseItemId(shot) ?? (ordered.length === 0 ? itemId : null);
  return { patch: withBase(references, base), problem: null };
}

/** 移除一張參考圖；它若是底圖，底圖改成（新的）第一張；沒有參考圖時沒有底圖。 */
export function removeReference(shot: Pick<StudioImageShot, "references" | "base_index">, itemId: string): ReferencePatch {
  const ordered = orderedReferences(shot.references);
  const references = orderedReferences(ordered.filter((ref) => ref.item_id !== itemId));
  const base = baseItemId(shot);
  if (base !== null && base !== itemId) return withBase(references, base);
  return { references, base_index: base === itemId && references.length > 0 ? 0 : null };
}

/** 上（delta -1）／下（+1）移動；到頭尾時不變（回傳 null）。底圖跟著同一張圖。 */
export function moveReference(shot: Pick<StudioImageShot, "references" | "base_index">, itemId: string, delta: -1 | 1): ReferencePatch | null {
  const ordered = orderedReferences(shot.references);
  const from = ordered.findIndex((ref) => ref.item_id === itemId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ordered.length) return null;
  const items = [...ordered];
  const [moved] = items.splice(from, 1);
  if (!moved) return null;
  items.splice(to, 0, moved);
  return withBase(orderedReferences(items.map((ref, order) => ({ ...ref, order }))), baseItemId(shot));
}

/** 把某一張設為底圖（itemId＝null：不使用底圖）。 */
export function setBaseReference(shot: Pick<StudioImageShot, "references" | "base_index">, itemId: string | null): ReferencePatch {
  return withBase(orderedReferences(shot.references), itemId);
}

/** 圖生圖送出前的問題（擋下生成）；文生圖不檢查（參考圖與遮罩保留在圖片裡但不送出）。 */
export function referenceProblems(shot: StudioImageShot, library: readonly ImageLibraryItem[]): string[] {
  if (shot.mode !== "i2i") return [];
  const problems: string[] = [];
  const items = new Map(library.map((item) => [item.item_id, item]));
  const ordered = orderedReferences(shot.references);
  if (ordered.length === 0) problems.push(t("圖生圖至少需要一張參考圖片（在「圖片」分頁加入）"));
  if (ordered.length > LIMITS.references) problems.push(t("參考圖片最多 {references} 張（目前 {orderedCount}）", { references: LIMITS.references, orderedCount: ordered.length }));
  const seen = new Set<string>();
  ordered.forEach((ref, index) => {
    const label = t("參考圖片 {index}", { index: index + 1 });
    if (seen.has(ref.item_id)) problems.push(t("{label} 重複", { label }));
    seen.add(ref.item_id);
    const item = items.get(ref.item_id);
    if (!item) problems.push(t("{label} 的檔案已不在專案素材庫", { label }));
    else if (item.kind !== "image") problems.push(t("{label}「{name}」不是圖片", { label, name: item.name }));
  });
  if (shot.base_index !== null && (shot.base_index < 0 || shot.base_index >= ordered.length)) problems.push(t("底圖的位置超出參考圖片範圍：重新選擇底圖"));
  if (shot.mask_item_id !== null) {
    const mask = items.get(shot.mask_item_id);
    if (!mask) problems.push(t("遮罩檔案已不在專案素材庫：重新繪製或停用遮罩"));
    else if (mask.kind !== "image") problems.push(t("遮罩不是圖片檔"));
    if (shot.base_index === null) problems.push(t("使用遮罩需要底圖：在參考圖片中選一張「設為底圖」"));
  }
  return problems;
}
