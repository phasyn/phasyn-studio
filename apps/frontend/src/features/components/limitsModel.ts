// Component limits (descriptor `limits`): a JSON object kept in the instance definition and read by its consumers
// (for example `limits.swap`, the one-click character swap limits). The Node checks only that it is an object of at most
// 16 KiB serialised; the shape of each entry belongs to its consumer, so this editor validates nothing else. Pure.
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { isRecord, type JsonObject } from "@/lib/json";
import { t } from "@/i18n";

/** The Node's limit on the serialised object (compact JSON, UTF-8). */
export const LIMITS_MAX_BYTES = 16 * 1024;

export type ComponentLimits = ComponentDescriptor["limits"];

/** Text shown in the editor: pretty JSON, or empty for "no limits". */
export function limitsText(limits: ComponentLimits): string {
  return limits === null ? "" : JSON.stringify(limits, null, 2);
}

/** Size as the Node measures it (compact JSON in UTF-8); the server stays authoritative. */
export function limitsBytes(value: Readonly<Record<string, unknown>>): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export type LimitsParse = { ok: true; value: JsonObject | null; bytes: number } | { ok: false; error: string };

/** Editor text → limits: empty clears them; otherwise a JSON object of at most LIMITS_MAX_BYTES. */
export function parseLimits(text: string): LimitsParse {
  if (!text.trim()) return { ok: true, value: null, bytes: 0 };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: t("不是有效的 JSON：{message}", { message: error instanceof Error ? error.message : String(error) }) };
  }
  if (!isRecord(value)) return { ok: false, error: t("使用上限必須是 JSON 物件（例如 {\"swap\": {…}}）；要清除請留空") };
  const bytes = limitsBytes(value);
  if (bytes > LIMITS_MAX_BYTES) return { ok: false, error: t("序列化後 {bytes} bytes，超過上限 {max} bytes（16 KiB）", { bytes, max: LIMITS_MAX_BYTES }) };
  return { ok: true, value, bytes };
}
