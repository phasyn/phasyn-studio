// 伺服器原樣送來的固定文字（schema 的 title／description、port 說明、part reason、notes、metric rule…）：
// 與目錄裡的原文完全相同才換成譯文，否則原樣顯示。不內插、不修改原文；動態訊息（含數字的錯誤）不會相符，照原文顯示。
import { lookup } from "./store";

export function tServer(text: string): string;
export function tServer(text: string | null | undefined): string | null | undefined;
export function tServer(text: string | null | undefined): string | null | undefined {
  if (typeof text !== "string" || text === "") return text;
  const entry = lookup(text);
  if (entry === undefined) return text;
  return typeof entry === "string" ? entry : entry.other;
}

/** 這段伺服器文字目前有沒有譯文（顯示「原文」對照時用）。 */
export function hasServerTranslation(text: string | null | undefined): boolean {
  return typeof text === "string" && text !== "" && lookup(text) !== undefined;
}
