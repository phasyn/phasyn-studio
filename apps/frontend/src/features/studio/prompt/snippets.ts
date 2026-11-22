// 固定 Prompt 片段庫（純函式）：草稿檢查、新增／修改／刪除（產生下一份要 PUT 的文件）、分類與搜尋。
// PUT 本文的 revision 維持目前值（伺服器成功後 +1）；這裡不碰 revision。
import type { StudioPromptLibrary, StudioPromptSnippet } from "@/api/generated/contracts";
import { t } from "@/i18n";

export const SNIPPET_LIMITS = { title: 200, text: 16384, category: 100, count: 1000 } as const;
/** 分類篩選值（給 <select>）：全部、未分類，或 "cat:" 加分類名稱（前綴避免和使用者的分類名稱相撞）。 */
export const ALL_CATEGORIES = "all:";
export const UNCATEGORIZED = "none:";

export function categoryFilterValue(category: string): string {
  return `cat:${category}`;
}

export interface SnippetDraft {
  title: string;
  text: string;
  /** 空字串＝未分類。 */
  category: string;
}

export function emptyDraft(text = "", title = ""): SnippetDraft {
  return { title, text, category: "" };
}

export function draftOf(snippet: StudioPromptSnippet): SnippetDraft {
  return { title: snippet.title, text: snippet.text, category: snippet.category ?? "" };
}

/** 草稿是否可以保存；可以 → null，否則回傳繁中原因。 */
export function snippetDraftError(draft: SnippetDraft): string | null {
  const title = draft.title.trim();
  if (title.length === 0) return t("名稱不可為空");
  if (Array.from(title).length > SNIPPET_LIMITS.title) return t("名稱最多 {title} 字", { title: SNIPPET_LIMITS.title });
  if (draft.text.trim().length === 0) return t("內容不可為空");
  if (draft.text.length > SNIPPET_LIMITS.text) return t("內容最多 {text} 字元", { text: SNIPPET_LIMITS.text });
  if (Array.from(draft.category.trim()).length > SNIPPET_LIMITS.category) return t("分類最多 {category} 字", { category: SNIPPET_LIMITS.category });
  return null;
}

/** 新增（id 為 null）或修改一筆片段；保留 created_at，更新 updated_at。 */
export function upsertSnippet(
  library: StudioPromptLibrary,
  draft: SnippetDraft,
  options: { id: string | null; now: string; newId: () => string },
): StudioPromptLibrary {
  const category = draft.category.trim();
  const fields = { title: draft.title.trim(), text: draft.text, category: category.length > 0 ? category : null, updated_at: options.now };
  if (options.id !== null) {
    return { ...library, snippets: library.snippets.map((snippet) => (snippet.snippet_id === options.id ? { ...snippet, ...fields } : snippet)) };
  }
  const snippet: StudioPromptSnippet = { snippet_id: options.newId(), created_at: options.now, ...fields };
  return { ...library, snippets: [...library.snippets, snippet] };
}

export function removeSnippet(library: StudioPromptLibrary, snippetId: string): StudioPromptLibrary {
  return { ...library, snippets: library.snippets.filter((snippet) => snippet.snippet_id !== snippetId) };
}

/** 已使用的分類（依名稱排序）。 */
export function snippetCategories(snippets: readonly StudioPromptSnippet[]): string[] {
  return [...new Set(snippets.flatMap((snippet) => ((snippet.category != null && snippet.category !== "") ? [snippet.category] : [])))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
}

/** 依分類篩選值與關鍵字（名稱、內容、分類，不分大小寫）篩選；依分類、名稱排序（未分類最後）。 */
export function filterSnippets(snippets: readonly StudioPromptSnippet[], query: string, category: string = ALL_CATEGORIES): StudioPromptSnippet[] {
  const q = query.trim().toLowerCase();
  return snippets
    .filter((snippet) =>
      category === ALL_CATEGORIES
        ? true
        : category === UNCATEGORIZED
          ? snippet.category === null
          : snippet.category !== null && categoryFilterValue(snippet.category) === category,
    )
    .filter((snippet) => q.length === 0 || [snippet.title, snippet.text, snippet.category ?? ""].some((field) => field.toLowerCase().includes(q)))
    .sort((a, b) => {
      // 未分類排最後
      if ((a.category === null) !== (b.category === null)) return a.category === null ? 1 : -1;
      return (a.category ?? "").localeCompare(b.category ?? "", "zh-Hant") || a.title.localeCompare(b.title, "zh-Hant");
    });
}

/** 片段 ID（契約：本地 ID，英數字開頭）。 */
export function newSnippetId(): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `snip-${Date.now().toString(36)}${(random[0] ?? 0).toString(36)}${(random[1] ?? 0).toString(36)}`;
}

/** 片段內容的單行摘要。 */
export function excerpt(text: string, length = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > length ? `${chars.slice(0, length).join("")}…` : flat;
}
