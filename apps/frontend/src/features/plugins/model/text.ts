// 插件的顯示文字（名稱、標籤、說明、規則訊息）：依語言分開的資料，不是介面字串，所以不進翻譯目錄。
// 顯示順序（契約 StudioPluginLabel／StudioPluginText）：介面語言 → en → zh-Hant → 其餘任一種。
import type { StudioPluginLabel, StudioPluginText } from "@/api/generated/contracts";
import { getLocale, type Locale } from "@/i18n";

export type PluginLocalizedText = StudioPluginLabel | StudioPluginText;

const FALLBACK_ORDER: readonly Locale[] = ["en", "zh-Hant", "ja"];

export interface ResolvedPluginText {
  text: string;
  /** 實際取用的語言；用了 fallback 字串（沒有任何語言的文字）時為 null。 */
  lang: Locale | null;
}

/** 依顯示順序取出文字與它的語言；一種語言都沒有時回傳 fallback（通常是 id）。 */
export function resolvePluginText(source: PluginLocalizedText | null | undefined, fallback = "", locale: Locale = getLocale()): ResolvedPluginText {
  if (source) {
    for (const lang of [locale, ...FALLBACK_ORDER]) {
      const value = source[lang];
      if (typeof value === "string" && value !== "") return { text: value, lang };
    }
  }
  return { text: fallback, lang: null };
}

/** 插件文字在目前介面語言下的顯示字串。 */
export function pluginText(source: PluginLocalizedText | null | undefined, fallback = ""): string {
  return resolvePluginText(source, fallback).text;
}

/** 搜尋用：所有語言的文字接在一起（小寫）。 */
export function pluginTextHaystack(source: PluginLocalizedText | null | undefined): string {
  if (!source) return "";
  return FALLBACK_ORDER.map((lang) => source[lang] ?? "")
    .join("\n")
    .toLocaleLowerCase();
}
