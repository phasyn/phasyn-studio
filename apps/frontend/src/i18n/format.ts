// 依目前介面語言的 Intl 格式：數字、日期時間、相對時間、清單。單位（ms、GiB、fps）與識別字不翻譯。
// 預設的日期時間格式在 zh-Hant 與過去的 toLocaleString("zh-TW", { hour12: false }) 相同（2026/1/5 08:03:04）。
import { INTL_TAGS, SOURCE_LOCALE } from "./locale";
import { getLocale } from "./store";

const numbers = new Map<string, Intl.NumberFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();
const relatives = new Map<string, Intl.RelativeTimeFormat>();
const lists = new Map<string, Intl.ListFormat>();

function memo<T>(cache: Map<string, T>, options: object, make: (tag: string) => T): T {
  const tag = intlTag();
  const key = `${tag}|${JSON.stringify(options)}`;
  let value = cache.get(key);
  if (value === undefined) {
    value = make(tag);
    cache.set(key, value);
  }
  return value;
}

/** 目前語言的 BCP 47 標籤（zh-Hant-TW、ja-JP、en-US）。 */
export function intlTag(): string {
  return INTL_TAGS[getLocale()];
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return memo(numbers, options, (tag) => new Intl.NumberFormat(tag, options)).format(value);
}

const DATE_TIME: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 本地時區的日期＋時間（24 小時制）；無法解析時原樣回傳字串。 */
export function formatDateTime(value: string | number | Date, options: Intl.DateTimeFormatOptions = DATE_TIME): string {
  const date = toDate(value);
  if (!date) return String(value);
  return memo(dates, options, (tag) => new Intl.DateTimeFormat(tag, options)).format(date);
}

/** 本地時區的時間（24 小時制）；無法解析時原樣回傳字串。 */
export function formatTime(value: string | number | Date, options: Intl.DateTimeFormatOptions = TIME): string {
  return formatDateTime(value, options);
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

/** 相對時間（「3 分鐘前」「3 minutes ago」）；以最大的整數單位表示。 */
export function formatRelativeTime(thenMs: number, nowMs: number): string {
  const diff = thenMs - nowMs;
  const format = memo(relatives, { numeric: "auto" }, (tag) => new Intl.RelativeTimeFormat(tag, { numeric: "auto" }));
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= size || unit === "second") return format.format(Math.trunc(diff / size), unit);
  }
  return format.format(0, "second");
}

export interface ListOptions {
  /** conjunction＝「a、b、c」／“a, b, and c”；disjunction＝「a 或 b」／“a or b”；unit＝不加連接詞（“a, b, c”）。 */
  type?: Intl.ListFormatType;
  /** zh-Hant（原文語言）用的分隔符號：輸出與過去的 join(separator) 完全相同。 */
  separator?: string;
}

/** 與 Array.prototype.join 相同的轉換：null／undefined 是空字串。 */
function joinText(item: unknown): string {
  // 與 join 相同的 ToString（物件也一樣變成 "[object Object]"），codemod 改寫前後的輸出才會完全相同
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return item === null || item === undefined ? "" : String(item);
}

/**
 * 介面上的清單：zh-Hant 與過去的 items.join("、")（或指定的 separator）逐字相同；
 * ja、en 依 Intl.ListFormat（ja 一律用「、」，en 加 and／or）。只用於顯示——組 prompt、ID 或要存的資料不要用。
 */
export function formatList(items: readonly unknown[], options: ListOptions = {}): string {
  const texts = items.map(joinText);
  const locale = getLocale();
  if (locale === SOURCE_LOCALE) return texts.join(options.separator ?? "、"); // i18n-ignore（formatList 本身）
  const type = options.type ?? "conjunction";
  if (locale === "ja" && type === "unit") return texts.join("、"); // i18n-ignore（formatList 本身）
  return memo(lists, { type }, (tag) => new Intl.ListFormat(tag, { type })).format(texts);
}

/** 句子內的並列片段（「a・b・c」）：zh-Hant、ja 用「・」，en 用 “ · ”。 */
export function joinInline(parts: readonly unknown[]): string {
  return parts.map(joinText).join(getLocale() === "en" ? " · " : "・"); // i18n-ignore（joinInline 本身）
}
