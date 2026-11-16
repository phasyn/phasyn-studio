// The speed-feel analysis in plain words (pure): the verdict, the accents' kinds and what became of each, the clip's
// flags, the rough photosensitivity check and the name of the history step. Frames are shown through `at` (the
// caller's clock: the sequence's timecode). The thresholds are analysis.ts's.
import type { StudioProject, StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { placedShotIds } from "../editor/model";
import { findSwapJob } from "../swap/job";
import { formatCueTime } from "../swap/prompt";
import {
  ACCENT_SPACING,
  COVERED_SHARE,
  EDIT_RHYTHM_MIN,
  FLASHES_PER_SECOND_LIMIT,
  MIN_STRENGTH,
  STILL_TAKE_RATIO,
  STROBE_MAX_IMPACTS,
  STROBE_MIN_STRENGTH,
  type AccentDecision,
  type AccentEffects,
  type AccentKind,
  type SpeedFeelAnalysis,
} from "./analysis";

export type FeelTone = "info" | "success" | "warning";

export interface FeelVerdictView {
  /** A few words (the Effect Controls group, a badge). */
  label: string;
  tone: FeelTone;
  /** The verdict in one or two sentences, with what to do. */
  line: string;
}

const ratio = (value: number) => value.toFixed(1);

/** A moment of the original (seconds) as mm:ss.mmm. */
export const cueTime = (seconds: number) => formatCueTime(Math.round(seconds * 1000), 1000);
const REGENERATE = () => t("請重新生成：換一個 seed、在畫面描述寫明動作與節奏，或調整參考視窗。");

export function kindLabel(kind: AccentKind): string {
  switch (kind) {
    case "action":
      // The motion sense of 動作 (the bare word is the common catalog's "actions" menu)
      return t("動作", undefined, { context: "motion" });
    case "flash":
      return t("閃光");
    case "twos":
      return t("一拍二快速動作");
    case "edit":
      return t("剪接");
  }
}

/** The frames in a sentence: 「00:00:01:12、00:00:01:15」. */
const framesText = (frames: readonly number[], at: (frame: number) => string) => formatList(frames.map(at));

export function verdictView(analysis: SpeedFeelAnalysis, at: (frame: number) => string): FeelVerdictView {
  const take = ratio(analysis.take.p90);
  const original = ratio(analysis.original.p90);
  switch (analysis.verdict) {
    case "quiet":
      return { label: t("原片幾乎不動"), tone: "success", line: t("原片這段幾乎沒有動作（動作量 p90 {original}），不需要加速度感效果。", { original }) };
    case "moves_enough":
      return { label: t("不需要加"), tone: "success", line: t("生成已經動得和原片一樣多（動作量 p90：生成 {take}，原片 {original}），不需要加效果。", { take, original }) };
    case "add":
      return { label: t("建議加 {count} 個衝擊", { count: analysis.hits.length }), tone: "info", line: t("原片有 {count} 個重音生成沒有打到：在這些影格切開片段並加上效果。片段總長不變，和聲音保持同步。", { count: analysis.hits.length }) };
    case "covered":
      return { label: t("已經打到"), tone: "success", line: t("原片的重音生成都已經打到了（那幾格生成自己就有大變化），不需要加效果。") };
    case "edits":
      return { label: t("速度感來自剪接"), tone: "warning", line: t("原片在一秒內切了 {count} 刀以上，速度感來自剪接：生成的一個連續鏡頭做不出來，加效果也補不了。請重新分段，或把這段改成多個鏡頭。", { count: EDIT_RHYTHM_MIN }) };
    case "regenerate":
      return {
        label: t("要重新生成"),
        tone: "warning",
        line:
          analysis.flags.needsGeneration.length > 0
            ? t("原片在 {frames} 是一拍二的快速動作，生成在那裡幾乎沒動：效果補不了缺少的動作。{advice}", { frames: framesText(analysis.flags.needsGeneration, at), advice: REGENERATE() })
            : t("生成幾乎沒有動（動作量 p90：生成 {take}，原片 {original}），原片也沒有可以對準的重音：效果補不了缺少的動作。{advice}", { take, original, advice: REGENERATE() }),
      };
    case "no_accents":
      return { label: t("沒有重音"), tone: "success", line: t("原片這段沒有夠強的重音（強度 {min} 以上的動作或閃光），不需要加效果。", { min: MIN_STRENGTH }) };
  }
}

/** The effects of one hit: 「震動 20 px（8 影格）、1 格負片衝擊格」. */
function effectsText(effects: AccentEffects): string {
  return formatList([
    ...(effects.camera ? [t("震動 {px} px（{frames} 影格）", { px: effects.camera.shake_px, frames: effects.camera.shake_frames })] : []),
    ...(effects.impact ? [t("{frames} 格負片衝擊格", { frames: effects.impact.frames })] : []),
  ]);
}

export type OutcomeTone = "kept" | "skipped" | "generation";

/**
 * What became of an accent: the effects it gets, or why not. `effects` = the hit's effects when it is applied;
 * `blocked` = why the timeline cannot take it.
 */
export function outcomeText(decision: AccentDecision, analysis: SpeedFeelAnalysis, effects: AccentEffects | null, blocked: string | null): { text: string; tone: OutcomeTone } {
  if (decision.kept) {
    if (blocked) return { text: t("略過：{reason}", { reason: blocked }), tone: "skipped" };
    if (effects) return { text: t("加：{effects}", { effects: effectsText(effects) }), tone: "kept" };
    return { text: t("不加：整段判定不需要加效果"), tone: "skipped" };
  }
  const inRun = decision.accent.kind === "flash" && analysis.flags.strobeRuns.some((run) => run.first <= decision.accent.frame && decision.accent.frame <= run.last);
  switch (decision.reason) {
    case "edit":
      return { text: t("略過：原片在這裡切鏡"), tone: "skipped" };
    case "twos":
      return decision.needsGeneration
        ? { text: t("略過：一拍二的快速動作，生成在這裡沒動，要在生成端補"), tone: "generation" }
        : { text: t("略過：一拍二的快速動作，生成在這裡已經有動作"), tone: "skipped" };
    case "weak":
      return { text: t("略過：強度不到 {min}", { min: inRun ? STROBE_MIN_STRENGTH : MIN_STRENGTH }), tone: "skipped" };
    case "covered":
      return { text: t("略過：生成這裡自己就動了（{take}，達到原片 {motion} 的 {share}%）", { take: ratio(decision.takePeak ?? 0), motion: ratio(decision.accent.motion), share: Math.round(COVERED_SHARE * 100) }), tone: "skipped" };
    case "strobe_full":
      return { text: t("略過：這串頻閃已經有 {count} 個衝擊格", { count: STROBE_MAX_IMPACTS }), tone: "skipped" };
    case "crowded":
      return { text: inRun ? t("略過：和同一串頻閃的衝擊格靠得太近") : t("略過：離更強的重音不到 {frames} 影格", { frames: ACCENT_SPACING }), tone: "skipped" };
    case "outside":
    case null:
      return { text: t("略過：不在片段裡"), tone: "skipped" };
  }
}

/** The clip's flags as notes (the one the verdict already says is left out). */
export function flagNotes(analysis: SpeedFeelAnalysis, at: (frame: number) => string): string[] {
  const { flags, verdict } = analysis;
  const notes: string[] = [];
  if (flags.editRhythm && verdict !== "edits") notes.push(t("原片在一秒內切了 {count} 刀以上：這段的速度感有一部分來自剪接，可以考慮重新分段或改成多個鏡頭。", { count: EDIT_RHYTHM_MIN }));
  if (flags.needsGeneration.length > 0 && verdict !== "regenerate") notes.push(t("{frames} 是一拍二的快速動作，生成在那裡幾乎沒動：效果補不了，要在生成端處理。", { frames: framesText(flags.needsGeneration, at) }));
  for (const run of flags.strobeRuns) {
    notes.push(t("原片 {from}–{to} 是頻閃串（{count} 個閃光）：衝擊格互相隔開，最多 {max} 個，不超過每秒 {limit} 次閃爍。", { from: at(run.first), to: at(run.last), count: run.flashes, max: STROBE_MAX_IMPACTS, limit: FLASHES_PER_SECOND_LIMIT }));
  }
  if (verdict === "add" && analysis.take.p90 < STILL_TAKE_RATIO * analysis.original.p90) {
    notes.push(t("生成整體也比原片靜很多（動作量 p90：生成 {take}，原片 {original}）：效果補得了命中的時間點，補不了缺少的動作；想要更有動感，還是要重新生成。", { take: ratio(analysis.take.p90), original: ratio(analysis.original.p90) }));
  }
  return notes;
}

/** The rough photosensitivity check of the planned picture: a warning above the limit, else a plain fact. */
export function flashCheck(analysis: SpeedFeelAnalysis): { warning: boolean; text: string } {
  const values = { planned: analysis.flashes.planned, original: analysis.flashes.original, limit: FLASHES_PER_SECOND_LIMIT };
  return analysis.flashes.planned > FLASHES_PER_SECOND_LIMIT
    ? { warning: true, text: t("光敏粗檢：套用後在某一秒內有 {planned} 次整面閃爍，超過每秒 {limit} 次的上限（原片 {original} 次）。這只看整面的平均亮度，是粗略的提醒，不能取代正式的 PSE 檢測。", values) }
    : { warning: false, text: t("套用後每秒最多 {planned} 次整面閃爍（原片 {original} 次，上限 {limit} 次）。只看整面的平均亮度，是粗略的檢查，不是 PSE 檢測。", values) };
}

/** How the history names the clip: 「第 03 段」 in a one-click swap, else the clip's name. */
export function clipTitle(project: StudioProject, timeline: StudioTimeline, clip: TimelineClip): string {
  const shotId = timeline.sources.find((source) => source.source_id === clip.source_id)?.shot_id;
  if (shotId && findSwapJob(project)) {
    const placed = placedShotIds(timeline);
    const segments = project.shots.filter((shot) => placed.has(shot.shot_id));
    const index = segments.findIndex((shot) => shot.shot_id === shotId);
    if (index >= 0) return t("第 {index} 段", { index: String(index + 1).padStart(Math.max(2, String(segments.length).length), "0") });
  }
  return t("「{name}」", { name: clip.name });
}

/** The history step: 「速度感：第 03 段加 2 個衝擊」. */
export function speedFeelLabel(title: string, count: number): string {
  return t("速度感：{target}加 {count} 個衝擊", { target: title, count });
}
