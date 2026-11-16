// 目錄載入：只載入目前語言的 src/i18n/catalogs/<locale>/*.json（Vite 動態 import，各檔獨立 chunk）。
// 單一檔案不存在、讀不到或格式錯就略過該檔（那些原文顯示繁中），不讓整個介面失敗。
import { detectLocale, SOURCE_LOCALE, type Locale } from "./locale";
import { isCatalogEntry, type CatalogEntry } from "./message";
import { activate } from "./store";

export type CatalogLoaders = Readonly<Record<string, () => Promise<unknown>>>;

export interface LoadReport {
  locale: Locale;
  /** 成功載入的檔案（glob 路徑）。 */
  files: string[];
  /** 讀不到或不是 JSON 物件的檔案。 */
  failed: string[];
  /** 格式不對而略過的條目數（空字串、非字串、壞掉的單複數物件）。 */
  invalid: number;
  /** 不同檔案出現同一個原文時，後讀到的覆蓋前者；這裡記下重複數（i18n:check 會擋）。 */
  duplicates: number;
  entries: number;
}

function emptyReport(locale: Locale): LoadReport {
  return { locale, files: [], failed: [], invalid: 0, duplicates: 0, entries: 0 };
}

/** 讀取一種語言的所有目錄檔並合併（檔名排序後依序合併）；純粹依 loaders 運作，方便測試。 */
export async function loadCatalogs(locale: Locale, loaders: CatalogLoaders): Promise<{ entries: Map<string, CatalogEntry>; report: LoadReport }> {
  const report = emptyReport(locale);
  const entries = new Map<string, CatalogEntry>();
  const marker = `/catalogs/${locale}/`;
  const paths = Object.keys(loaders)
    .filter((path) => path.includes(marker) && path.endsWith(".json"))
    .sort();
  const results = await Promise.allSettled(paths.map((path) => loaders[path]?.() ?? Promise.reject(new Error(path))));
  results.forEach((result, index) => {
    const path = paths[index] ?? "";
    const data = result.status === "fulfilled" ? result.value : undefined;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      report.failed.push(path);
      return;
    }
    report.files.push(path);
    for (const [source, entry] of Object.entries(data as Record<string, unknown>)) {
      if (!isCatalogEntry(entry)) {
        report.invalid += 1;
        continue;
      }
      if (entries.has(source)) report.duplicates += 1;
      entries.set(source, entry);
    }
  });
  report.entries = entries.size;
  return { entries, report };
}

const LOADERS: CatalogLoaders = import.meta.glob("./catalogs/*/*.json", { import: "default" });

/**
 * 啟動時呼叫一次（main.tsx 在 import App 之前 await）：決定語言、載入目錄、設定 <html lang>。
 * 不會 reject：任何讀取問題都只讓對應原文顯示繁中。
 */
export async function initI18n(locale: Locale = detectLocale()): Promise<LoadReport> {
  let entries = new Map<string, CatalogEntry>();
  let report = emptyReport(locale);
  if (locale !== SOURCE_LOCALE) {
    try {
      ({ entries, report } = await loadCatalogs(locale, LOADERS));
    } catch {
      report = { ...emptyReport(locale), failed: ["(catalogs)"] };
    }
  }
  activate(locale, entries);
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  if (import.meta.env.DEV && report.failed.length > 0) console.warn("[i18n] 無法載入的目錄檔：", report.failed);
  return report;
}
