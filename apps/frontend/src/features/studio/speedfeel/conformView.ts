// The cut conform in plain words (pure): the verdict, what became of each pair of cuts (an early switch at the clip's
// end paired with the clip's end), how each part is retimed, the motion retime's and the whole-clip shift's rows and
// edits, the recommendation's verdict (choice.ts), the short summary of Effect Controls and the names of the history
// steps. Take frames are shown through `at` (the caller's clock: where they play on the sequence now). The thresholds
// are cuts.ts's.
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import type { MethodScore, Recommendation } from "./choice";
import type { ConformPlanResult, ConformSpan } from "./conform";
import { endSwitchCut, MAX_CUT_SHIFT, ON_TIME_FRAMES, type ConformAnalysis, type CutAnchor } from "./cuts";
import type { RetimePlan } from "./retime";
import type { SyncPlan } from "./sync";

export type ConformTone = "info" | "success" | "warning";

export interface ConformVerdictView {
  /** A few words (the Effect Controls group, a badge). */
  label: string;
  tone: ConformTone;
  /** The verdict in one or two sentences, with what to do. */
  line: string;
}

/** Frames with their sign: +5, −4, ±0. */
export function signedFrames(frames: number): string {
  return `${frames > 0 ? "+" : frames < 0 ? "−" : "±"}${Math.abs(frames)}`;
}

/** The verdict; `plan` is null before the plan is made (the summary then rests on the analysis alone). */
export function conformVerdict(analysis: ConformAnalysis, plan: ConformPlanResult | null): ConformVerdictView {
  const { timing } = analysis;
  // An early switch at the clip's end is something to conform even without another cut
  const switched = endSwitchCut(analysis) !== null;
  if (analysis.originalCuts.length === 0 && !switched) return { label: t("原片沒有切鏡"), tone: "success", line: t("原片這段沒有切鏡，不需要對齊切點。") };
  if (timing.matched === 0 && !switched) {
    return {
      label: t("切點對不上"),
      tone: "warning",
      line: t("原片有 {count} 個切點，生成沒有能配對的切點（相差 {frames} 影格以內才配對）：對齊補不了，可以重新生成這段。", { count: analysis.originalCuts.length, frames: MAX_CUT_SHIFT }),
    };
  }
  if (plan?.ok && timing.matched === 0) {
    // The early switch is the only cut to move
    const end = plan.plan.anchors.find((anchor) => anchor.original >= analysis.length);
    return {
      label: t("可以對齊 {count} 個切點", { count: plan.plan.anchors.length }),
      tone: "info",
      line: t("生成在片段結尾前 {frames} 影格就切到下一個鏡頭（原片在這裡沒有切鏡）：套用後剪掉這 {frames} 影格，前面的畫面拉長補到片段結尾。片段總長不變，後面的片段和聲音都不動。", {
        frames: end ? analysis.length - end.take : 0,
      }),
    };
  }
  if (plan?.ok) {
    const { before, after, anchors } = plan.plan;
    const low = Math.min(...timing.offsets);
    const high = Math.max(...timing.offsets);
    return {
      label: t("可以對齊 {count} 個切點", { count: anchors.length }),
      tone: "info",
      line: t("生成的切點和原片差 {range} 影格。套用後預計 {after}／{afterTotal} 個切點準時（現在 {before}／{beforeTotal}，差 {tolerance} 影格以內算準時）；片段總長不變，後面的片段和聲音都不動。", {
        range: low === high ? signedFrames(low) : t("{from}～{to}", { from: signedFrames(low), to: signedFrames(high) }),
        after: after.onTime,
        afterTotal: after.matched,
        before: before.onTime,
        beforeTotal: before.matched,
        tolerance: ON_TIME_FRAMES,
      }),
    };
  }
  if (plan && plan.settled) return { label: t("已經對齊"), tone: "success", line: plan.reason };
  if (plan) return { label: t("沒辦法對齊"), tone: "warning", line: plan.reason };
  return { label: t("準時 {onTime}／{matched}", { onTime: timing.onTime, matched: timing.matched }), tone: "info", line: t("生成有 {onTime}／{matched} 個切點準時（差 {tolerance} 影格以內）。", { onTime: timing.onTime, matched: timing.matched, tolerance: ON_TIME_FRAMES }) };
}

export type PairTone = "kept" | "skipped" | "warning";

export interface PairRow {
  original: number | null;
  take: number | null;
  /** take − original (frames) when both have the cut. */
  offset: number | null;
  text: string;
  tone: PairTone;
  /** The original's side is the clip's end (`original` = its length): the take's early switch. */
  atEnd?: boolean;
}

/** The early switch's row: the take cut paired with the clip's end. */
function endRow(take: number, length: number, blocked: readonly (CutAnchor & { reason: string })[], applied: readonly CutAnchor[]): PairRow {
  const same = (item: CutAnchor) => item.original === length && item.take === take;
  const row = { original: length, take, offset: take - length, atEnd: true };
  const left = blocked.find(same);
  if (left) return { ...row, text: t("略過：{reason}", { reason: left.reason }), tone: "skipped" };
  if (!applied.some(same)) return { ...row, text: t("未套用"), tone: "skipped" };
  return { ...row, text: t("段尾提早切換：延後 {frames} 影格到片段結尾，下一個鏡頭的畫面剪掉", { frames: length - take }), tone: "kept" };
}

/** Every cut of both clips in order, with what the conform makes of it. */
export function pairRows(analysis: ConformAnalysis, plan: ConformPlanResult | null): PairRow[] {
  const blocked = plan ? (plan.ok ? plan.plan.blocked : plan.blocked) : [];
  const applied = plan?.ok ? plan.plan.anchors : [];
  const switched = endSwitchCut(analysis);
  return analysis.pairs.map((pair): PairRow => {
    const { original, take } = pair;
    if (original === null && take !== null && take === switched) return endRow(take, analysis.length, blocked, applied);
    if (original === null) return { original, take, offset: null, text: t("生成多出來的切點：跟著前後的畫面一起移動"), tone: "skipped" };
    if (take === null) return { original, take, offset: null, text: t("生成沒有這個切點：對齊補不了"), tone: "warning" };
    const offset = take - original;
    const left = blocked.find((item) => item.original === original && item.take === take);
    if (left) return { original, take, offset, text: t("略過：{reason}", { reason: left.reason }), tone: "skipped" };
    if (offset === 0) return { original, take, offset, text: t("已經準時"), tone: "kept" };
    if (!applied.some((item) => item.original === original && item.take === take)) return { original, take, offset, text: t("未套用"), tone: "skipped" };
    return { original, take, offset, text: offset > 0 ? t("對齊：提早 {frames} 影格", { frames: offset }) : t("對齊：延後 {frames} 影格", { frames: -offset }), tone: "kept" };
  });
}

/** How a part between two cuts is retimed. */
export function spanText(span: ConformSpan, at: (frame: number) => string): string {
  const { treatment } = span;
  switch (treatment.kind) {
    case "keep": {
      const shift = span.output.from - span.take.from;
      if (shift === 0) return t("不變");
      return shift < 0 ? t("整段提早 {frames} 影格", { frames: -shift }) : t("整段延後 {frames} 影格", { frames: shift });
    }
    case "hold":
      return t("在 {time} 停格 {frames} 影格（這段動作最少的一格）", { time: at(treatment.at), frames: treatment.frames });
    case "faster":
      return t("{time} 起的 {length} 影格加快到 {speed}%，少 {frames} 影格（這段動作最少的地方，一次最多跳過 1 格）", { time: at(treatment.from), length: treatment.length, speed: treatment.speed, frames: treatment.frames });
    case "drops":
      return t("剪掉 {count} 個不相鄰的單格：{times}", { count: treatment.frames.length, times: formatList(treatment.frames.map(at)) });
    case "tail": {
      if (treatment.shift > 0) return t("結尾：生成早了 {frames} 影格，剪掉片段最後的 {frames} 影格", { frames: treatment.shift });
      if (treatment.shift === 0) return t("不變");
      // Late: the last frame holds (the frames after the clip's out point are never used)
      const values = { frames: -treatment.shift, hold: treatment.hold };
      return treatment.withheld
        ? t("結尾：生成晚了 {frames} 影格，最後一格停格 {hold} 影格（片段出點之後的畫格可能畫出原角色，不使用）", values)
        : t("結尾：生成晚了 {frames} 影格，素材在片段後面沒有影格了，最後一格停格 {hold} 影格", values);
    }
    case "end":
      return t("片段結尾：剪掉生成提早切到下一個鏡頭的 {frames} 影格（{time} 起）", { frames: treatment.frames, time: at(span.take.from) });
  }
}

/** Whether a part changes at all. */
export function spanChanges(span: ConformSpan): boolean {
  const { treatment } = span;
  if (treatment.kind === "keep") return span.output.from !== span.take.from;
  if (treatment.kind === "tail") return treatment.shift !== 0;
  return true;
}

/** The last analysis in a few words (Effect Controls): without a matched cut, a take's early switch at the clip's end comes first. */
export function conformSummary(analysis: ConformAnalysis): { label: string; tone: ConformTone } {
  const switched = endSwitchCut(analysis);
  if (switched !== null && (analysis.originalCuts.length === 0 || analysis.timing.matched === 0)) return { label: t("段尾提早 {frames} 影格切換", { frames: analysis.length - switched }), tone: "info" };
  if (analysis.originalCuts.length === 0) return { label: t("原片沒有切鏡"), tone: "success" };
  if (analysis.timing.matched === 0) return { label: t("切點對不上"), tone: "warning" };
  const { onTime, matched } = analysis.timing;
  return { label: t("準時 {onTime}／{matched}", { onTime, matched }), tone: onTime === matched ? "success" : "info" };
}

/** The history step: 「對齊切點：第 03 段對齊 3 個切點」. */
export function conformLabel(title: string, count: number): string {
  return t("對齊切點：{target}對齊 {count} 個切點", { target: title, count });
}

/** A correlation with its sign, 2 decimals: −0.46, 0.91. */
export function formatCorrelation(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(2)}`;
}

const correlationText = (value: number | null) => (value === null ? "—" : formatCorrelation(value));

/** How far the take runs off as a whole: 「生成影片整體晚 3 格」. */
export function lagText(lag: number): string {
  return lag > 0 ? t("生成影片整體晚 {frames} 格", { frames: lag }) : t("生成影片整體早 {frames} 格", { frames: -lag });
}

/** An edit's scores in a line: 「準時切點 2 → 5・動作節奏相關 −0.47 → 0.93」. */
export function scoreText(score: MethodScore): string {
  return t("準時切點 {onBefore} → {onAfter}・動作節奏相關 {motionBefore} → {motionAfter}", {
    onBefore: score.onTime.before,
    onAfter: score.onTime.after,
    motionBefore: correlationText(score.motion.before),
    motionAfter: correlationText(score.motion.after),
  });
}

/** The motion retime's row: 「停格 3 格・跳過 2 格・準時切點 …」. */
export function retimeText(plan: Pick<RetimePlan, "holds" | "drops">, score: MethodScore): string {
  return t("停格 {holds} 格・跳過 {drops} 格・{scores}", { holds: plan.holds, drops: plan.drops, scores: scoreText(score) });
}

/** The whole-clip shift's row: 「生成影片整體晚 3 格・準時切點 …」. */
export function shiftText(lag: number, score: MethodScore): string {
  return t("{lag}・{scores}", { lag: lagText(lag), scores: scoreText(score) });
}

/** What the motion retime's edit does. */
export function retimeEffectText(plan: RetimePlan): string {
  return t("這個片段分成 {parts} 段，每段只在素材裡外滑，不移動也不改長度：{holds} 處重複一格、{drops} 處跳過一格，都在動作少、切鏡或閃光的地方。片段總長不變，後面的片段和原片的聲音都不動。", { parts: plan.parts, holds: plan.holds, drops: plan.drops });
}

/** What the whole-clip shift's edit does. */
export function syncEffectText(plan: SyncPlan): string {
  const frames = Math.abs(plan.lag);
  const { hold } = plan.edit;
  if (hold > 0 && plan.lag > 0) return t("片段出點之後的畫格可能畫出原角色，不使用：套用後開頭的 {frames} 影格剪掉，最後一格停格 {hold} 影格補足，畫面提早 {frames} 影格。片段總長和位置不變，後面的片段和原片的聲音都不動。", { frames, hold });
  if (hold > 0) return t("素材在片段前面不夠外滑 {frames} 影格：套用後最前面一格停格 {hold} 影格補足，結尾的 {frames} 影格剪掉，畫面延後 {frames} 影格。片段總長和位置不變，後面的片段和原片的聲音都不動。", { frames, hold });
  return plan.lag > 0
    ? t("套用後片段在素材裡往後外滑 {frames} 影格，畫面提早 {frames} 影格。片段總長和位置不變，後面的片段和原片的聲音都不動。", { frames })
    : t("套用後片段在素材裡往前外滑 {frames} 影格，畫面延後 {frames} 影格。片段總長和位置不變，後面的片段和原片的聲音都不動。", { frames });
}

/** The verdict when the recommendation says more than the cut plan's own (the retime, nothing to adjust, timing cannot fix the take); null otherwise. */
export function recommendationVerdict(recommendation: Recommendation, retime: MethodScore | null): ConformVerdictView | null {
  if (recommendation.kind === "method") {
    if (recommendation.method !== "retime" || !retime) return null;
    return {
      label: t("建議依動作同步"),
      tone: "info",
      line: t("生成影片的動作節奏和原片對不上：依動作同步只在動作少、切鏡或閃光的地方重複或跳過一格，動作節奏相關 {before} → {after}。片段總長不變，後面的片段和原片的聲音都不動。", {
        before: correlationText(retime.motion.before),
        after: correlationText(retime.motion.after),
      }),
    };
  }
  switch (recommendation.why) {
    case "still":
      return { label: t("不需要調整"), tone: "success", line: t("原片這段幾乎不動，也沒有切鏡，不需要調整。") };
    case "synced":
      return { label: t("已經同步"), tone: "success", line: t("生成影片的動作節奏已經和原片同步，不需要調整。") };
    case "worse":
      return { label: t("時間調整修不了"), tone: "warning", line: t("能做的調整都會讓切點或動作更不準：建議重新生成或換 take。") };
    case "unavailable":
      return null;
  }
}

/** The history steps: 「依動作同步：第 03 段重新對時」, 「整段平移：第 03 段提早 3 影格」 (the take's picture comes that much earlier or later). */
export function retimeLabel(title: string): string {
  return t("依動作同步：{target}重新對時", { target: title });
}

export function shiftLabel(title: string, lag: number): string {
  return lag > 0 ? t("整段平移：{target}提早 {frames} 影格", { target: title, frames: lag }) : t("整段平移：{target}延後 {frames} 影格", { target: title, frames: -lag });
}
