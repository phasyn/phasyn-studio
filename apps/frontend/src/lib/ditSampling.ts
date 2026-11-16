// H3 DiT 的採樣參數（步數與 shift）。帶加速 LoRA 的 DiT（PAI、Turbo），元件保存的 invoke 值就是 LoRA 採樣合約要求的值：
// 元件組合或鏡頭固定了別的值時，元件會在 DiT 步驟回 INVALID_ARGUMENT（前面的文字條件、VAE 編碼已經白跑）。
// 沒有 LoRA 的原版 DiT 沒有合約，固定別的步數會照跑——不會失敗，但跑的不是元件預設（例如原版 50 步被固定成 8 步）。
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { isRecord } from "@/lib/json";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export const DIT_PROVIDER = "h3.dit";
export const SAMPLING_KEYS = ["steps", "video_shift", "audio_shift"] as const;
export type SamplingKey = (typeof SAMPLING_KEYS)[number];

const LABELS: Record<SamplingKey, string> = { steps: t("步數"), video_shift: "video shift", audio_shift: "audio shift" };

type Dit = Pick<ComponentDescriptor, "component_id" | "provider_id" | "settings">;

/** 元件保存的 invoke 預設（steps／video_shift／audio_shift）；沒有回報的鍵不列。 */
export function storedSampling(component: Dit): Partial<Record<SamplingKey, number>> {
  const invoke: unknown = component.settings.stored.invoke;
  const out: Partial<Record<SamplingKey, number>> = {};
  if (!isRecord(invoke)) return out;
  for (const key of SAMPLING_KEYS) if (typeof invoke[key] === "number") out[key] = invoke[key];
  return out;
}

/** DiT 是否帶加速 LoRA（有採樣合約）：保存設定的 provider_options.lora 有 manifest_path。 */
export function hasSamplingContract(component: Dit): boolean {
  const load: unknown = component.settings.stored.load;
  const options = isRecord(load) ? load.provider_options : null;
  const lora = isRecord(options) ? options.lora : null;
  return isRecord(lora) && typeof lora.manifest_path === "string" && lora.manifest_path.length > 0;
}

export interface SamplingConflict {
  key: SamplingKey;
  pinned: number;
  expected: number;
  /** true＝LoRA 採樣合約：元件會拒絕；false＝原版 DiT：會照跑但不是元件預設。 */
  blocking: boolean;
}

/** 固定的參數（元件組合步驟或鏡頭覆寫）與 DiT 保存的值不同的鍵。不是 h3.dit 時為空。 */
export function samplingConflicts(pinned: Readonly<Record<string, unknown>>, component: Dit): SamplingConflict[] {
  if (component.provider_id !== DIT_PROVIDER) return [];
  const stored = storedSampling(component);
  const blocking = hasSamplingContract(component);
  return SAMPLING_KEYS.flatMap((key) => {
    const value = pinned[key];
    const expected = stored[key];
    return typeof value === "number" && typeof expected === "number" && value !== expected ? [{ key, pinned: value, expected, blocking }] : [];
  });
}

/** DiT 回報可接受的步數（parameters_schema 的 steps enum，來自綁定 LoRA 的採樣合約）；沒有回報時為 null。 */
export function acceptedSteps(component: Dit): number[] | null {
  if (component.provider_id !== DIT_PROVIDER) return null;
  const properties: unknown = component.settings.parameters_schema.properties;
  const steps = isRecord(properties) ? properties.steps : null;
  const values: unknown = isRecord(steps) ? steps.enum : null;
  if (!Array.isArray(values) || values.length === 0 || !values.every((value) => Number.isInteger(value))) return null;
  return values as number[];
}

/** 這次實際會用的步數不在 DiT 的 LoRA 採樣合約內：說明原因（會在 DiT 步驟被拒絕）；合約允許或沒有回報時為 null。 */
export function stepsContractProblem(steps: number | null, component: Dit): string | null {
  const accepted = acceptedSteps(component);
  if (accepted === null || (steps !== null && accepted.includes(steps))) return null;
  const list = formatList(accepted.map(String));
  return steps === null
    ? t("{componentId} 的 LoRA 採樣合約只接受 {accepted} 步，但鏡頭、元件組合與元件保存設定都沒有指定步數；DiT 步驟會被拒絕，請在「畫質」分頁填入合約步數", { componentId: component.component_id, accepted: list })
    : t("{componentId} 的 LoRA 採樣合約只接受 {accepted} 步，這次會用 {steps} 步；DiT 步驟會被拒絕，請在「畫質」分頁或元件設定改成合約步數", { componentId: component.component_id, accepted: list, steps });
}

/** 一句話說明衝突；where 是「元件組合」或「這個鏡頭」等來源。 */
export function describeConflicts(conflicts: readonly SamplingConflict[], componentId: string, where: string): string {
  const parts = formatList(conflicts.map((item) => t("{key} {pinned}（應為 {expected}）", { key: LABELS[item.key], pinned: item.pinned, expected: item.expected })));
  return conflicts.some((item) => item.blocking)
    ? t("{where}固定的 {parts} 不符合 {componentId} 的 LoRA 採樣合約，DiT 步驟會被拒絕；清空這些參數改用元件預設，或改成合約值", { where, parts, componentId })
    : t("{where}固定的 {parts} 與 {componentId} 的預設不同，會照固定值執行（例如原版 50 步只跑 8 步）；確認是刻意的，否則清空改用元件預設", { where, parts, componentId });
}

/** 移除採樣參數（換 DiT 時用）：回傳新的參數與被移除的值。 */
export function stripSampling(parameters: Readonly<Record<string, unknown>>): { parameters: Record<string, unknown>; removed: Partial<Record<SamplingKey, unknown>> } {
  const next: Record<string, unknown> = {};
  const removed: Partial<Record<SamplingKey, unknown>> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if ((SAMPLING_KEYS as readonly string[]).includes(key)) removed[key as SamplingKey] = value;
    else next[key] = value;
  }
  return { parameters: next, removed };
}

/** 「步數 8、video shift 12」：說明被移除或使用的值。 */
export function formatSampling(values: Partial<Record<SamplingKey, unknown>>): string {
  return formatList(SAMPLING_KEYS.filter((key) => values[key] !== undefined).map((key) => `${LABELS[key]} ${String(values[key])}`));
}
