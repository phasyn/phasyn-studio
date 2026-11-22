// The one time format of the Render workspace (audit F-12). A measured duration reads 「0.67 秒」 under a second,
// 「11.9 秒」 under a minute and 「5:32」 (「1:02:05」 from an hour) above; its exact value goes in a tooltip. A time left
// is an estimate: it always reads as a clock in whole seconds (「剩 9:23」), and an estimated share of the run is never
// shown as 0% or 100%. Media lengths keep the Studio's own format (model/frames formatDuration) and timecodes stay
// timecodes, so a take reads the same here as in the shot list.
import { t } from "@/i18n";
import { formatEtaClock } from "../../model/eta";

/** A measured duration; null (not measured) reads 「—」, never 0. */
export function formatSpan(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, ms) / 1000;
  const hundredths = Math.round(seconds * 100);
  if (hundredths < 1) return t("不到 0.01 秒");
  if (hundredths < 100) return t("{value} 秒", { value: (hundredths / 100).toFixed(2) });
  const tenths = Math.round(seconds * 10);
  if (tenths < 600) return t("{value} 秒", { value: (tenths / 10).toFixed(1) });
  return formatEtaClock(seconds);
}

/** The exact value behind formatSpan, for its tooltip: 「11.912 秒」, or 「20:31・1231.328 秒」 from a minute. */
export function formatSpanExact(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return t("未量測");
  const seconds = Math.max(0, ms) / 1000;
  const exact = t("{value} 秒", { value: seconds.toFixed(3) });
  return seconds < 60 ? exact : t("{clock}・{exact}", { clock: formatEtaClock(seconds), exact });
}

/** A time left (an estimate, in seconds) as a clock: 「9:23」, 「0:45」, 「1:02:05」. */
export function formatLeft(seconds: number): string {
  return formatEtaClock(seconds);
}

/**
 * An estimated share of a running render (0–1) as a percentage: floored, at most 99% while it runs and 「<1%」 at the
 * very start, so an estimate never claims a finished or an untouched render.
 */
export function estimatedPercent(share: number): string {
  if (!Number.isFinite(share) || share < 0.01) return "<1%";
  return `${String(Math.min(99, Math.floor(share * 100)))}%`;
}
