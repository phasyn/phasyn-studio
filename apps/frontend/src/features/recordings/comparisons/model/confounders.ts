// 混淆因素的可讀呈現：伺服器（phasyn_components.records.compare）的 confounders 是「標籤不同：值 ｜ 值」字串，值是 Python
// str()（例如模型身分是 dict 字串、沒有值是 None）。判定「不同」仍以伺服器為準；這裡依同一個標籤，從頁面已讀到的
// 各 recording context 取出同一個欄位（路徑與 compare.py 相同），逐筆列出可讀的值。不認得的標籤照原文顯示。純函式。
import type { Recording } from "@/api/generated/contracts";
import { flattenSettings, formatSettingValue } from "../../model/settings";
import { isRecord } from "@/lib/json";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

type Context = Recording["context"];

function pick(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return current ?? null;
}

/** compare.py 的 _input_hashes：依名稱排序的「名稱:sha256／value_digest」。 */
function inputHashes(context: Context): string[] {
  const out: string[] = [];
  for (const [name, item] of Object.entries(context.input_summary).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sha = pick(item, "file", "sha256");
    const digest = pick(item, "value_digest");
    if (typeof sha === "string" && sha) out.push(`${name}:${sha}`);
    else if (typeof digest === "string" && digest) out.push(`${name}:${digest}`);
  }
  return out;
}

/**
 * 伺服器的標籤 → 從 context 取值（與 compare.py 的 differs(...) 呼叫一一對應）。
 * key 是伺服器送來的原文，比對時不能翻譯；畫面顯示時用 tServer(label)（伺服器目錄有譯文）。
 */
// i18n-ignore-start
const EXTRACTORS: Record<string, (context: Context) => unknown> = {
  provider: (context) => context.provider_id,
  operation: (context) => context.operation,
  Node: (context) => context.node_id,
  裝置: (context) => pick(context.environment, "device", "id"),
  模型身分: (context) => pick(context.settings, "model_identity"),
  runtime: (context) => pick(context.settings, "runtime_identity"),
  seed: (context) => pick(context.settings, "effective", "parameters", "seed"),
  輸入: (context) => inputHashes(context),
  "recorder 模式": (context) => pick(context.recording, "mode"),
  "trace 設定": (context) => ({ trace_steps: pick(context.recording, "trace_steps"), trace_parts: pick(context.recording, "trace_parts") }),
  "source revision": (context) => pick(context.environment, "source_revision"),
  "compile 設定": (context) => pick(context.settings, "effective", "invoke", "compile"),
  "cache 設定": (context) => pick(context.settings, "effective", "invoke", "cache"),
  "result_cache 設定": (context) => pick(context.settings, "effective", "invoke", "result_cache"),
  "冷／暖（同程序已執行過呼叫）": (context) => pick(context.settings, "observed", "warm"),
};
// i18n-ignore-end

export interface ReadableValue {
  /** 一行摘要（沒有值＝「未記錄」）。 */
  summary: string;
  /** 物件或陣列展開後的「路徑｜值」（只有一個值時為空）。 */
  entries: [string, string][];
}

const SUMMARY_KEYS = ["variant", "identity_strength", "sha256", "model_root", "component_id", "runtime_id", "source_revision"];

function shortPath(text: string): string {
  const parts = text.split("/").filter(Boolean);
  return parts.length > 3 && text.startsWith("/") ? `…/${parts.slice(-2).join("/")}` : text;
}

/**
 * 沒有值（null／undefined）時共用的結果。畫面以 isNotRecorded() 依物件身分判斷「未記錄」，不比對顯示文字
 * （文字之後會翻譯；邏輯不能依賴它）。不要修改這個物件。
 */
const NOT_RECORDED: ReadableValue = { summary: t("未記錄"), entries: [] };

/** 這個值是不是「沒有記錄」（null／undefined），而不是 0、空字串或空物件。 */
export function isNotRecorded(value: ReadableValue): boolean {
  return value === NOT_RECORDED;
}

/** 任意值 → 可讀的摘要與展開列；null／undefined 是「未記錄」，不是 0 或空字串。 */
export function readableValue(value: unknown): ReadableValue {
  if (value === null || value === undefined) return NOT_RECORDED;
  if (typeof value !== "object") return { summary: formatSettingValue(value), entries: [] };
  if (Array.isArray(value)) {
    if (value.length === 0) return { summary: t("（空）"), entries: [] };
    if (value.every((item) => item === null || typeof item !== "object")) return { summary: formatList(value.map((item) => formatSettingValue(item))), entries: [] };
  }
  const flat = [...flattenSettings(value)].map(([path, leaf]): [string, string] => [path, leaf === null || leaf === undefined ? t("未記錄") : formatSettingValue(leaf)]);
  if (flat.length === 0) return { summary: t("（空）"), entries: [] };
  const salient = SUMMARY_KEYS.flatMap((key) => {
    const hit = flat.find(([path]) => path === key);
    return hit ? [`${key} ${key.endsWith("root") ? shortPath(hit[1]) : hit[1]}`] : [];
  });
  const shown = salient.length > 0 ? salient : flat.slice(0, 3).map(([path, text]) => `${path} ${text}`);
  const summary = shown.join(t("・"));
  return { summary: flat.length > shown.length ? t("{summary}…（{flatCount} 個欄位）", { summary, flatCount: flat.length }) : summary, entries: flat };
}

export interface ConfounderDetail {
  /** 伺服器原文。 */
  text: string;
  /** 認得的標籤（例如「模型身分」）；不認得＝null（照原文顯示）。 */
  label: string | null;
  /** 依欄（recording）順序的可讀值；標籤不認得或有 recording 還沒讀到時為 null。 */
  values: ReadableValue[] | null;
}

const LABEL_RE = /^(.+?)不同：/u;

/** confounders × 頁面已讀到的 recording（與比較的欄順序相同）→ 可讀的混淆因素。 */
export function confounderDetails(confounders: readonly string[], contexts: readonly (Context | undefined)[]): ConfounderDetail[] {
  return confounders.map((text) => {
    const label = LABEL_RE.exec(text)?.[1] ?? null;
    const extract = label !== null ? EXTRACTORS[label] : undefined;
    if (!extract || label === null) return { text, label: null, values: null };
    const ready = contexts.every((context): context is Context => context !== undefined);
    return { text, label, values: ready ? contexts.map((context) => readableValue(extract(context))) : null };
  });
}
