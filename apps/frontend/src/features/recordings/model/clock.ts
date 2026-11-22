// monotonic_ns 是十進位字串：一律以 BigInt 解析與相減，不用 Number／Date 解讀（超過 2^53 會失真）。
// 不同 clock_domain 的數字不能互減；同一 domain 內才有相對時間。
import type { RecordingEvent } from "@/api/generated/contracts";

const NS_PATTERN = /^\d{1,32}$/;

/** 解析十進位 ns 字串；格式不符回傳 null（不猜測、不丟例外）。 */
export function parseNs(value: unknown): bigint | null {
  if (typeof value !== "string" || !NS_PATTERN.test(value)) return null;
  return BigInt(value);
}

/** 同一 clock domain 內相對於 base 的毫秒（BigInt 相減後才轉 Number；差值在 ~104 天內精確到 ns）。 */
export function nsToRelMs(base: bigint, value: bigint): number {
  return Number(value - base) / 1_000_000;
}

/** span／transfer 自帶 clock_domain；其他事件依「node_id:process_instance_id」推定（與 context.clock_domain 同格式）。 */
export function eventClockDomain(event: RecordingEvent): { domain: string; derived: boolean } {
  if ((event.kind === "span" || event.kind === "transfer") && event.data.clock_domain) {
    return { domain: event.data.clock_domain, derived: false };
  }
  return { domain: `${event.node_id}:${event.process_instance_id}`, derived: true };
}

/** clock domain 的精簡顯示：「node 前 8 碼 : process 前 8 碼」，完整值另以 title／複製提供。 */
export function shortDomain(domain: string): string {
  const parts = domain.split(":");
  if (parts.length === 2 && (parts[0] != null && parts[0] !== "") && (parts[1] != null && parts[1] !== "")) return `${parts[0].slice(0, 8)}:${parts[1].slice(0, 8)}`;
  return domain.length > 24 ? `${domain.slice(0, 24)}…` : domain;
}
