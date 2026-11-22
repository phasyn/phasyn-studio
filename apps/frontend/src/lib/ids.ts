import { t } from "@/i18n";
// 本地識別字串（component_id、step_id、pipeline_id、preset_id、port 名稱）的規則與檢查。

export const LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
export const LOCAL_ID_MAX = 160;

/** 回傳繁中錯誤訊息；合法時回傳 null。 */
export function localIdError(value: string, what = "ID"): string | null {
  if (value.length === 0) return t("{what}不可為空", { what });
  if (value.length > LOCAL_ID_MAX) return t("{what}最多 {localIdMax} 個字元", { what, localIdMax: LOCAL_ID_MAX });
  if (!LOCAL_ID_PATTERN.test(value)) return t("{what}只能用英數字與 _ . : -，且須以英數字開頭", { what });
  return null;
}

/** 由任意文字產生合法的本地 ID 片段（模板預設名稱用）。 */
export function slugId(text: string, fallback: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : fallback;
}

/** 在既有名稱集合中找不重複的名稱：name、name-2、name-3…。 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${String(index)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${String(taken.size + 1)}`;
}
