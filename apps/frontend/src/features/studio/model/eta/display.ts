// Display text of render-time estimates (section 9). A plan estimate reads
// 「預估 2 分 45 秒（2:35–3:10）・依本機 37 次紀錄」, with 「僅供參考」 when part of it is approximate. Without an estimate
// the text says why instead of showing a number: no cost profile yet, some steps without one, or request facts missing.
import { formatTime, joinInline } from "@/i18n/format";
import { ETA_UNAVAILABLE, formatEta, type PlanEta, type SegmentEta } from "./segment";
import { t } from "@/i18n";

/** Why there is no estimate. none = no cost profile yet; partial = some steps have none; facts = a reference's size or length is unknown. */
export type EtaMissing = "none" | "partial" | "facts";

/** 「2:35」「1:02:05」: a band edge or a remaining time, as a clock reading. */
export function formatEtaClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, "0");
  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${seconds}` : `${String(minutes)}:${seconds}`;
}

/** 「預估 2 分 45 秒（2:35–3:10）・依本機 37 次紀錄」（approx：加「僅供參考」）. */
export function planEtaText(eta: PlanEta): string {
  const total = formatEta(eta.totalSeconds, { approx: false });
  const head =
    eta.lowSeconds !== null && eta.highSeconds !== null
      ? t("預估 {total}（{low}–{high}）", { total, low: formatEtaClock(eta.lowSeconds), high: formatEtaClock(eta.highSeconds) })
      : t("預估 {total}", { total });
  const records = eta.samples !== null ? [t("依本機 {samples} 次紀錄", { samples: eta.samples })] : [];
  return joinInline([head, ...records, ...(eta.basis === "approx" ? [t("僅供參考")] : [])]);
}

/** One segment's estimate in a table cell: 「預估 1 分 15 秒（1:10–1:30）」 (「僅供參考」 when approximate), or 「尚無預估」. */
export function segmentEtaText(eta: SegmentEta | null | undefined): string {
  if (!eta || eta.basis === "unknown" || eta.basis === "partial") return t("尚無預估");
  const total = formatEta(eta.seconds, { approx: false });
  const head = eta.low !== undefined && eta.high !== undefined ? t("預估 {total}（{low}–{high}）", { total, low: formatEtaClock(eta.low), high: formatEtaClock(eta.high) }) : t("預估 {total}", { total });
  return eta.basis === "approx" ? joinInline([head, t("僅供參考")]) : head;
}

/** The line shown instead of an estimate. */
export function missingEtaText(missing: EtaMissing): string {
  return missing === "none" ? ETA_UNAVAILABLE : t("尚無預估");
}

/** Why, in a few words (after 「尚無預估」 where a render's whole time left would be). */
export function missingEtaReason(missing: EtaMissing): string {
  if (missing === "partial") return t("部分步驟還沒有成本紀錄");
  if (missing === "facts") return t("參考素材的尺寸或長度未知");
  return t("還沒有成本紀錄");
}

/** Why (a tooltip for 「尚無預估」). */
export function missingEtaDetail(missing: EtaMissing): string {
  if (missing === "partial") return t("部分步驟在這台機器還沒有成本紀錄（例如這個元件組合還沒跑過）；只加總其他步驟會低估，所以不估算");
  if (missing === "facts") return t("參考素材的尺寸或長度未知，無法估算運算量");
  return t("這台機器還沒有這些元件的成本紀錄；完成第一次生成後開始估算");
}

/** 「預計 14:32 完成」: a completion moment (local time). */
export function completionText(atMs: number): string {
  return t("預計 {time} 完成", { time: formatTime(atMs, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) });
}
