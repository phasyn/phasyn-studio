// 一鍵換角的分段規劃（純函式）：把原影片的範圍 [start, end) 切成 H3 能生成的段落，每段以原影片的同一段畫面當參考影片。
//
// 時間單位一律是輸出的 24 fps 幀。輸出時間軸第 k 幀＝原影片 start＋k／24 秒，所以原音軌從 start 開始就和畫面同步。
// - 每段生成 F 幀（17n＋5，介於 107 與每段上限之間），參考視窗＝原影片 [W, W＋F)；視窗超過影片結尾時往前移、改裁掉開頭。
// - 段尾凍結（holdTail）：視窗從段落保留的第一幀開始（不往前移），到段尾後 leadOutFrames 幀、且至少有 minRealFrames 幀
//   原片為止（不超過影片結尾與 F；結尾前不到 MIN_HELD_SHOT_FRAMES 幀的切鏡改成結尾），之後 runtime 重複最後一格補滿
//   F 幀（hold_last_frame）：視窗裡沒有下一段的鏡頭，模型就不會提早畫出它；段尾後的原片讓動作不會在段尾前收住。
// - 段落的接合有兩種：在原影片的切鏡處（cut，直接切換，通常看不出接縫），或在同一個鏡頭中間（mid_shot：前後兩段各自生成，
//   ref2va 不能接首幀，頭髮、服裝細節、光線可能跳動，所以重疊 crossfade 幀交叉溶接）。
// - 邊界的選擇用動態規劃：先讓鏡頭中間的接縫最少，再讓段數最少，最後讓生成的總幀數最少。比原影片鏡頭長的段落平均切成
//   幾段（不會留下很短的尾段）。
// - 裁切（keep_in／keep_out）與轉場套用後，接起來的總長剛好等於 end − start（0 幀誤差）。
import { alignFrames, H3_FPS } from "../model/frames";
import { MAX_TIMELINE_CLIPS } from "../editor/model";
import { MIN_SEGMENT_FRAMES } from "./limitSpec";
import { t } from "@/i18n";

/** 鏡頭中間接縫的交叉溶接幀數（預設 0.5 秒）。 */
export const DEFAULT_CROSSFADE_FRAMES = 12;
/** 交叉溶接最多 1 秒：中間段落同時有進場與出場溶接時，兩者相加仍遠小於段落長度。 */
export const MAX_CROSSFADE_FRAMES = 24;

/** 段尾凍結：參考影片在段尾之後還留多少原片，然後凍結最後一格（幀）。 */
export interface HoldTail {
  /** 段落最後一個保留的幀之後的原片（凍結的尾巴會讓模型提早收住動作，留一點原片就不會在段尾前停下）。 */
  leadOutFrames: number;
  /** 視窗至少有這麼多原片（從段落第一個保留的幀算起）：太短的原片反而讓切鏡變晚、動作變多。 */
  minRealFrames: number;
}

/** 新的換角預設：段尾後 0.5 秒原片，至少 2 秒原片，之後凍結。 */
export const DEFAULT_HOLD_TAIL: HoldTail = { leadOutFrames: 12, minRealFrames: 48 };

/** 凍結的鏡頭在視窗裡至少有這麼多幀：視窗結尾前不到這麼多幀的切鏡，改成視窗的結尾（不凍結在鏡頭的碎片上）。 */
export const MIN_HELD_SHOT_FRAMES = 6;

/**
 * 段尾凍結視窗的結尾（幀）：原影片在結尾前不到 MIN_HELD_SHOT_FRAMES 幀處有切鏡時（凍結會停在一小段鏡頭上），結尾改到那個
 * 切鏡，凍結的就是切鏡前那個鏡頭的最後一格；改完再檢查一次。不會改到段落保留的幀之內（keptEnd：段落結尾，不含）。
 * cuts：原影片的切鏡（幀，排序）。
 */
export function snapHeldEnd(end: number, cuts: readonly number[], keptEnd: number): number {
  let snapped = end;
  for (;;) {
    const cut = cuts.findLast((value) => value >= keptEnd && value > snapped - MIN_HELD_SHOT_FRAMES && value < snapped);
    if (cut === undefined) return snapped;
    snapped = cut;
  }
}

export interface PlanInput {
  /** 原影片長度（秒）；未知＝不能規劃。 */
  durationSeconds: number | null;
  startSeconds: number;
  endSeconds: number;
  /** 原影片的切鏡時間（秒；可以含範圍外的值：範圍內的當候選邊界，參考視窗內的寫進 prompt）。 */
  cutsSeconds: readonly number[];
  /** 每段上限（幀；換角上限 maxFramesFor 的結果）。不是 17n＋5 時往下取最接近的合法值。 */
  maxFrames: number;
  crossfadeFrames?: number;
  fps?: number;
  /** Most segments the film can hold (maxSegments); the original-audio limit when omitted. */
  maxSegments?: number;
  /** 段尾凍結（每段的參考影片在段尾後凍結最後一格）；null 或省略＝視窗是完整的 F 幀原片（與沒有這個選項時相同）。 */
  holdTail?: HoldTail | null;
}

/** Segments one timeline holds: each is a video clip, plus its own linked sound unless the original audio (one clip) plays. */
export function maxSegments(originalAudio: boolean): number {
  return originalAudio ? MAX_TIMELINE_CLIPS - 1 : Math.floor(MAX_TIMELINE_CLIPS / 2);
}

/** 與下一段的接合：cut＝原影片的切鏡處；mid_shot＝同一個鏡頭中間（crossfade_frames＝0 表示直接接）。 */
export type SegmentJoin = { kind: "cut" } | { kind: "mid_shot"; crossfade_frames: number };

export interface PlannedSegment {
  index: number;
  /** 參考影片視窗（原影片秒數）：[ref_start, ref_end)，長度＝frames／fps（段尾凍結時 1–frames 幀，之後凍結）。 */
  ref_start: number;
  ref_end: number;
  /** 生成的幀數（17n＋5）。 */
  frames: number;
  /** 保留的生成幀：[keep_in_frame, keep_out_frame)。 */
  keep_in_frame: number;
  keep_out_frame: number;
  /** 匯出時的出場轉場（MediaClipEffects.transition_out 的形狀）；最後一段一律 cut。 */
  transition_out: { kind: "cut" } | { kind: "crossfade"; frames: number };
  /** 與下一段的接合方式；最後一段為 null。 */
  join_out: SegmentJoin | null;
  /** 保留的畫面在輸出時間軸（相對於範圍起點）的位置 [timeline_start, timeline_end)。 */
  timeline_start: number;
  timeline_end: number;
  /** 參考視窗內的切鏡（相對於視窗起點的幀，0 < c < 視窗長度），prompt 用來寫 [Shot n] 的時間。 */
  window_cuts: number[];
  /** 段尾凍結：參考影片在視窗之後凍結最後一格（hold_last_frame）；沒有段尾凍結時沒有這個欄位。 */
  hold?: true;
}

export interface SegmentPlan {
  fps: number;
  /** 範圍起點與終點（原影片的幀；終點不含）。 */
  start_frame: number;
  end_frame: number;
  total_frames: number;
  /** 實際使用的每段上限（合法值，且不超過影片長度）。 */
  max_frames: number;
  crossfade_frames: number;
  segments: PlannedSegment[];
  cut_joins: number;
  mid_shot_joins: number;
  /** 所有段落生成的幀數合計（GPU 時間的粗略指標）。 */
  generated_frames: number;
  /** 不能規劃的原因；非空時 segments 是空陣列。 */
  problems: string[];
}

/** 每段可用的生成長度（17n＋5，107 起，不超過 maxFrames）。 */
export function segmentFrameOptions(maxFrames: number): number[] {
  const out: number[] = [];
  for (let frames = MIN_SEGMENT_FRAMES; frames <= maxFrames; frames += 17) out.push(frames);
  return out;
}

/** 保留 kept 幀需要生成的長度：不小於 kept 的最短合法長度。 */
export function framesFor(kept: number): number {
  return Math.max(MIN_SEGMENT_FRAMES, alignFrames(kept));
}

/**
 * 一個沒有切鏡邊界的區塊（長度 length）要切成幾段、每段保留幾幀：不超過 maxFrames 時一段；否則用最少的段數、
 * 相鄰兩段重疊 crossfade 幀，長度盡量平均（差最多 1 幀）。
 */
export function chunkPieces(length: number, maxFrames: number, crossfade: number): number[] {
  if (length <= maxFrames) return [length];
  const count = Math.ceil((length - crossfade) / (maxFrames - crossfade));
  const total = length + (count - 1) * crossfade;
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0));
}

interface Cost {
  midShot: number;
  segments: number;
  generated: number;
}

/** 區塊的成本（O(1)：各段長度只有 base 與 base＋1 兩種）。 */
function chunkCost(length: number, maxFrames: number, crossfade: number): Cost {
  if (length <= maxFrames) return { midShot: 0, segments: 1, generated: framesFor(length) };
  const count = Math.ceil((length - crossfade) / (maxFrames - crossfade));
  const total = length + (count - 1) * crossfade;
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return { midShot: count - 1, segments: count, generated: extra * framesFor(base + 1) + (count - extra) * framesFor(base) };
}

function cheaper(a: Cost, b: Cost): boolean {
  if (a.midShot !== b.midShot) return a.midShot < b.midShot;
  if (a.segments !== b.segments) return a.segments < b.segments;
  return a.generated < b.generated;
}

function emptyPlan(fps: number, problems: string[], extra: Partial<SegmentPlan> = {}): SegmentPlan {
  return {
    fps,
    start_frame: 0,
    end_frame: 0,
    total_frames: 0,
    max_frames: 0,
    crossfade_frames: 0,
    segments: [],
    cut_joins: 0,
    mid_shot_joins: 0,
    generated_frames: 0,
    problems,
    ...extra,
  };
}

/** 段尾凍結的幀數：0 以上的整數（非有限值當 0）。 */
function wholeFrames(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** 段尾凍結的段落：參考視窗的長度（幀；之後凍結最後一格）；沒有段尾凍結時 null。 */
export function heldWindowFrames(segment: Pick<PlannedSegment, "hold" | "ref_start" | "ref_end">, fps: number): number | null {
  return segment.hold ? Math.round(segment.ref_end * fps) - Math.round(segment.ref_start * fps) : null;
}

/** 秒 → 幀（四捨五入；範圍的起點與終點）；非有限值為 null。 */
function toFrame(seconds: number, fps: number): number | null {
  return Number.isFinite(seconds) ? Math.round(seconds * fps) : null;
}

/**
 * 切鏡時間（新鏡頭第一幀的秒數）→ 輸出的第一個「已經是新鏡頭」的幀：round(秒 × fps)，一半往上（1e-6 吸收浮點誤差）。
 * 這是 H3 runtime 解參考影片的方式：ffmpeg 的 fps=24 濾鏡（預設 round=near）把原影片時間 t 的那一幀放在輸出第
 * round(t × 24) 幀，例如 23.976 fps 的切鏡在 2.5025 秒 → 第 60 幀已經是新鏡頭。往上取（ceil）在非 24 fps 的來源會晚一幀，
 * 上一段的參考視窗尾巴就多出新鏡頭的角色。
 */
function toCutFrame(seconds: number, fps: number): number | null {
  return Number.isFinite(seconds) ? Math.floor(seconds * fps + 0.5 + 1e-6) : null;
}

export function planSegments(input: PlanInput): SegmentPlan {
  const fps = input.fps ?? H3_FPS;
  const crossfade = input.crossfadeFrames ?? DEFAULT_CROSSFADE_FRAMES;
  const duration = input.durationSeconds;
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return emptyPlan(fps, [t("原影片長度未知：先執行切鏡偵測（會讀出長度），或換一個瀏覽器讀得到長度的檔案")]);
  // 參考視窗的終點不能超過影片長度：可用的幀數往下取整（1e-6 吸收浮點誤差）
  const available = Math.floor(duration * fps + 1e-6);
  if (available < MIN_SEGMENT_FRAMES) {
    return emptyPlan(fps, [t("原影片只有 {available} 秒，短於最短生成長度 {minSegmentFrames} 秒（{minSegmentFrames2} 影格），無法當參考視窗", { available: (available / fps).toFixed(2), minSegmentFrames: (MIN_SEGMENT_FRAMES / fps).toFixed(2), minSegmentFrames2: MIN_SEGMENT_FRAMES })]);
  }
  const options = segmentFrameOptions(Math.min(input.maxFrames, available));
  const maxFrames = options.at(-1);
  if (maxFrames === undefined) return emptyPlan(fps, [t("每段上限不能少於 {minSegmentFrames} 影格（{minSegmentFrames2} 秒）", { minSegmentFrames: MIN_SEGMENT_FRAMES, minSegmentFrames2: (MIN_SEGMENT_FRAMES / fps).toFixed(2) })]);
  if (!Number.isInteger(crossfade) || crossfade < 0 || crossfade > MAX_CROSSFADE_FRAMES) {
    return emptyPlan(fps, [t("交叉溶接必須是 0–{maxCrossfadeFrames} 影格的整數", { maxCrossfadeFrames: MAX_CROSSFADE_FRAMES })]);
  }
  const startFrame = Math.max(0, toFrame(input.startSeconds, fps) ?? 0);
  const endFrame = Math.min(available, toFrame(input.endSeconds, fps) ?? available);
  const total = endFrame - startFrame;
  const base = { start_frame: startFrame, end_frame: endFrame, total_frames: Math.max(0, total), max_frames: maxFrames, crossfade_frames: crossfade };
  if (total < 1) return emptyPlan(fps, [t("範圍的起點必須早於終點（至少 1 影格）")], base);

  // 原影片的切鏡（幀，去重排序）；範圍內的當候選邊界
  const cuts = [...new Set(input.cutsSeconds.flatMap((value) => {
    const frame = toCutFrame(value, fps);
    return frame === null ? [] : [frame];
  }))].sort((a, b) => a - b);
  const positions = [0, ...cuts.map((cut) => cut - startFrame).filter((cut) => cut > 0 && cut < total), total];

  // 動態規劃：best[j]＝把 [0, positions[j]) 規劃完、positions[j] 是邊界時的最低成本
  const best: (Cost & { previous: number })[] = [{ midShot: 0, segments: 0, generated: 0, previous: -1 }];
  for (let j = 1; j < positions.length; j += 1) {
    let chosen: (Cost & { previous: number }) | null = null;
    for (let i = 0; i < j; i += 1) {
      const from = best[i];
      if (!from) continue;
      const cost = chunkCost((positions[j] ?? 0) - (positions[i] ?? 0), maxFrames, crossfade);
      const candidate = { midShot: from.midShot + cost.midShot, segments: from.segments + cost.segments, generated: from.generated + cost.generated, previous: i };
      if (!chosen || cheaper(candidate, chosen)) chosen = candidate;
    }
    best.push(chosen ?? { midShot: Infinity, segments: Infinity, generated: Infinity, previous: j - 1 });
  }
  const boundaries: number[] = [];
  for (let at = positions.length - 1; at >= 0; at = best[at]?.previous ?? -1) boundaries.unshift(positions[at] ?? 0);

  const hold = input.holdTail ? { leadOut: wholeFrames(input.holdTail.leadOutFrames), minReal: wholeFrames(input.holdTail.minRealFrames) } : null;
  const segments: PlannedSegment[] = [];
  for (let chunk = 0; chunk + 1 < boundaries.length; chunk += 1) {
    const from = boundaries[chunk] ?? 0;
    const to = boundaries[chunk + 1] ?? total;
    const pieces = chunkPieces(to - from, maxFrames, crossfade);
    let cursor = from;
    pieces.forEach((kept, piece) => {
      const frames = framesFor(kept);
      const first = startFrame + cursor;
      let windowStart = first;
      let windowEnd: number;
      if (hold) {
        // 段尾凍結：從保留的第一幀開始（不往前移），到段尾後 leadOut 幀、至少 minReal 幀原片，不超過影片結尾與生成長度；
        // 結尾前太近的切鏡改成結尾
        windowEnd = snapHeldEnd(Math.min(available, first + frames, Math.max(first + kept + hold.leadOut, first + hold.minReal)), cuts, first + kept);
      } else {
        // 視窗超過影片結尾：往前移，改裁掉開頭（保留的畫面仍是同一段原影片時間）
        if (windowStart + frames > available) windowStart = available - frames;
        windowEnd = windowStart + frames;
      }
      const keepIn = first - windowStart;
      const lastPiece = piece === pieces.length - 1;
      const lastChunk = to === total;
      const join: SegmentJoin | null = !lastPiece ? { kind: "mid_shot", crossfade_frames: crossfade } : lastChunk ? null : { kind: "cut" };
      segments.push({
        index: segments.length,
        ref_start: windowStart / fps,
        ref_end: windowEnd / fps,
        frames,
        keep_in_frame: keepIn,
        keep_out_frame: keepIn + kept,
        transition_out: join?.kind === "mid_shot" && crossfade > 0 ? { kind: "crossfade", frames: crossfade } : { kind: "cut" },
        join_out: join,
        timeline_start: cursor,
        timeline_end: cursor + kept,
        window_cuts: cuts.filter((cut) => cut > windowStart && cut < windowEnd).map((cut) => cut - windowStart),
        ...(hold ? { hold: true as const } : {}),
      });
      cursor += kept - (lastPiece ? 0 : crossfade);
    });
  }

  const problems = verifyPlan(segments, { total, available, startFrame, maxFrames, fps });
  const limit = input.maxSegments ?? maxSegments(true);
  if (segments.length > limit) problems.push(t("分成 {segmentsCount} 段，超過時間軸最多 {limit} 段：縮短範圍", { segmentsCount: segments.length, limit }));
  if (problems.length > 0) return emptyPlan(fps, problems, base);
  return {
    fps,
    ...base,
    segments,
    cut_joins: segments.filter((segment) => segment.join_out?.kind === "cut").length,
    mid_shot_joins: segments.filter((segment) => segment.join_out?.kind === "mid_shot").length,
    generated_frames: segments.reduce((sum, segment) => sum + segment.frames, 0),
    problems: [],
  };
}

/**
 * 規劃結果的不變量（任何一條不成立都是程式錯誤，回傳問題而不是送出錯的計畫）：時間軸連續且總長＝範圍、視窗在影片內、
 * 生成長度合法、保留範圍在生成範圍內、轉場不超過相鄰段落（與 media.concat／effects 的規則相同）。段尾凍結的視窗是
 * 1–frames 幀，而且保留的幀都在視窗的原片裡（不會保留到凍結的畫面）。
 */
export function verifyPlan(
  segments: readonly PlannedSegment[],
  context: { total: number; available: number; startFrame: number; maxFrames: number; fps: number },
): string[] {
  const problems: string[] = [];
  const allowed = new Set(segmentFrameOptions(context.maxFrames));
  let cursor = 0;
  let joined = 0;
  segments.forEach((segment, index) => {
    const name = t("第 {index} 段", { index: index + 1 });
    const kept = segment.keep_out_frame - segment.keep_in_frame;
    const windowStart = Math.round(segment.ref_start * context.fps);
    const windowEnd = segment.hold ? Math.round(segment.ref_end * context.fps) : windowStart + segment.frames;
    if (!allowed.has(segment.frames)) problems.push(t("{name}的生成長度 {frames} 影格不是允許的值", { name, frames: segment.frames }));
    if (segment.keep_in_frame < 0 || kept < 1 || segment.keep_out_frame > segment.frames) problems.push(t("{name}的保留範圍不在生成範圍內", { name }));
    if (windowStart < 0 || windowEnd > context.available) problems.push(t("{name}的參考視窗超出原影片", { name }));
    if (segment.hold && (windowEnd - windowStart > segment.frames || windowEnd - windowStart < Math.max(1, segment.keep_out_frame))) problems.push(t("{name}的參考視窗長度不正確", { name }));
    if (windowStart + segment.keep_in_frame !== context.startFrame + segment.timeline_start) problems.push(t("{name}的參考視窗與時間軸位置不一致", { name }));
    if (segment.timeline_start !== cursor) problems.push(t("{name}的時間軸位置不連續", { name }));
    const overlap = segment.transition_out.kind === "crossfade" ? segment.transition_out.frames : 0;
    const incoming = index > 0 ? segments[index - 1]?.transition_out : undefined;
    const overlapIn = incoming?.kind === "crossfade" ? incoming.frames : 0;
    const next = segments[index + 1];
    if (overlap > 0 && (!next || overlap > Math.min(kept, next.keep_out_frame - next.keep_in_frame))) problems.push(t("{name}的交叉溶接超過相鄰段落長度", { name }));
    if (overlap + overlapIn > kept) problems.push(t("{name}的進場＋出場溶接超過段落長度", { name }));
    if ((segment.join_out === null) !== (index === segments.length - 1)) problems.push(t("{name}的接合方式不正確", { name }));
    joined += kept - overlap;
    cursor = segment.timeline_end - (segment.join_out?.kind === "mid_shot" ? segment.join_out.crossfade_frames : 0);
  });
  if (joined !== context.total || cursor !== context.total) problems.push(t("接起來的長度 {joined} 影格不等於範圍 {total} 影格", { joined, total: context.total }));
  return problems;
}

/** 輸出時間軸的幀 → 原影片時間（秒）。 */
export function sourceTime(plan: Pick<SegmentPlan, "start_frame" | "fps">, timelineFrame: number): number {
  return (plan.start_frame + timelineFrame) / plan.fps;
}
