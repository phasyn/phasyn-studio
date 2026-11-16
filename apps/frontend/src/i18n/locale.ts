// 介面語言：zh-Hant（原文與預設）、ja、en。語言在啟動時決定一次（偏好設定 → 瀏覽器語言 → zh-Hant），
// 切換＝存偏好後重新載入整頁，所以模組層級的常數（標籤表、提示）也是正確語言。
// index.html 的 pre-paint 腳本用同一套規則先設定 <html lang>（改這裡要同步改那裡）。

export type Locale = "zh-Hant" | "ja" | "en";

export const SOURCE_LOCALE: Locale = "zh-Hant";
export const LOCALES: readonly Locale[] = ["zh-Hant", "ja", "en"];
export const LOCALE_STORAGE_KEY = "phasyn.locale";

/** 各語言的自稱（永遠以該語言顯示，不翻譯）。 */
// i18n-ignore-start
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { "zh-Hant": "繁體中文", ja: "日本語", en: "English" };
// i18n-ignore-end

/** Intl（數字、日期、複數規則）用的 BCP 47 標籤。 */
export const INTL_TAGS: Readonly<Record<Locale, string>> = { "zh-Hant": "zh-Hant-TW", ja: "ja-JP", en: "en-US" };

export function isLocale(value: unknown): value is Locale {
  return value === "zh-Hant" || value === "ja" || value === "en";
}

/** 單一語言標籤 → 支援的語言；zh-*（含簡體）一律 zh-Hant；不支援回傳 null。 */
export function matchLocale(tag: string): Locale | null {
  const lower = tag.trim().toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-")) return "zh-Hant";
  if (lower === "ja" || lower.startsWith("ja-")) return "ja";
  if (lower === "en" || lower.startsWith("en-")) return "en";
  return null;
}

/**
 * 有效的偏好設定優先；否則取瀏覽器語言清單裡第一個支援的語言；
 * 清單有內容但都不支援＝en；完全沒有語言資訊＝zh-Hant（原文）。
 */
export function resolveLocale(stored: string | null | undefined, languages: readonly string[]): Locale {
  if (isLocale(stored)) return stored;
  const tags = languages.filter((tag) => typeof tag === "string" && tag.trim() !== "");
  for (const tag of tags) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return tags.length > 0 ? "en" : SOURCE_LOCALE;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 偏好設定（讀不到＝null：私密模式、停用 storage）。 */
export function readStoredLocale(): string | null {
  try {
    return browserStorage()?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** 瀏覽器語言清單（navigator.languages，沒有時用 navigator.language）。 */
export function browserLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  const list = Array.isArray(navigator.languages) ? navigator.languages.filter((tag) => typeof tag === "string") : [];
  if (list.length === 0 && typeof navigator.language === "string" && navigator.language) list.push(navigator.language);
  return list;
}

export function detectLocale(): Locale {
  return resolveLocale(readStoredLocale(), browserLanguages());
}

/** 存偏好；瀏覽器不允許寫入時回傳 false（呼叫端不要重新載入，否則看起來像沒反應）。 */
export function storeLocale(locale: Locale): boolean {
  try {
    const storage = browserStorage();
    if (!storage) return false;
    storage.setItem(LOCALE_STORAGE_KEY, locale);
    return storage.getItem(LOCALE_STORAGE_KEY) === locale;
  } catch {
    return false;
  }
}

/**
 * 切換介面語言：存偏好後重新載入（目前語言或存不進去時不動作並回傳 false）。
 * 有未儲存變更的頁面已註冊 beforeunload，瀏覽器會先詢問；Studio 專案本來就自動儲存。
 */
export function changeLocale(next: Locale, current: Locale): boolean {
  if (next === current || !storeLocale(next)) return false;
  if (typeof window !== "undefined") window.location.reload();
  return true;
}
