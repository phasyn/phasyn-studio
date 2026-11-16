// 參考素材的編輯（純函式）：在同類參考中調整送出順序。（重新命名素材庫檔案的規則在 model/library：libraryRenameProblem。）
//
// 送出順序＝同類參考依 alias 序號（見 materials），所以把一個參考移到同類的另一個位置（拖曳）＝同類參考依新順序重新分配
// 原本那組 alias（缺號保留）；「上移／下移」是移一格。換號後 prompt 裡的 @ 名稱與直接寫的 H3 標籤（<Picture n>…、影片原聲的
// <Audio n>）要跟著換，才會繼續指向同一個檔案（remapReferenceText）。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { H3_TAG_SOURCE, MENTION_SOURCE } from "../prompt/compile";
import { aliasOrdinal, presentationLabels } from "./materials";

/** 同類參考依 alias 序號排列（送出順序）。 */
function sameKind(references: readonly StudioReference[], kind: StudioReference["kind"]): StudioReference[] {
  return references.filter((ref) => ref.kind === kind).sort((a, b) => (aliasOrdinal(a.alias) ?? 0) - (aliasOrdinal(b.alias) ?? 0));
}

/** 這個參考能不能往前（-1）／往後（1）移：同類中前後還有參考。 */
export function canMoveReference(references: readonly StudioReference[], refId: string, delta: -1 | 1): boolean {
  const ref = references.find((candidate) => candidate.ref_id === refId);
  if (!ref) return false;
  const list = sameKind(references, ref.kind);
  const index = list.findIndex((candidate) => candidate.ref_id === refId);
  return index >= 0 && list[index + delta] !== undefined;
}

/**
 * 把參考移到同類中的第 toIndex 個（0 起算，送出順序；超出範圍時夾到頭尾）：同類參考依新順序重新分配原本那組 alias。
 * 沒有任何 alias 改變（不能移、位置相同）→ null。
 */
export function moveReferenceTo(references: readonly StudioReference[], refId: string, toIndex: number): StudioReference[] | null {
  const ref = references.find((candidate) => candidate.ref_id === refId);
  if (!ref) return null;
  const list = sameKind(references, ref.kind);
  const from = list.findIndex((candidate) => candidate.ref_id === refId);
  const to = Math.max(0, Math.min(list.length - 1, toIndex));
  if (from < 0 || from === to) return null;
  const aliases = list.map((candidate) => candidate.alias);
  const order = list.filter((candidate) => candidate.ref_id !== refId);
  order.splice(to, 0, ref);
  const next = new Map(order.map((candidate, index) => [candidate.ref_id, aliases[index] ?? candidate.alias]));
  const moved = references.map((candidate) => {
    const alias = next.get(candidate.ref_id);
    return alias !== undefined && alias !== candidate.alias ? { ...candidate, alias } : candidate;
  });
  return moved.some((candidate, index) => candidate !== references[index]) ? moved : null;
}

/** 往前（-1）／往後（1）移一格；不能移 → null。 */
export function moveReference(references: readonly StudioReference[], refId: string, delta: -1 | 1): StudioReference[] | null {
  const ref = references.find((candidate) => candidate.ref_id === refId);
  if (!ref) return null;
  const index = sameKind(references, ref.kind).findIndex((candidate) => candidate.ref_id === refId);
  return moveReferenceTo(references, refId, index + delta);
}

/**
 * 參考改了 alias 或送出順序後，把 prompt 裡指向它們的 @ 名稱與 H3 標籤一次換成新的（同時替換，不會連鎖）：
 * 每個參考（ref_id）的舊 alias → 新 alias、舊標籤 → 新標籤。對不到的寫法（不存在的參考、編號未知的原聲）保持原樣。
 */
export function remapReferenceText(
  prompt: string,
  before: readonly StudioReference[],
  after: readonly StudioReference[],
  library: readonly StudioLibraryItem[],
): string {
  const aliases = new Map<string, string>();
  const tags = new Map<string, string>();
  const nextById = new Map(after.map((ref) => [ref.ref_id, ref]));
  const labelsBefore = presentationLabels(before, library);
  const labelsAfter = presentationLabels(after, library);
  for (const ref of before) {
    const next = nextById.get(ref.ref_id);
    if (!next) continue;
    if (next.alias !== ref.alias) aliases.set(ref.alias, next.alias);
    const old = labelsBefore.get(ref.ref_id);
    const now = labelsAfter.get(ref.ref_id);
    if (old && now && old.label !== now.label) tags.set(old.label, now.label);
    const oldSound = old?.soundtrack?.label ?? null;
    const nowSound = now?.soundtrack?.label ?? null;
    if (oldSound && nowSound && oldSound !== nowSound) tags.set(oldSound, nowSound);
  }
  if (aliases.size === 0 && tags.size === 0) return prompt;
  return prompt.replace(new RegExp(`${MENTION_SOURCE}|${H3_TAG_SOURCE}`, "g"), (match, alias: string | undefined) => {
    if (alias !== undefined) {
      const next = aliases.get(alias);
      return next ? `@${next}` : match;
    }
    return tags.get(match) ?? match;
  });
}
