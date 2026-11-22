// H3 DiT 的 LoRA 串接（provider_options.loras）：清單操作、從 provider 回報的 facts.lora_catalog 判斷每一項是加速
// LoRA 還是疊加的風格／概念 LoRA，以及送出前就看得出來的衝突（伺服器仍是最後的判斷）。純函式。
import { isRecord, type JsonObject } from "@/lib/json";

export const LORA_STACK_CONTROL = "lora_stack";
/** 一個 DiT 最多串接幾個 LoRA（= recipe/adapter/loras.py MAX_STACK）。 */
export const MAX_LORA_STACK = 4;
export const SCALE_MIN = -4;
export const SCALE_MAX = 4;

export type LoraRole = "acceleration" | "style";

export interface LoraCatalogEntry {
  manifest_path: string;
  lora_id: string;
  label: string;
  role: LoraRole;
  format: string;
  variants: string[];
  steps: number[];
  fixed_scale: number | null;
}

export interface LoraStackEntry {
  manifest_path: string;
  scale?: number;
  /** 其他欄位（merge_mode、dynamic_chunk_tokens）原樣保留。 */
  [key: string]: unknown;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** facts.lora_catalog → 型別正確的項目；格式不對的項目略過。 */
export function parseCatalog(facts: unknown): LoraCatalogEntry[] {
  const raw = isRecord(facts) ? facts["lora_catalog"] : null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown): LoraCatalogEntry[] => {
    if (!isRecord(item) || typeof item["manifest_path"] !== "string" || typeof item["lora_id"] !== "string") return [];
    const role = item["role"] === "acceleration" ? "acceleration" : "style";
    const steps = Array.isArray(item["steps"]) ? item["steps"].filter((s: unknown): s is number => typeof s === "number" && Number.isInteger(s)) : [];
    return [
      {
        manifest_path: item["manifest_path"],
        lora_id: item["lora_id"],
        label: typeof item["label"] === "string" ? item["label"] : item["lora_id"],
        role,
        format: typeof item["format"] === "string" ? item["format"] : "",
        variants: stringList(item["variants"]),
        steps,
        fixed_scale: typeof item["fixed_scale"] === "number" ? item["fixed_scale"] : null,
      },
    ];
  });
}

/** 目前的串接清單（不是清單、或項目不是物件時略過）。 */
export function stackEntries(value: unknown): LoraStackEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown): LoraStackEntry[] =>
    isRecord(item) && typeof item["manifest_path"] === "string" ? [{ ...item, manifest_path: item["manifest_path"] }] : [],
  );
}

/** 單一 LoRA 欄位（provider_options.lora）有設定時的內容；沒有時為 null。 */
export function legacyEntry(options: JsonObject): LoraStackEntry | null {
  const lora = options["lora"];
  return isRecord(lora) && typeof lora["manifest_path"] === "string" && lora["manifest_path"] !== "" ? { ...lora, manifest_path: lora["manifest_path"] } : null;
}

export function findCatalog(catalog: readonly LoraCatalogEntry[], manifestPath: string): LoraCatalogEntry | null {
  return catalog.find((entry) => entry.manifest_path === manifestPath) ?? null;
}

/** 清單空了就回 null（provider_options.loras 允許 null；settings patch 不能刪欄位）。 */
export function normalizeStack(entries: readonly LoraStackEntry[]): LoraStackEntry[] | null {
  return entries.length === 0 ? null : entries.map((entry) => ({ ...entry }));
}

export function addEntry(entries: readonly LoraStackEntry[], manifestPath: string, catalog: readonly LoraCatalogEntry[]): LoraStackEntry[] {
  if (entries.length >= MAX_LORA_STACK) return [...entries];
  const known = findCatalog(catalog, manifestPath);
  return [...entries, { manifest_path: manifestPath, scale: known?.fixed_scale ?? 1 }];
}

export function removeEntry(entries: readonly LoraStackEntry[], index: number): LoraStackEntry[] {
  return entries.filter((_entry, i) => i !== index);
}

/** 與相鄰項目交換（delta = -1 往上、+1 往下）；超出範圍不動。 */
export function moveEntry(entries: readonly LoraStackEntry[], index: number, delta: -1 | 1): LoraStackEntry[] {
  const target = index + delta;
  if (index < 0 || index >= entries.length || target < 0 || target >= entries.length) return [...entries];
  const next = [...entries];
  const moved = next[index];
  const other = next[target];
  if (moved === undefined || other === undefined) return [...entries];
  next[index] = other;
  next[target] = moved;
  return next;
}

export function updateEntry(entries: readonly LoraStackEntry[], index: number, patch: Partial<LoraStackEntry>): LoraStackEntry[] {
  return entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
}

/** 把單一 LoRA 欄位搬進串接清單（lora 設為 null、內容成為 loras 的第一項）。 */
export function convertLegacy(options: JsonObject): JsonObject {
  const legacy = legacyEntry(options);
  if (legacy === null) return options;
  return { ...options, lora: null, loras: [legacy, ...stackEntries(options["loras"])].slice(0, MAX_LORA_STACK) };
}

export type StackProblem =
  | { kind: "both_forms" }
  | { kind: "accelerators"; ids: string[] }
  | { kind: "duplicate"; manifestPath: string }
  | { kind: "variant"; manifestPath: string; variants: string[] }
  | { kind: "fixed_scale"; manifestPath: string; fixed: number }
  | { kind: "zero_scale"; manifestPath: string }
  | { kind: "too_many" };

/** 送出前就看得出來的問題（目錄沒有的 manifest 不判斷角色，交給伺服器）。 */
export function stackProblems(entries: readonly LoraStackEntry[], catalog: readonly LoraCatalogEntry[], options: { variant: string | null; legacy: boolean }): StackProblem[] {
  const out: StackProblem[] = [];
  if (options.legacy && entries.length > 0) out.push({ kind: "both_forms" });
  if (entries.length > MAX_LORA_STACK) out.push({ kind: "too_many" });
  const seen = new Set<string>();
  const accelerators: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.manifest_path)) out.push({ kind: "duplicate", manifestPath: entry.manifest_path });
    seen.add(entry.manifest_path);
    const known = findCatalog(catalog, entry.manifest_path);
    const scale = typeof entry.scale === "number" ? entry.scale : 1;
    if (scale === 0) out.push({ kind: "zero_scale", manifestPath: entry.manifest_path });
    if (!known) continue;
    if (known.role === "acceleration") accelerators.push(known.lora_id);
    if (options.variant !== null && known.variants.length > 0 && !known.variants.includes(options.variant)) {
      out.push({ kind: "variant", manifestPath: entry.manifest_path, variants: known.variants });
    }
    if (known.fixed_scale !== null && scale !== known.fixed_scale) out.push({ kind: "fixed_scale", manifestPath: entry.manifest_path, fixed: known.fixed_scale });
  }
  if (entries.length > 1 && accelerators.length > 1) out.push({ kind: "accelerators", ids: accelerators });
  return out;
}

/** 目錄中可加入的項目：符合目前 variant、不在清單中；加速 LoRA 已有一個時只列風格 LoRA。 */
export function addableCatalog(entries: readonly LoraStackEntry[], catalog: readonly LoraCatalogEntry[], variant: string | null): LoraCatalogEntry[] {
  const used = new Set(entries.map((entry) => entry.manifest_path));
  const hasAccelerator = entries.some((entry) => findCatalog(catalog, entry.manifest_path)?.role === "acceleration");
  return catalog.filter(
    (entry) =>
      !used.has(entry.manifest_path) &&
      (variant === null || entry.variants.length === 0 || entry.variants.includes(variant)) &&
      !(hasAccelerator && entry.role === "acceleration"),
  );
}
