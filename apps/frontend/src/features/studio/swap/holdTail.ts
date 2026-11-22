// 換角專案改用段尾凍結（換角面板的「改用段尾凍結…」，純函式）：每一段的 @Video1 參考改成
// [段落起點, min(影片結尾, max(段尾＋0.5 秒, 段落起點＋2 秒))]＋hold_last_frame（與新換角的 DEFAULT_HOLD_TAIL 相同，
// 也不超過鏡頭的生成長度；結尾前太近的切鏡改成結尾，用 prompt 寫的切鏡時間，與 planner 的 snapHeldEnd 相同），之後重複
// 最後一格補滿生成長度。段落的原影片範圍是規劃時寫進鏡頭名稱的
// 「第 NN 段・mm:ss.sss–mm:ss.sss」（名稱改過時用鏡頭備註的「原影片 …」那一行），不從時間軸的片段推算（剪輯後可能
// 被切開、裁短或加了停格）。
// prompt 是一鍵換角寫的格式時一起改寫：切鏡時間改成相對於新的視窗起點，拿掉視窗外的 [Shot n]，更新「with N shots that
// cut at …」與保留行的「cut(s) at …」，再加上凍結的那一句（prompt.ts）。格式對不上的 prompt 不動，由對話框列出來。
import type { StudioLibraryItem, StudioReference, StudioShot } from "@/api/generated/contracts";
import { parseClock } from "../prompt/blocks";
import { parseShotLayout, type ShotLine } from "../prompt/shots/layout";
import { heldReference } from "../references/materials";
import { DEFAULT_HOLD_TAIL, snapHeldEnd, type HoldTail } from "./planner";
import { definitionCuts, definitionHold, formatCueTime, retentionCuts, retentionHold } from "./prompt";

const VIDEO_ALIAS = "Video1";

/** A segment's original range as the planner writes it (`00:05.170–00:10.340`), in a title or a note. */
const RANGE_RE = /(\d{2,}):(\d{2})\.(\d{3})[ \t]*[–-][ \t]*(\d{2,}):(\d{2})\.(\d{3})/;

const CUE = String.raw`\d{2,}:\d{2}\.\d{3}`;
const CUE_LIST = String.raw`${CUE}(?:(?:, and |, | and )${CUE})*`;
/** The planner's @Video1 definition: its cuts or a note, an earlier hold sentence and the end of the line. */
const DEFINITION_RE = new RegExp(
  String.raw`^(@Video1 is a motion and camera reference(?: only)?)(?:, with (\d+) shots that cut at (${CUE_LIST})|(: .*?))?(?:; after ${CUE} it holds its last frame)?(\.(?: Its characters are replaced and must not appear\.)?)[ \t]*$`,
  "m",
);
/** The planner's @Video1 retention line, up to its weak_reference. */
const RETENTION_RE = new RegExp(String.raw`^(@Video1 \(camera path, shot sizes, )(?:cuts? at (${CUE_LIST}), )?(body motion|motion)(?:; after ${CUE} the reference holds its last frame)?(\): weak_reference - )`, "m");
/** Every definition and retention line of a prompt (the planner writes exactly one of each); read only with matchAll, which iterates a copy, so their lastIndex stays 0. */
const DEFINITIONS_RE = new RegExp(DEFINITION_RE.source, "gm");
const RETENTIONS_RE = new RegExp(RETENTION_RE.source, "gm");
const OPENING_PREFIX = "[Shot 1] ";
const CUT_PREFIX_RE = new RegExp(String.raw`^\[Shot \d+\] At ${CUE}, $`);
/** The planner's own shot texts: the one that opens the window and the one every cut gets. */
const OPENING_TEXT_RE = /^The opening shot of @Video1\b/;
const CUT_TEXT_RE = /^the camera cuts to the next shot of @Video1\b/;

function clock(minutes: string | undefined, seconds: string | undefined, millis: string | undefined): number {
  return Number(minutes ?? 0) * 60 + Number(seconds ?? 0) + Number(millis ?? 0) / 1000;
}

/** The original range a segment keeps (frames at fps), from its title or else its note; null when neither has it. */
export function segmentRange(shot: Pick<StudioShot, "title" | "note">, fps: number): { start: number; end: number } | null {
  for (const text of [shot.title, shot.note]) {
    const match = RANGE_RE.exec(text);
    if (!match) continue;
    const start = Math.round(clock(match[1], match[2], match[3]) * fps);
    const end = Math.round(clock(match[4], match[5], match[6]) * fps);
    if (end > start) return { start, end };
  }
  return null;
}

/** `00:01.083 and 00:02.625` → frames. */
function cueFrames(list: string | undefined, fps: number): number[] {
  if (!(list != null && list !== "")) return [];
  return list.split(/, and |, | and /).map((cue) => Math.round((parseClock(cue) ?? Number.NaN) * fps));
}

const sameFrames = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Where a shot's line starts (its prefix comes right before its text). */
const lineStart = (shot: ShotLine) => shot.textStart - shot.prefix.length;

export interface HeldWindow {
  /** Frames from the old @Video1 window start to the new one (the prompt's cut times move back by this much). */
  shift: number;
  /** Frames of real footage in the new window (after them the reference holds its last frame). */
  held: number;
  /** The shot's generated frames. */
  frames: number;
  fps: number;
}

/** A prompt in the planner's format: its shots ([Shot 1] first) and the cuts of its @Video1 window (frames, in order). */
interface PlannerPrompt {
  shots: ShotLine[];
  cuts: number[];
}

/** The planner's format: one definition and one retention line for @Video1 whose cuts are the [Shot n] times; null otherwise. */
function plannerPrompt(prompt: string, fps: number): PlannerPrompt | null {
  const [definition, ...otherDefinitions] = prompt.matchAll(DEFINITIONS_RE);
  const [retention, ...otherRetentions] = prompt.matchAll(RETENTIONS_RE);
  if (!definition || !retention || otherDefinitions.length > 0 || otherRetentions.length > 0) return null;
  const layout = parseShotLayout(prompt);
  if (!layout) return null;
  const shots = layout.shots;
  if (shots[0]?.prefix !== OPENING_PREFIX) return null;
  // Every later shot is `[Shot n] At mm:ss.sss, …` in order: its time is a cut of the window
  const cuts: number[] = [];
  for (let index = 1; index < shots.length; index += 1) {
    const shot = shots[index];
    if (shot?.number !== index + 1 || shot.start === null || !CUT_PREFIX_RE.test(shot.prefix)) return null;
    const cut = Math.round(shot.start * fps);
    if (cut <= (cuts.at(-1) ?? 0)) return null;
    cuts.push(cut);
  }
  if (!sameFrames(cueFrames(retention[2], fps), cuts)) return null;
  const note = definition[4];
  if (definition[3] !== undefined ? Number(definition[2]) !== cuts.length + 1 || !sameFrames(cueFrames(definition[3], fps), cuts) : note === undefined && cuts.length > 0) return null;
  return { shots, cuts };
}

/**
 * The planner-format prompt (`parsed` is plannerPrompt's reading of it) for the held window: cut times relative to the
 * new window start, the shots outside it gone, the cut lists rewritten and the hold sentence added. null when its shots
 * cannot be moved (the window now opens in a later shot whose description was written by hand).
 */
function heldPrompt(prompt: string, parsed: PlannerPrompt, target: HeldWindow): string | null {
  const { shift, held, frames, fps } = target;
  const { shots, cuts } = parsed;
  const opening = shots[0];
  if (!opening || shift < 0 || held < 1) return null;

  // The shot the new window starts in opens it; the later ones inside it keep their texts with moved times
  const first = cuts.filter((cut) => cut <= shift).length;
  const kept = cuts.flatMap((cut, index) => (index + 1 > first && cut - shift < held ? [{ index: index + 1, at: cut - shift }] : []));
  const openingShot = shots[first];
  if (!openingShot) return null;
  // Only the planner's own texts can be moved to the opening: a hand-written description belongs to its shot
  if (first > 0 && !(OPENING_TEXT_RE.test(opening.text) && CUT_TEXT_RE.test(openingShot.text))) return null;
  const edits: { start: number; end: number; text: string }[] = [];
  // The shots after the window go with the blank lines before them
  const lastKept = shots[kept.at(-1)?.index ?? first];
  const lastShot = shots.at(-1);
  if (lastKept && lastShot && lastKept !== lastShot) edits.push({ start: lastKept.textEnd, end: lastShot.textEnd, text: "" });
  kept.forEach((item, position) => {
    const shot = shots[item.index];
    const prefix = `[Shot ${String(position + 2)}] At ${formatCueTime(item.at, fps)}, `;
    if (shot && prefix !== shot.prefix) edits.push({ start: lineStart(shot), end: shot.textStart, text: prefix });
  });
  if (first > 0) edits.push({ start: lineStart(opening), end: openingShot.textEnd, text: opening.prefix + opening.text });
  let text = prompt;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);

  const cues = kept.map((item) => formatCueTime(item.at, fps));
  // A window as long as the clip has nothing after it to hold
  const holdCue = held < frames ? formatCueTime(held, fps) : null;
  text = text.replace(RETENTION_RE, (_match, lead: string, _cuts: string | undefined, motion: string, rest: string) => `${lead}${retentionCuts(cues)}${motion}${(holdCue != null && holdCue !== "") ? retentionHold(holdCue) : ""}${rest}`);
  text = text.replace(
    DEFINITION_RE,
    (_match, lead: string, _count: string | undefined, _cuts: string | undefined, written: string | undefined, end: string) => `${lead}${written ?? definitionCuts(cues)}${(holdCue != null && holdCue !== "") ? definitionHold(holdCue) : ""}${end}`,
  );
  return text;
}

/** How many of the segments hold the last frame of their @Video1 reference. */
export function heldSegmentCount(shots: readonly StudioShot[]): number {
  return shots.filter((shot) => (shot.references ?? []).some((ref) => ref.alias === VIDEO_ALIAS && heldReference(ref))).length;
}

export interface HoldTailChange {
  shotId: string;
  title: string;
  /** The @Video1 window in seconds of the source video: before (end null = to the file's end) and after. */
  from: { start: number; end: number | null };
  to: { start: number; end: number };
  /** The references and prompt before and after (復原 puts `before` back). */
  before: { references: StudioReference[]; prompt: string };
  after: { references: StudioReference[]; prompt: string };
  /** The prompt is not in the planner's format: it stays as it is and needs adjusting by hand. */
  manualPrompt: boolean;
}

/** held: already held; no-video: no @Video1 reference; no-range: no original range in the title or note; outside: the range does not fit the reference or the generated length. */
export type HoldTailSkip = "held" | "no-video" | "no-range" | "outside";

export interface HoldTailPlan {
  changes: HoldTailChange[];
  skipped: { shotId: string; title: string; reason: HoldTailSkip }[];
}

export interface HoldTailContext {
  /** The job's frame rate (the planner's frames). */
  fps: number;
  library: readonly StudioLibraryItem[];
}

/** What 「改用段尾凍結」 does to the swap's segments (film order); segments it cannot change are skipped with the reason. */
export function holdTailPlan(shots: readonly StudioShot[], context: HoldTailContext, tail: HoldTail = DEFAULT_HOLD_TAIL): HoldTailPlan {
  const { fps } = context;
  const items = new Map(context.library.map((item) => [item.item_id, item]));
  const plan: HoldTailPlan = { changes: [], skipped: [] };
  for (const shot of shots) {
    const skip = (reason: HoldTailSkip) => plan.skipped.push({ shotId: shot.shot_id, title: shot.title, reason });
    const references = shot.references ?? [];
    const ref = references.find((item) => item.kind === "video" && item.alias === VIDEO_ALIAS);
    if (!ref) {
      skip("no-video");
      continue;
    }
    if (heldReference(ref)) {
      skip("held");
      continue;
    }
    const range = segmentRange(shot, fps);
    if (!range) {
      skip("no-range");
      continue;
    }
    const duration = items.get(ref.item_id)?.duration_seconds ?? null;
    const filmEnd = duration === null ? Number.POSITIVE_INFINITY : Math.floor(duration * fps + 1e-6);
    const oldStart = Math.round((ref.start_seconds ?? 0) * fps);
    const oldEnd = ref.end_seconds === null ? null : Math.round(ref.end_seconds * fps);
    let end = Math.min(filmEnd, range.start + shot.frames, Math.max(range.end + tail.leadOutFrames, range.start + tail.minRealFrames));
    // The old window bounds the cuts its prompt names: stay inside it while it holds the whole segment
    if (oldEnd !== null && oldEnd >= range.end) end = Math.min(end, oldEnd);
    if (end < range.end || range.start >= filmEnd) {
      skip("outside");
      continue;
    }
    // The old window holds the new one: the cuts its prompt names are every cut there is, so the freeze can be kept off
    // a sliver of a shot (the planner's snap) and the prompt rewritten
    const covered = oldEnd !== null && range.start >= oldStart && end <= oldEnd;
    const parsed = covered ? plannerPrompt(shot.prompt, fps) : null;
    if (parsed) end = snapHeldEnd(end, parsed.cuts.map((cut) => oldStart + cut), range.end);
    const prompt = parsed ? heldPrompt(shot.prompt, parsed, { shift: range.start - oldStart, held: end - range.start, frames: shot.frames, fps }) : null;
    const to = { start: range.start / fps, end: end / fps };
    plan.changes.push({
      shotId: shot.shot_id,
      title: shot.title,
      from: { start: ref.start_seconds ?? 0, end: ref.end_seconds },
      to,
      before: { references, prompt: shot.prompt },
      after: { references: references.map((item) => (item === ref ? { ...item, start_seconds: to.start, end_seconds: to.end, hold_last_frame: true } : item)), prompt: prompt ?? shot.prompt },
      manualPrompt: prompt === null,
    });
  }
  return plan;
}
