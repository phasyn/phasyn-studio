// Log filters (levels, source kind, text, "clear view" cutoff) and the filter bar's choices. "Clear view" is only a
// since filter: no server data is deleted. Pure.
import { t } from "@/i18n";
import { LEVEL_LABEL, LOG_LEVELS, SOURCE_KINDS, type LogLevel, type LogLine, type LogSourceKind } from "./lines";

export interface LogFilter {
  /** null＝全部等級。 */
  levels: ReadonlySet<LogLevel> | null;
  source: LogSourceKind | "all";
  query: string;
  /** 「清除畫面」：隱藏此 UTC 時間之前的紀錄（只影響畫面，不刪除伺服器資料）。 */
  since: string | null;
}

export const DEFAULT_LOG_FILTER: LogFilter = { levels: null, source: "all", query: "", since: null };

const haystackCache = new WeakMap<LogLine, string>();

function haystack(line: LogLine): string {
  let text = haystackCache.get(line);
  if (text === undefined) {
    text = [line.message, line.source.label, line.source.providerId ?? "", line.detail ?? ""].join("\n").toLowerCase();
    haystackCache.set(line, text);
  }
  return text;
}

function sinceMs(since: string | null): number | null {
  if (!since) return null;
  const ms = Date.parse(since);
  return Number.isNaN(ms) ? null : ms;
}

/** 在 since 之前（含無法解析的時間）＝已被「清除畫面」隱藏。 */
function beforeSince(line: LogLine, cutoff: number): boolean {
  const at = Date.parse(line.at);
  return Number.isNaN(at) || at < cutoff;
}

/** 等級、來源類型、文字（訊息／來源／細節，不分大小寫）與 since 全部符合才保留；順序不變。 */
export function filterLines(lines: readonly LogLine[], filter: LogFilter): LogLine[] {
  const cutoff = sinceMs(filter.since);
  const query = filter.query.trim().toLowerCase();
  return lines.filter((line) => {
    if (cutoff !== null && beforeSince(line, cutoff)) return false;
    if (filter.levels && !filter.levels.has(line.level)) return false;
    if (filter.source !== "all" && line.source.kind !== filter.source) return false;
    return query === "" || haystack(line).includes(query);
  });
}

/** 「清除畫面」的分界：目前最新一筆之後 1 ms（用伺服器時間，不受瀏覽器時鐘偏差影響）；沒有可用時間時回傳 null。 */
export function clearCutoff(lines: readonly LogLine[]): string | null {
  let newest = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    const at = Date.parse(line.at);
    if (!Number.isNaN(at) && at > newest) newest = at;
  }
  return Number.isFinite(newest) ? new Date(newest + 1).toISOString() : null;
}

/** 被「清除畫面」隱藏的筆數。 */
export function countCleared(lines: readonly LogLine[], since: string | null): number {
  const cutoff = sinceMs(since);
  if (cutoff === null) return 0;
  return lines.reduce((count, line) => count + (beforeSince(line, cutoff) ? 1 : 0), 0);
}

/** 等級、來源或文字篩選是否作用中（不含 since）。 */
export function hasActiveFilters(filter: LogFilter): boolean {
  return filter.levels !== null || filter.source !== "all" || filter.query.trim() !== "";
}

/** 資料中出現的來源類型（固定順序），篩選選單只列實際存在的類型。 */
export function sourceKindsIn(lines: readonly LogLine[]): LogSourceKind[] {
  const present = new Set(lines.map((line) => line.source.kind));
  return SOURCE_KINDS.filter((kind) => present.has(kind));
}

/** 等級選單：單一等級，或「WARN＋ERROR」一起看問題。 */
export type LevelChoice = "all" | "problems" | LogLevel;

export const LEVEL_CHOICES: readonly { value: LevelChoice; label: string }[] = [
  { value: "all", label: t("全部等級") },
  { value: "problems", label: t("WARN＋ERROR") },
  ...LOG_LEVELS.map((level) => ({ value: level, label: LEVEL_LABEL[level] })),
];

export function levelsForChoice(choice: LevelChoice): ReadonlySet<LogLevel> | null {
  if (choice === "all") return null;
  if (choice === "problems") return new Set<LogLevel>(["warning", "error"]);
  return new Set<LogLevel>([choice]);
}

export function choiceForLevels(levels: ReadonlySet<LogLevel> | null): LevelChoice {
  if (levels === null) return "all";
  if (levels.size === 2 && levels.has("warning") && levels.has("error")) return "problems";
  if (levels.size === 1) {
    const [only] = levels;
    if (only) return only;
  }
  return "all";
}

/** 選單字串 → LevelChoice（不認得的值視為全部）。 */
export function parseLevelChoice(value: string): LevelChoice {
  return LEVEL_CHOICES.find((choice) => choice.value === value)?.value ?? "all";
}

/** 選單字串 → 來源類型篩選（不認得的值視為全部）。 */
export function parseSourceChoice(value: string): LogSourceKind | "all" {
  return SOURCE_KINDS.find((kind) => kind === value) ?? "all";
}
