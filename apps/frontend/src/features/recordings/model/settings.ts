// requested／effective／observed 並排：以點路徑展開；陣列整體視為一個值（與 patch「陣列整體替換」一致）。
// 「不存在」與「值為 null」是兩件事，分開呈現。observed 鍵名依 provider，不保證與 requested 同路徑：
// 先比對完整路徑，再比對「唯一」的末段欄位名（並標示為名稱對應），其餘列在未對應清單。

export interface Cell {
  present: boolean;
  value: unknown;
}

export type SettingsRowStatus = "same" | "adjusted" | "requested_only" | "effective_only";

export interface SettingsRow {
  path: string;
  requested: Cell;
  effective: Cell;
  observed: Cell & { matchedBy: "path" | "name" | null; observedPath: string | null };
  status: SettingsRowStatus;
  observedDiffers: boolean;
  /**
   * invoke.*：元件保存的呼叫預設（元件預設），不一定是這次呼叫用的值——這次呼叫的 parameters.* 有同名欄位時以它為準。
   * 有值時描述這次呼叫實際用了什麼；其他列為 null。
   */
  componentDefault: { parameterPath: string; parameter: Cell } | null;
}

/** invoke.* 是元件預設；這次呼叫的值在 parameters.*（Node：invoke 預設疊上本次 parameters）。 */
export function isComponentDefaultPath(path: string): boolean {
  return path.startsWith("invoke.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 展開成「路徑 → 葉值」；空物件保留為葉值（{}），陣列不展開。 */
export function flattenSettings(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (node: unknown, path: string) => {
    if (isPlainObject(node)) {
      const keys = Object.keys(node);
      if (keys.length === 0 && path) {
        out.set(path, node);
        return;
      }
      for (const key of keys) walk(node[key], path ? `${path}.${key}` : key);
      return;
    }
    if (path) out.set(path, node);
  };
  walk(value, prefix);
  return out;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function formatSettingValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value === "" ? '""' : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const cell = (map: Map<string, unknown>, path: string): Cell => ({ present: map.has(path), value: map.get(path) });

export function buildSettingsRows(
  requested: unknown,
  effective: unknown,
  observed: unknown,
): { rows: SettingsRow[]; observedUnmatched: Array<[string, unknown]> } {
  const req = flattenSettings(requested);
  const eff = flattenSettings(effective);
  const obs = flattenSettings(observed);
  const paths = [...new Set([...req.keys(), ...eff.keys()])].sort((a, b) => a.localeCompare(b));

  // 末段欄位名 → 擁有此名稱的路徑（只有唯一時才可用名稱對應）。
  const byLeaf = new Map<string, string[]>();
  for (const path of paths) {
    const leaf = path.split(".").at(-1) ?? path;
    byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), path]);
  }
  const observedFor = new Map<string, { path: string; matchedBy: "path" | "name" }>();
  const unmatched: Array<[string, unknown]> = [];
  for (const [observedPath, value] of obs) {
    if (paths.includes(observedPath)) {
      observedFor.set(observedPath, { path: observedPath, matchedBy: "path" });
      continue;
    }
    const leaf = observedPath.split(".").at(-1) ?? observedPath;
    const candidates = byLeaf.get(leaf) ?? [];
    const target = candidates[0];
    if (candidates.length === 1 && target && !observedFor.has(target)) {
      observedFor.set(target, { path: observedPath, matchedBy: "name" });
      continue;
    }
    unmatched.push([observedPath, value]);
  }

  const rows = paths.map((path): SettingsRow => {
    const r = cell(req, path);
    const e = cell(eff, path);
    const match = observedFor.get(path);
    const o = match ? cell(obs, match.path) : { present: false, value: undefined };
    const status: SettingsRowStatus = !e.present ? "requested_only" : !r.present ? "effective_only" : sameValue(r.value, e.value) ? "same" : "adjusted";
    let componentDefault: SettingsRow["componentDefault"] = null;
    if (isComponentDefaultPath(path)) {
      const parameterPath = `parameters.${path.slice("invoke.".length)}`;
      const parameter = eff.has(parameterPath) ? cell(eff, parameterPath) : cell(req, parameterPath);
      componentDefault = { parameterPath, parameter };
    }
    return {
      path,
      requested: r,
      effective: e,
      observed: { ...o, matchedBy: match?.matchedBy ?? null, observedPath: match?.path ?? null },
      status,
      observedDiffers: o.present && e.present && o.value !== null && !sameValue(o.value, e.value),
      componentDefault,
    };
  });
  return { rows, observedUnmatched: unmatched };
}

/** The type of prompt text ports. */
export const PROMPT_TYPE_ID = "text.prompt.v1";

/** What a redacted export writes in place of a captured input value (records/redact.py: input_summary.<port>.value). */
export const REDACTED_VALUE = "<redacted>";

/**
 * Why an inline input kept only its digest: the recording's capture_prompt was false (the entry says captured: false),
 * the Controller's own recording (it never keeps input values), or no reason was recorded.
 */
export type DigestReason = "capture_off" | "controller" | "unstated";

/** How one port of context.input_summary was recorded. */
export type InputCapture =
  | { kind: "value"; value: unknown }
  | { kind: "redacted" }
  | { kind: "digest"; digest: string; reason: DigestReason }
  | { kind: "file" }
  | { kind: "other" };

export interface InputPort {
  port: string;
  typeId: string | null;
  capture: InputCapture;
  /** The entry's recorded fields other than type_id (path → value), to list it as it was recorded. */
  fields: Array<[string, unknown]>;
}

/**
 * context.input_summary port by port. Every writer keeps one entry per input port with its type_id and either the value
 * (`{type_id, value}`), a SHA-256 digest of it (`{type_id, value_digest}`, with `captured: false` when the recording's
 * capture_prompt was off) or the file's identity (`{type_id, file, metadata?, links?}`); a redacted export replaces the
 * value with "<redacted>". Other shapes are listed as they are (kind "other"); nothing is read from outside the ports.
 */
export function inputPorts(summary: unknown, operation: string): InputPort[] {
  if (!isPlainObject(summary)) return [];
  return Object.entries(summary).map(([port, entry]): InputPort => {
    if (!isPlainObject(entry)) return { port, typeId: null, capture: { kind: "value", value: entry }, fields: [] };
    const { type_id: typeId, ...rest } = entry;
    const fields = [...flattenSettings(rest)];
    const type = typeof typeId === "string" ? typeId : null;
    if ("value" in entry) return { port, typeId: type, capture: entry.value === REDACTED_VALUE ? { kind: "redacted" } : { kind: "value", value: entry.value }, fields };
    if (typeof entry.value_digest === "string") {
      const reason: DigestReason = entry.captured === false ? "capture_off" : operation === "controller" ? "controller" : "unstated";
      return { port, typeId: type, capture: { kind: "digest", digest: entry.value_digest, reason }, fields };
    }
    return { port, typeId: type, capture: isPlainObject(entry.file) ? { kind: "file" } : { kind: "other" }, fields };
  });
}

/** The text of a captured prompt port (text.prompt.v1 holding a string); null for any other port or capture. */
export function capturedPrompt(port: InputPort): string | null {
  return port.typeId === PROMPT_TYPE_ID && port.capture.kind === "value" && typeof port.capture.value === "string" ? port.capture.value : null;
}

/** 從物件中挑出與冷暖、compile、cache、常駐相關的鍵（context 沒有固定欄位，只呈現實際存在者）。 */
export function pickConditionFacts(...sources: Array<Record<string, unknown> | null | undefined>): Array<[string, unknown]> {
  const pattern = /cold|warm|compile|cache|resident|capture|warmup|graph|profil/i;
  const facts: Array<[string, unknown]> = [];
  for (const source of sources) {
    if (!source) continue;
    for (const [path, value] of flattenSettings(source)) if (pattern.test(path)) facts.push([path, value]);
  }
  return facts;
}
