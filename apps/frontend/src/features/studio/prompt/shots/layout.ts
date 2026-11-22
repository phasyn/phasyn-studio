// The per-shot layout of an H3 reference-generation prompt (pure, no React). The one-click swap writes one line per shot
// of the reference video in detailed_description: `[Shot 1] …` and `[Shot N] At 00:01.209, …`, the time being where
// that shot starts inside the @Video1 window; subject_definitions holds the `<Subject N> is …` definitions and the
// `@Video1 is a motion and camera reference only[, with K shots that cut at …]` line.
// The 逐鏡描述 dialog edits only the text after each shot's prefix (`[Shot N] ` plus `At mm:ss.mmm, `). Writing back
// keeps the prefixes, the shot count, the cut times and every other byte of the prompt; it refuses when the prompt's
// shots (count, numbers or cut times) changed while the dialog was open. A shot's text runs to the end of its paragraph:
// the next blank line, the next [Shot …] line or the next H3 section name. What follows a section name on its line counts
// as a line of its own (the official Base form `integrated_multimodal_description: [Shot 1] …`). Prompts without
// [Shot N] lines (or only the [Shot 1, a-b] span form) have no layout, nor do prompts that cut inside a line
// (`… bread. [Shot 2] At 00:03.000, …`): the dialog edits one shot per line and would hide that shot.
import { t } from "@/i18n";
import { parseClock } from "../blocks";

export interface ShotLine {
  /** N of [Shot N]. */
  number: number;
  /** The fixed start of the line, kept byte for byte: `[Shot 2] At 00:01.209, ` (with the spaces after it, and the section name the line starts with). */
  prefix: string;
  /** Seconds into the reference window where the shot starts (its At time; the first shot without one starts at 0); null = unknown. */
  start: number | null;
  /**
   * The description after the prefix, to the end of its paragraph (several lines when the prompt wraps it), with \n line
   * breaks as a textarea has them, so the dialog's copy compares and places its caret the same way.
   */
  text: string;
  /** Where the text is in the prompt: [textStart, textEnd). */
  textStart: number;
  textEnd: number;
}

export interface SubjectDefinition {
  /** N of <Subject N>. */
  number: number;
  /** The definition after `<Subject N> is `, to the end of its line. */
  text: string;
  /** The reference picture the definition names (@Image1 → Image1); null when it names none or uses <Picture n>. */
  image: string | null;
}

/** The video named on the `… is a motion and camera reference` line: a Studio alias (@Video1) or an H3 tag (<Video 1>). */
export type MotionReference = { alias: string } | { tag: number };

export interface ShotLayout {
  shots: ShotLine[];
  /** In subject number order (the first definition of a number counts). */
  subjects: SubjectDefinition[];
  motion: MotionReference | null;
}

export type ShotWrite = { ok: true; text: string; changed: number } | { ok: false; reason: string };

const SHOT_RE =
  /^[ \t]*\[Shot[ \t]*(\d{1,3})[ \t]*\](?:[ \t]*At[ \t]+(\d{1,3}:\d{2}(?:\.\d{1,3})?|\d{1,4}(?:\.\d{1,3})?(?:[ \t]*(?:seconds|second|secs|sec|s)(?![A-Za-z]))?)[ \t]*,?)?[ \t]*/;
/** Any shot marker at the start of a line (spans included): it ends the paragraph before it. */
const ANY_SHOT_RE = /^[ \t]*\[Shot\b/;
/** A cut inside a shot's text (`… bread. [Shot 2] At 00:03.000, …`): H3 cuts there too. */
const INLINE_CUT_RE = /\[Shot[ \t]*\d{1,3}[ \t]*\][ \t]*At[ \t]+\d/;
const SECTION_RE = /^[ \t]*(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)[ \t]*[:：]/;
const SUBJECT_RE = /^[ \t]*<Subject[ \t]*(\d{1,3})>[ \t]+is[ \t]+(.*\S)[ \t]*$/;
const MOTION_RE = /^[ \t]*(?:@(Video[1-9][0-9]?)|<Video[ \t]*([1-9][0-9]?)>)[ \t]+is[ \t]+a[ \t]+motion[ \t]+and[ \t]+camera[ \t]+reference\b/i;
const IMAGE_RE = /@(Image[1-9][0-9]?)(?![0-9A-Za-z_])/;
/** A shot marker or cut time pasted at the start of a description (the shot keeps its own). */
const PASTED_PREFIX_RE =
  /^\[Shot[ \t]*\d{1,3}[ \t]*\][ \t]*(?:At[ \t]+(?:\d{1,3}:\d{2}(?:\.\d{1,3})?|\d{1,4}(?:\.\d{1,3})?[ \t]*(?:seconds|second|secs|sec|s)?)(?![0-9A-Za-z:.])[ \t]*,?[ \t]*)?|^At[ \t]+(?:\d{1,3}:\d{2}(?:\.\d{1,3})?|\d{1,4}(?:\.\d{1,3})?[ \t]*(?:seconds|second|secs|sec|s)?)(?![0-9A-Za-z:.])[ \t]*,[ \t]*/;

interface Line {
  start: number;
  /** End of the line's text (before \n and a \r in front of it). */
  end: number;
  text: string;
}

function linesOf(prompt: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const newline = prompt.indexOf("\n", start);
    const stop = newline < 0 ? prompt.length : newline;
    const end = stop > start && prompt[stop - 1] === "\r" ? stop - 1 : stop;
    lines.push({ start, end, text: prompt.slice(start, end) });
    if (newline < 0) return lines;
    start = newline + 1;
  }
}

/** At 00:01.209 / At 1.209s → seconds; unreadable → null. */
function cueSeconds(text: string): number | null {
  if (text.includes(":")) return parseClock(text);
  const value = Number(text.replace(/[ \t]*(?:seconds|second|secs|sec|s)$/i, ""));
  return Number.isFinite(value) ? value : null;
}

/** A line that ends the paragraph of a shot before it. */
function endsParagraph(line: Line): boolean {
  return line.text.trim() === "" || ANY_SHOT_RE.test(line.text) || SECTION_RE.test(line.text);
}

export function parseShotLayout(prompt: string): ShotLayout | null {
  const lines = linesOf(prompt);
  // With a subject_definitions section, definitions count only inside it (a shot line may start with "<Subject 1> is")
  const sectioned = lines.some((line) => SECTION_RE.exec(line.text)?.[1] === "subject_definitions");
  let section: string | null = null;
  const shots: ShotLine[] = [];
  const subjects = new Map<number, SubjectDefinition>();
  let motion: MotionReference | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) break;
    const heading = SECTION_RE.exec(line.text);
    if (heading) section = heading[1] ?? null;
    // The section name stays in front of the line's own content (`integrated_multimodal_description: [Shot 1] …`)
    const lead = heading?.[0] ?? "";
    const content = line.text.slice(lead.length);
    const shot = SHOT_RE.exec(content);
    if (shot) {
      let last = index;
      for (let next = lines[last + 1]; next && !endsParagraph(next); next = lines[last + 1]) last += 1;
      const textStart = line.start + lead.length + shot[0].length;
      const textEnd = Math.max(textStart, lines[last]?.end ?? line.end);
      shots.push({
        number: Number(shot[1]),
        prefix: lead + shot[0],
        start: (shot[2] != null && shot[2] !== "") ? cueSeconds(shot[2]) : shots.length === 0 ? 0 : null,
        text: prompt.slice(textStart, textEnd).replace(/\r\n?/g, "\n"),
        textStart,
        textEnd,
      });
      index = last;
      continue;
    }
    if (sectioned && section !== "subject_definitions") continue;
    const subject = SUBJECT_RE.exec(content);
    if (subject) {
      const number = Number(subject[1]);
      const text = subject[2] ?? "";
      if (!subjects.has(number)) subjects.set(number, { number, text, image: IMAGE_RE.exec(text)?.[1] ?? null });
      continue;
    }
    const video: RegExpExecArray | null = motion ? null : MOTION_RE.exec(content);
    if (video) motion = (video[1] != null && video[1] !== "") ? { alias: video[1] } : { tag: Number(video[2]) };
  }
  if (shots.length === 0 || shots.some((shot) => INLINE_CUT_RE.test(shot.text))) return null;
  return { shots, subjects: [...subjects.values()].sort((a, b) => a.number - b.number), motion };
}

/**
 * The description as it is written into the prompt: one line (line breaks and the spaces around them become one
 * space), trimmed, without a [Shot n] marker or At time pasted at its start (the shot keeps its own prefix).
 */
export function cleanShotText(text: string): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim()
    .replace(PASTED_PREFIX_RE, "")
    .trim();
}

/** The description reads on from `At 00:01.209, ` (lower case after the comma) rather than starting a sentence. */
export function continuesPrefix(shot: Pick<ShotLine, "prefix">): boolean {
  return /\bAt[ \t]+\S/.test(shot.prefix);
}

function sameShots(a: readonly ShotLine[], b: readonly ShotLine[]): boolean {
  return a.length === b.length && a.every((shot, index) => shot.prefix === b[index]?.prefix);
}

/**
 * Writes the dialog's descriptions into `current` (the prompt as it is now). `opened` is the layout the dialog
 * started from and `edited` its descriptions in shot order: a description the dialog left as it was keeps the prompt's
 * own text (so a change made elsewhere meanwhile stays); an edited one is cleaned (cleanShotText) and replaces the text
 * after its prefix. Refused when the prompt no longer has the same shots (count, numbers, cut times) or a description
 * is empty.
 */
export function writeShotTexts(current: string, opened: ShotLayout, edited: readonly string[]): ShotWrite {
  const layout = parseShotLayout(current);
  if (!layout) return { ok: false, reason: t("Prompt 已經沒有 [Shot n] 行，沒有儲存") };
  if (!sameShots(layout.shots, opened.shots)) return { ok: false, reason: t("鏡頭的標記或切鏡時間在編輯時改變了，沒有儲存：關閉後重新打開逐鏡描述") };
  let text = current;
  let changed = 0;
  // From the last shot back, so the offsets of the earlier ones stay valid
  for (let index = layout.shots.length - 1; index >= 0; index -= 1) {
    const shot = layout.shots[index];
    const draft = edited[index];
    if (!shot || draft === undefined || draft === opened.shots[index]?.text) continue;
    const clean = cleanShotText(draft);
    if (clean === "") return { ok: false, reason: t("鏡頭 {number} 的描述是空的", { number: shot.number }) };
    // A marker alone on its line ([Shot 1] then the text below it) gets the space a one-line shot has
    const next = /\s$/.test(shot.prefix) ? clean : ` ${clean}`;
    if (next === shot.text) continue;
    text = text.slice(0, shot.textStart) + next + text.slice(shot.textEnd);
    changed += 1;
  }
  return { ok: true, text, changed };
}
