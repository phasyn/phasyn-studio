// @ 參考自動完成（純函式）：游標前的 @ 查詢、候選清單、插入 @Image1。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { aliasLabels, aliasOrdinal, KIND_LABEL, type ReferenceKind } from "../references/materials";

export interface MentionOption {
  alias: string;
  kind: ReferenceKind;
  /** 素材庫檔名；檔案已不在素材庫時為 null。 */
  name: string | null;
  /** 素材庫檔案（候選清單與參考面板的縮圖）；不在素材庫時為 null。 */
  item: StudioLibraryItem | null;
  /** 送給 H3 的標籤（<Picture 1>…）。 */
  label: string | null;
}

export interface MentionQuery {
  /** @ 的位置。 */
  start: number;
  /** 目前已輸入的名稱片段（不含 @）。 */
  query: string;
  /** 名稱片段結尾（游標後面緊接的英數字也算，插入時一起取代）。 */
  end: number;
}

const DISPLAY_ORDER: Record<ReferenceKind, number> = { image: 0, video: 1, audio: 2 };
const NAME_CHAR = /[A-Za-z0-9]/;
const WORD_CHAR = /[A-Za-z0-9_]/;
const MAX_QUERY = 8;

/** 這個鏡頭可插入的參考（顯示順序：圖片 → 影片 → 聲音，各自依 alias 序號；重複的名稱只列一次）。送出順序與標籤見 references/materials。 */
export function mentionOptions(references: readonly StudioReference[], library: readonly StudioLibraryItem[]): MentionOption[] {
  const items = new Map(library.map((item) => [item.item_id, item]));
  const labels = aliasLabels(references);
  const seen = new Set<string>();
  return [...references]
    .sort((a, b) => DISPLAY_ORDER[a.kind] - DISPLAY_ORDER[b.kind] || (aliasOrdinal(a.alias) ?? 0) - (aliasOrdinal(b.alias) ?? 0))
    .filter((ref) => !seen.has(ref.alias) && Boolean(seen.add(ref.alias)))
    .map((ref) => {
      const item = items.get(ref.item_id) ?? null;
      return { alias: ref.alias, kind: ref.kind, name: item?.name ?? null, item, label: labels.get(ref.alias) ?? null };
    });
}

/** 游標正在輸入的 @ 名稱（@ 前面必須是開頭、空白、中文或標點，不能是英數字，例如 email）；沒有 → null。 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  let index = caret - 1;
  while (index >= 0 && caret - index <= MAX_QUERY && NAME_CHAR.test(text[index] ?? "")) index -= 1;
  if (index < 0 || text[index] !== "@") return null;
  const before = index > 0 ? (text[index - 1] ?? "") : "";
  if (WORD_CHAR.test(before)) return null;
  let end = caret;
  while (end < text.length && NAME_CHAR.test(text[end] ?? "")) end += 1;
  return { start: index, query: text.slice(index + 1, caret), end };
}

/** 依輸入片段篩選：alias 開頭相符，或檔名／類型包含（不分大小寫）。 */
export function filterMentions(options: readonly MentionOption[], query: string): MentionOption[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...options];
  return options.filter(
    (option) => option.alias.toLowerCase().startsWith(q) || (option.name ?? "").toLowerCase().includes(q) || option.kind.startsWith(q) || KIND_LABEL[option.kind].includes(q),
  );
}

/** 取代 [start, end) 並回傳新游標位置。 */
export function replaceRange(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}

/** 插入 @alias：取代正在輸入的片段；後面緊接英數字或已到文末時補一個空白，避免黏成別的名稱。 */
export function applyMention(text: string, mention: MentionQuery, alias: string): { text: string; caret: number } {
  const next = text[mention.end];
  const spacer = next === undefined || WORD_CHAR.test(next) ? " " : "";
  return replaceRange(text, mention.start, mention.end, `@${alias}${spacer}`);
}

/**
 * 在游標（或選取範圍之後）插入 @alias；前面緊接英數字時先補空白，否則 @ 不會被認成參考。
 * at＝插入後 @ 的位置（讓自動完成不要對剛插入的名稱再打開候選清單）。
 */
export function insertMentionAt(text: string, selectionEnd: number, alias: string): { text: string; caret: number; at: number } {
  const before = selectionEnd > 0 ? (text[selectionEnd - 1] ?? "") : "";
  const lead = WORD_CHAR.test(before) ? " " : "";
  const next = text[selectionEnd];
  const spacer = next === undefined || WORD_CHAR.test(next) ? " " : "";
  return { ...replaceRange(text, selectionEnd, selectionEnd, `${lead}@${alias}${spacer}`), at: selectionEnd + lead.length };
}

/** 在游標插入一個 @（前面是英數字時先補空白），讓自動完成清單打開。 */
export function insertAtSign(text: string, selectionEnd: number): { text: string; caret: number } {
  const before = selectionEnd > 0 ? (text[selectionEnd - 1] ?? "") : "";
  return replaceRange(text, selectionEnd, selectionEnd, WORD_CHAR.test(before) ? " @" : "@");
}

/** 插入一段文字（固定 Prompt）：選取範圍不刪除，插在選取範圍之後。 */
export function insertSnippetAt(text: string, selectionEnd: number, snippet: string): { text: string; caret: number } {
  return replaceRange(text, selectionEnd, selectionEnd, snippet);
}
