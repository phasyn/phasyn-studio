import { t } from "@/i18n";
// JSON 值的通用工具：判斷、穩定序列化、深比較、不可變路徑更新與顯示用預覽。

export type JsonObject = Record<string, unknown>;
export type PathSegment = string | number;

/** Optional object fields omit missing values while evaluating the supplied expression once. */
export function optionalField<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  const result: Partial<Record<K, V>> = {};
  if (value !== undefined) result[key] = value;
  return result;
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a JSON object without interpreting arrays as records. */
export function toJsonObject(value: unknown): JsonObject | null {
  return isRecord(value) ? value : null;
}

/** Test a persisted or DOM selection against the actual options before using its literal type. */
export function isListed<T>(value: unknown, options: readonly T[]): value is T {
  return options.some((option) => Object.is(option, value));
}

/** Empty text falls through to the next display label. Whitespace is user-supplied content. */
export function nonEmptyText(value: string | null | undefined): string | undefined {
  return value === "" ? undefined : value ?? undefined;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Preserve the first usable frame count; older take records can omit it or store zero. */
export function firstFrameCount(candidates: readonly (number | null | undefined)[], fallback: number): number {
  return candidates.find((value): value is number => typeof value === "number" && value !== 0 && !Number.isNaN(value)) ?? fallback;
}

/** A zero count or an unavailable numeric metric does not create a badge. */
export function isNonzeroNumber(value: number | null | undefined): boolean {
  return value != null && value !== 0 && !Number.isNaN(value);
}

/** JSON.stringify returns undefined for root functions, symbols, undefined, and toJSON results of those types. */
export function stringifyJson(value: unknown, spaces?: number): string | undefined {
  return JSON.stringify(value, null, spaces);
}

/** key 排序後序列化：作為深比較與 React key 的穩定表示。 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return stringifyJson(value) ?? "null";
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** Copy a list on its first changed item. An untouched document retains its identity. */
export function changedItems<T>(items: readonly T[], update: (item: T) => T): T[] | null {
  let result: T[] | null = null;
  for (const [index, current] of items.entries()) {
    const next = update(current);
    if (next !== current) {
      result ??= [...items];
      result[index] = next;
    }
  }
  return result;
}

/** Compare plain JSON object fields by their wire name without promising a value type. */
export function fieldValue(object: object, key: string): unknown {
  return Reflect.get(object, key);
}

/** 深複製（只處理 JSON 值）。 */
export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return structuredClone(value);
}

/** 顯示用路徑：`load.precision.compute_dtype`、`load.part_overrides[0].selector`。 */
export function formatPath(segments: readonly PathSegment[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${String(segment)}]`;
    else out += out.length === 0 ? segment : `.${segment}`;
  }
  return out;
}

export function joinPath(base: string, key: PathSegment): string {
  if (typeof key === "number") return `${base}[${String(key)}]`;
  return base ? `${base}.${key}` : key;
}

/** A field cleared in a form or binding disappears from the JSON object, including at serialization. */
export function withRecordValue<T>(record: Readonly<Record<string, T>>, key: string, value: NoInfer<T> | undefined): Record<string, T> {
  if (value !== undefined) return { ...record, [key]: value };
  const { [key]: _removed, ...remaining } = record;
  return remaining;
}

/** 介面顯示用的短預覽；不是序列化格式。 */
export function previewValue(value: unknown, max = 120): string {
  if (value === undefined) return t("（未設定）");
  if (value === null) return "null";
  const text = typeof value === "string" ? JSON.stringify(value) : stableStringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 安全的字串化（unknown → 文字），避免 [object Object]。 */
export function displayText(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return stringifyJson(value) ?? "—";
}

export interface JsonParseError {
  message: string;
  line: number | null;
  column: number | null;
}

/** 解析 JSON，錯誤時回傳行列位置（若瀏覽器訊息提供）。 */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: JsonParseError } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const lineCol = /line (\d+) column (\d+)/.exec(message);
    if (lineCol?.[1] !== undefined && lineCol[2] !== undefined) {
      return { ok: false, error: { message, line: Number(lineCol[1]), column: Number(lineCol[2]) } };
    }
    const position = /position (\d+)/.exec(message);
    if (position?.[1] !== undefined) {
      const offset = Number(position[1]);
      const before = text.slice(0, offset);
      const line = before.split("\n").length;
      const column = offset - before.lastIndexOf("\n");
      return { ok: false, error: { message, line, column } };
    }
    return { ok: false, error: { message, line: null, column: null } };
  }
}
