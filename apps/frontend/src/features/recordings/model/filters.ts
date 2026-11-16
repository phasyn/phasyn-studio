import { t } from "@/i18n";
// 紀錄篩選與 URL search params 同步。since／until 在 URL 與 API 都是 UTC RFC3339；
// 輸入框是本地時間（datetime-local），轉換只在這裡做一次。

export const FILTER_KEYS = [
  "node_id",
  "component_id",
  "provider_id",
  "run_id",
  "call_id",
  "part",
  "since",
  "until",
  "error_code",
  "precision",
  "config_digest",
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];
export type RecordingFilters = Partial<Record<FilterKey, string>>;

export const FILTER_LABELS: Record<FilterKey, string> = {
  node_id: "Node",
  component_id: t("元件（component_id）"),
  provider_id: "provider",
  run_id: "run_id",
  call_id: "call_id",
  part: "part",
  since: t("起（本地時間）"),
  until: t("迄（本地時間）"),
  error_code: t("錯誤代碼"),
  precision: t("精度"),
  config_digest: "config_digest",
};

export function filtersFromSearch(params: URLSearchParams): RecordingFilters {
  const filters: RecordingFilters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key)?.trim();
    if (value) filters[key] = value;
  }
  return filters;
}

/** 以新的篩選取代 URL 中的篩選鍵，保留其他鍵（tab、stream 等）。 */
export function withFilters(params: URLSearchParams, filters: RecordingFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of FILTER_KEYS) {
    const value = filters[key]?.trim();
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

export function activeFilterCount(filters: RecordingFilters): number {
  return FILTER_KEYS.filter((key) => Boolean(filters[key])).length;
}

/** 穩定的查詢鍵（鍵順序固定），讓 react-query 快取不因物件鍵序不同而重抓。 */
export function filtersKey(filters: RecordingFilters): RecordingFilters {
  const ordered: RecordingFilters = {};
  for (const key of FILTER_KEYS) if (filters[key]) ordered[key] = filters[key];
  return ordered;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** datetime-local（本地時間）→ UTC RFC3339；空字串回傳 null，格式錯誤丟出 RangeError。 */
export function localInputToUtc(local: string): string | null {
  const trimmed = local.trim();
  if (!trimmed) return null;
  const match = LOCAL_INPUT.exec(trimmed);
  if (!match) throw new RangeError(t("時間格式不正確"));
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0), 0);
  if (Number.isNaN(date.getTime())) throw new RangeError(t("時間格式不正確"));
  return date.toISOString().replace(/\.000Z$/, "Z");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** UTC RFC3339 → datetime-local 值（本地時間，到分；有秒時保留秒）。無法解析回傳空字串。 */
export function utcToLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getSeconds() ? `${base}:${pad(date.getSeconds())}` : base;
}

/** 中欄的明細頁籤（「原始事件」在底部 dock，不是頁籤）。 */
export const CENTER_TABS = ["summary", "timeline", "parts", "settings"] as const;
export type CenterTab = (typeof CENTER_TABS)[number];

/** ?tab= → 中欄頁籤；沒有或不認得的值是摘要。 */
export function parseCenterTab(value: string | null): CenterTab {
  return (CENTER_TABS as readonly string[]).includes(value ?? "") ? (value as CenterTab) : "summary";
}

/** 回到紀錄列表的 search（含「?」）：只保留篩選鍵，不帶 tab、stream 等明細參數。 */
export function listSearch(params: URLSearchParams): string {
  const query = withFilters(new URLSearchParams(), filtersFromSearch(params)).toString();
  return query ? `?${query}` : "";
}
