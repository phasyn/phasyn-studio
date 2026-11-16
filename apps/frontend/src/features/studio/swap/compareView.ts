// The segment check in plain words (pure): the verdict's badge, its line and what to try, and the readings of the three
// numbers. The thresholds are compare.ts's.
import { LAYOUT_FOLLOWS, LAYOUT_OFF, MOTION_RANGE, type SegmentComparison } from "./compare";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

/** Cuts closer than this (seconds) count as the same cut. */
export const CUT_TOLERANCE_SECONDS = 0.5;

export type CheckTone = "success" | "warning" | "danger";

export interface VerdictView {
  /** Short badge text. */
  label: string;
  tone: CheckTone;
  /** One line in plain words, with what to try when the segment drifts. */
  line: string;
}

export const ratioText = (value: number) => value.toFixed(2);

/** The badge and the line of a finished check. */
export function verdictView(metrics: SegmentComparison): VerdictView {
  const layout = ratioText(metrics.layout);
  switch (metrics.verdict) {
    case "follows":
      return { label: t("跟上原片"), tone: "success", line: t("構圖與動作速度都跟上原片。") };
    case "layout_off":
      return { label: t("構圖偏離"), tone: "danger", line: t("構圖和原片對不上（相符度 {layout}）：到「鏡頭」改寫這一段的畫面描述，或重新渲染換一個 seed。", { layout }) };
    case "partly":
      return { label: t("部分跟上"), tone: "warning", line: t("只有部分跟上原片（相符度 {layout}）：看下面的對照找出偏離的秒數，到「鏡頭」把那幾秒的畫面寫清楚，或重新渲染換一個 seed。", { layout }) };
    case "motion_off": {
      const ratio = ratioText(metrics.motionRatio ?? 1);
      return (metrics.motionRatio ?? 1) < MOTION_RANGE.min
        ? { label: t("動作偏慢"), tone: "warning", line: t("動作比原片慢（約 {ratio} 倍）：到「鏡頭」在畫面描述寫明動作的速度與節奏（例如「快速連續出拳」），或重新渲染換一個 seed。", { ratio }) }
        : { label: t("動作偏快"), tone: "warning", line: t("動作比原片快（約 {ratio} 倍）：到「鏡頭」在畫面描述把動作寫得緩一些（例如「慢慢轉身」），或重新渲染換一個 seed。", { ratio }) };
    }
  }
}

/** How a layout value reads: follows / partly / off. */
export function layoutReading(value: number): { text: string; tone: CheckTone } {
  if (!Number.isFinite(value)) return { text: t("無法計算"), tone: "warning" };
  if (value >= LAYOUT_FOLLOWS) return { text: t("相符"), tone: "success" };
  if (value >= LAYOUT_OFF) return { text: t("部分相符"), tone: "warning" };
  return { text: t("偏離"), tone: "danger" };
}

/** 構圖相符度: the value and how it reads, with the scale. */
export function layoutText(value: number): string {
  return t("{value}（{reading}；{follows} 以上算跟上，{off} 以下算偏離）", { value: ratioText(value), reading: layoutReading(value).text, follows: LAYOUT_FOLLOWS, off: LAYOUT_OFF });
}

/** 動作速度（生成÷原版）. */
export function motionText(ratio: number | null): string {
  if (ratio === null) return t("無法判斷（原片幾乎沒有動作）");
  const reading = ratio < MOTION_RANGE.min ? t("偏慢") : ratio > MOTION_RANGE.max ? t("偏快") : t("正常");
  return t("{ratio} 倍（{reading}；{min}–{max} 倍算正常）", { ratio: ratioText(ratio), reading, min: MOTION_RANGE.min, max: MOTION_RANGE.max });
}

const cutTimes = (cuts: readonly number[], fps: number) => (cuts.length > 0 ? formatList(cuts.map((frame) => t("{seconds} 秒", { seconds: (frame / fps).toFixed(2) }))) : t("沒有"));

/** 切鏡（原版／生成）: the counts and where they fall. */
export function cutsText(metrics: SegmentComparison, fps: number): string {
  return t("{original}／{take}（原版：{originalTimes}；生成：{takeTimes}）", {
    original: metrics.cutsOriginal.length,
    take: metrics.cutsTake.length,
    originalTimes: cutTimes(metrics.cutsOriginal, fps),
    takeTimes: cutTimes(metrics.cutsTake, fps),
  });
}

/** A note when the cuts do not line up (count, or time by more than CUT_TOLERANCE_SECONDS); null when they do. */
export function cutsNote(metrics: SegmentComparison, fps: number): string | null {
  const { cutsOriginal, cutsTake } = metrics;
  if (cutsOriginal.length !== cutsTake.length) {
    return t("切鏡數和原片不同（原版 {original} 個、生成 {take} 個）：確認這段 prompt 寫了原片的切鏡時間（[Shot n]），或重新渲染換一個 seed。", { original: cutsOriginal.length, take: cutsTake.length });
  }
  const apart = Math.max(0, ...cutsOriginal.map((frame, index) => Math.abs(frame - (cutsTake[index] ?? frame)) / fps));
  if (apart <= CUT_TOLERANCE_SECONDS) return null;
  return t("切鏡時間和原片差了約 {seconds} 秒：確認這段 prompt 的 [Shot n] 時間，或重新渲染換一個 seed。", { seconds: apart.toFixed(2) });
}
