// The dock log tables' common line model (activity and component events): LogLine, levels and sources, shared text
// helpers, sorting and merging. Times and durations come only from real timestamps (missing → omitted, never 0);
// error codes, ids and log text are kept verbatim. Pure.
import { errorText } from "@/lib/errors";
import { joinInline } from "@/i18n/format";
import { t } from "@/i18n";

export type LogLevel = "debug" | "info" | "warning" | "error" | "success";
export type LogSourceKind = "run" | "step" | "component" | "node" | "controller";

export interface LogSource {
  kind: LogSourceKind;
  label: string;
  /** component／step：provider_id（決定類型圖示與色調）。 */
  providerId?: string;
  /** react-router 路徑（例如 `/records/runs/<run_id>`）。 */
  to?: string;
}

export interface LogLine {
  id: string;
  /** 伺服器給的 UTC ISO 時戳。 */
  at: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  /** 次要資訊（ID、欄位、原因）：換行模式顯示、搜尋涵蓋、不換行時放在 title。 */
  detail?: string;
}

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warning", "error", "success"];

/** 等級 chip 的原始標籤（大寫、不翻譯）。 */
export const LEVEL_LABEL: Record<LogLevel, string> = { debug: "DEBUG", info: "INFO", warning: "WARN", error: "ERROR", success: "OK" };

export const SOURCE_KINDS: readonly LogSourceKind[] = ["run", "step", "component", "node", "controller"];

export const SOURCE_KIND_LABEL: Record<LogSourceKind, string> = { run: "run", step: t("步驟"), component: t("元件"), node: "Node", controller: t("主控") };

export type Part = string | null | undefined | false;

/** 以「・」串接非空片段。 */
/** 並列片段：預設依介面語言的行內分隔（zh-Hant／ja「・」，en “ · ”）；指定 separator 時照用。 */
export function joinParts(parts: readonly Part[], separator?: string): string {
  const texts = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
  return separator === undefined ? joinInline(texts) : texts.join(separator);
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 錯誤碼＋訊息原文（`CODE：message`，同 lib/errors 的 errorText）；沒有錯誤＝null。 */
export function errorLine(error: { code: string; message: string } | null | undefined): string | null {
  return error ? errorText(error) : null;
}

/** 兩個真實時戳之間的毫秒數；任一缺值、無法解析或倒序時回傳 null（不補 0）。 */
export function durationMs(startIso: string | null | undefined, endIso: string | null | undefined): number | null {
  if (!(startIso != null && startIso !== "") || !(endIso != null && endIso !== "")) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** 本地時間 `HH:mm:ss.SSS`；無法解析時回傳 null。 */
export function formatLogTime(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** 本地日期 `YYYY-MM-DD`（跨日分隔列用）；無法解析時回傳 null。 */
export function localDateKey(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 依時間由舊到新排序（最新在最下面，像終端機 log）；同一毫秒保持輸入順序（穩定）。
 * 無法解析的時間排在最前面；相同 id 只保留第一筆。
 */
export function sortLines(lines: readonly LogLine[]): LogLine[] {
  const seen = new Set<string>();
  const decorated: { line: LogLine; at: number; index: number }[] = [];
  lines.forEach((line, index) => {
    if (seen.has(line.id)) return;
    seen.add(line.id);
    const at = Date.parse(line.at);
    decorated.push({ line, at: Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at, index });
  });
  decorated.sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at));
  return decorated.map((item) => item.line);
}

/** 合併多個來源；同時間時前面的來源在前。 */
export function mergeLines(...groups: readonly (readonly LogLine[])[]): LogLine[] {
  return sortLines(groups.flat());
}
