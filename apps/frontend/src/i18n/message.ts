// 目錄條目與訊息：{name} 內插、英文單複數（Intl.PluralRules）、條目格式檢查。純函式，不碰 DOM。

/** 單複數條目：依 `$count` 指定的 placeholder（沒有時用 `count`，再沒有時用第一個數字參數）選擇 one／other…。 */
export interface PluralEntry {
  one?: string;
  other: string;
  zero?: string;
  two?: string;
  few?: string;
  many?: string;
  $count?: string;
}

export type CatalogEntry = string | PluralEntry;

/** t() 的參數：值以 String() 轉成文字（與原本樣板字串 `${x}` 的行為相同）。 */
export type Params = Readonly<Record<string, unknown>>;

/**
 * 同形異義的原文（例如「關閉」＝Close／Off）用 context 區分：目錄的 key 是 `<context>` + U+0004 + `<原文>`（gettext 的 msgctxt 寫法，
 * JSON 檔裡顯示成 "toggle-off\u0004關閉"）。沒有 context 的 key 就是原文本身。
 */
export const CONTEXT_SEPARATOR = String.fromCharCode(4);

export interface TranslateOptions {
  context?: string;
}

/** 目錄 key：有 context 時是 `<context>\u0004<原文>`。 */
export function catalogKey(source: string, context?: string): string {
  return (context != null && context !== "") ? `${context}${CONTEXT_SEPARATOR}${source}` : source;
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const PLURAL_FORMS = ["zero", "one", "two", "few", "many", "other"] as const;

/** 依序換掉 {name}；params 沒有的名稱原樣保留（字面上的大括號不會被吃掉）。只掃一次，值裡的 {x} 不會再被替換。 */
export function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

/** 原文或譯文中出現的 placeholder 名稱（依出現順序、不重複）。 */
export function placeholdersOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

export function isCatalogObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPluralEntry(record: unknown): record is PluralEntry {
  if (!isCatalogObject(record)) return false;
  if (typeof record["other"] !== "string") return false;
  for (const [key, form] of Object.entries(record)) {
    if (key === "$count") {
      if (typeof form !== "string") return false;
    } else if (!(PLURAL_FORMS as readonly string[]).includes(key) || typeof form !== "string") {
      return false;
    }
  }
  return true;
}

/** 目錄裡可以用的條目：非空字串，或格式正確的單複數物件。 */
export function isCatalogEntry(value: unknown): value is CatalogEntry {
  return (typeof value === "string" && value !== "") || isPluralEntry(value);
}

function toCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?[\d,]+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim().replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 決定單複數用的數字：`$count` → `count` → 第一個數字參數；都沒有＝null（用 other）。 */
export function pluralCount(entry: PluralEntry, params?: Params): number | null {
  if (!params) return null;
  for (const name of [entry.$count, "count"]) {
    if ((name != null && name !== "") && Object.hasOwn(params, name)) {
      const count = toCount(params[name]);
      if (count !== null) return count;
    }
  }
  for (const value of Object.values(params)) {
    if (typeof value === "number" || typeof value === "bigint") return toCount(value);
  }
  return null;
}

const RULES = new Map<string, Intl.PluralRules>();

function pluralRules(locale: string): Intl.PluralRules {
  let rules = RULES.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    RULES.set(locale, rules);
  }
  return rules;
}

/** 單複數條目 → 這次要用的文字（未內插）；Intl 的類別沒有對應形式時退回 other。 */
export function selectForm(entry: PluralEntry, params: Params | undefined, locale: string): string {
  const count = pluralCount(entry, params);
  if (count === null) return entry.other;
  const category = pluralRules(locale).select(count);
  return entry[category] ?? entry.other;
}
