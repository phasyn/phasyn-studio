// 執行時間（run／step 的 UTC RFC3339 時戳）；recording 的 monotonic_ns 不走這裡。
import { useEffect, useState } from "react";
import { formatMs } from "./format";

export function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/** 已結束：finished−started；進行中：now−started；無起點：null。 */
export function elapsedMs(startIso: string | null | undefined, endIso: string | null | undefined, nowMs: number | null): number | null {
  const start = isoToMs(startIso);
  if (start === null) return null;
  const end = isoToMs(endIso) ?? nowMs;
  if (end === null) return null;
  return Math.max(0, end - start);
}

export function formatElapsed(ms: number | null): string {
  return ms === null ? "—" : formatMs(ms);
}

/** 每 intervalMs 更新一次的現在時間（只在 active 時計時，避免無謂 render）。 */
export function useNow(active: boolean, intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, intervalMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [active, intervalMs]);
  return active ? now : null;
}
