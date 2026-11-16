// 目前語言與已載入的目錄（啟動時設定一次；切換語言＝重新載入整頁）。
import { SOURCE_LOCALE, type Locale } from "./locale";
import type { CatalogEntry } from "./message";

let active: Locale = SOURCE_LOCALE;
let entries: ReadonlyMap<string, CatalogEntry> = new Map();

export function getLocale(): Locale {
  return active;
}

/** 原文 → 條目；沒有譯文（或目前是原文語言）回傳 undefined。 */
export function lookup(source: string): CatalogEntry | undefined {
  return entries.get(source);
}

export function hasTranslation(source: string): boolean {
  return entries.has(source);
}

export function catalogSize(): number {
  return entries.size;
}

/** 啟用語言與目錄（initI18n 與測試用）。 */
export function activate(locale: Locale, next: ReadonlyMap<string, CatalogEntry>): void {
  active = locale;
  entries = next;
}
