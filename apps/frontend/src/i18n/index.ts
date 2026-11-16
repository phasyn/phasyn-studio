// i18n 執行期（無外部套件）：原文＝繁體中文。t(原文, params) 以原文查目前語言的目錄，找不到就顯示原文。
// - {name} 內插：值以 String() 轉換（與原本的樣板字串相同）；params 沒有的 {名稱} 原樣保留。
// - 英文單複數：條目可寫成 { one, other, $count }，依 Intl.PluralRules 選擇。
// - 含行內元素的整句用 <T>（src/i18n/T.tsx）；伺服器送來的固定文字用 tServer()。
// - 開發模式下，非原文語言缺少譯文時每個原文只警告一次（正式版不輸出）。
import { INTL_TAGS, SOURCE_LOCALE } from "./locale";
import { catalogKey, interpolate, selectForm, type Params, type TranslateOptions } from "./message";
import { getLocale, lookup } from "./store";

const warned = new Set<string>();

/** 開發模式提示缺少譯文（每個原文一次）。 */
export function warnMissing(source: string): void {
  if (!import.meta.env.DEV || getLocale() === SOURCE_LOCALE || warned.has(source)) return;
  warned.add(source);
  console.warn(`[i18n] ${getLocale()} 缺少譯文：${JSON.stringify(source)}`);
}

/**
 * 原文 → 目前語言的文字（尚未內插）；沒有譯文時回傳原文。
 * 有 context 時只查 `<context>\u0004<原文>`，查不到也回傳原文（不退回不分 context 的譯文：那正是要避免的錯譯）。
 * 不 trim：譯文前後的空白（片段、分隔符號）照原樣保留。
 */
export function translateRaw(source: string, params?: Params, options?: TranslateOptions): string {
  const key = catalogKey(source, options?.context);
  const entry = lookup(key);
  if (entry === undefined) {
    warnMissing(key);
    return source;
  }
  return typeof entry === "string" ? entry : selectForm(entry, params, INTL_TAGS[getLocale()]);
}

/** t("原文", { name: 值 }, { context })：查目前語言的譯文並內插 {name}。 */
export function t(source: string, params?: Params, options?: TranslateOptions): string {
  return interpolate(translateRaw(source, params, options), params);
}

export { initI18n, loadCatalogs, type CatalogLoaders, type LoadReport } from "./load";
export { changeLocale, detectLocale, INTL_TAGS, isLocale, LOCALE_NAMES, LOCALES, SOURCE_LOCALE, type Locale } from "./locale";
export { catalogKey, CONTEXT_SEPARATOR } from "./message";
export type { CatalogEntry, Params, PluralEntry, TranslateOptions } from "./message";
export { hasServerTranslation, tServer } from "./server";
export { getLocale, hasTranslation } from "./store";
