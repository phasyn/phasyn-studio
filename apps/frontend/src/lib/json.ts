import { t } from "@/i18n";
// JSON 值的通用工具：判斷、穩定序列化、深比較、不可變路徑更新與顯示用預覽。

export type JsonObject = Record<string, unknown>;
export type PathSegment = string | number;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return JSON.stringify(value) ?? "null";
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
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
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out.length === 0 ? segment : `.${segment}`;
  }
  return out;
}

export function joinPath(base: string, key: PathSegment): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

export function getPath(value: unknown, segments: readonly PathSegment[]): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment] as unknown;
    } else {
      if (!isRecord(current)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

/** 不可變更新：沿路徑複製物件／陣列並設值；next 為 undefined 時刪除該 key。 */
export function setPath<T>(value: T, segments: readonly PathSegment[], next: unknown): T {
  if (segments.length === 0) return next as T;
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (typeof head === "number") {
    const array: unknown[] = Array.isArray(value) ? [...(value as unknown[])] : [];
    array[head] = setPath(array[head], rest, next);
    return array as T;
  }
  const record: JsonObject = isRecord(value) ? { ...value } : {};
  const child = setPath(record[head], rest, next);
  if (child === undefined) delete record[head];
  else record[head] = child;
  return record as T;
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
  return JSON.stringify(value) ?? "—";
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
    if (lineCol?.[1] && lineCol[2]) {
      return { ok: false, error: { message, line: Number(lineCol[1]), column: Number(lineCol[2]) } };
    }
    const position = /position (\d+)/.exec(message);
    if (position?.[1]) {
      const offset = Number(position[1]);
      const before = text.slice(0, offset);
      const line = before.split("\n").length;
      const column = offset - before.lastIndexOf("\n");
      return { ok: false, error: { message, line, column } };
    }
    return { ok: false, error: { message, line: null, column: null } };
  }
}
