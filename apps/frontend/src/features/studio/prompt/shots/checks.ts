// The live check of one shot description and the edits the dialog's chips make (pure). Rules:
// state the shot size plainly (otherwise H3 draws the character sheet's full-body pose), restate at
// least one signature feature of every character on screen (otherwise fast-action shots bring the original character
// back), state the viewpoint the reference shot has (one that contradicts it made H3 copy the original shot), and
// negate nothing (what a line negates gets drawn); the word lists are in ./wording. An empty description or a [Shot n] marker inside one cannot be saved; the rest are warnings that each
// say what to add.
import { t } from "@/i18n";
import { cleanShotText } from "./layout";
import { wordStems } from "./signature";
import { negationWord, statedViewpoint, VIEWPOINTS, type Viewpoint, type ViewpointId } from "./wording";

export type ShotSizeId = "ecu" | "cu" | "mcu" | "ms" | "fs" | "ws";

export interface ShotSize {
  id: ShotSizeId;
  /** The opening phrase the chip writes. */
  phrase: string;
}

export const SHOT_SIZES: readonly ShotSize[] = [
  { id: "ecu", phrase: "An extreme close-up of" },
  { id: "cu", phrase: "A close-up of" },
  { id: "mcu", phrase: "A chest-up medium close-up of" },
  { id: "ms", phrase: "A waist-up medium shot of" },
  { id: "fs", phrase: "A full shot of" },
  { id: "ws", phrase: "A wide shot of" },
];

/** The chips' names (read when shown, in the current language). */
export function shotSizeLabels(): Record<ShotSizeId, string> {
  // Film shot sizes (a context: 近景／中景／遠景 also mean foreground／middle ground／background, 全身 a full-body picture)
  return {
    ecu: t("大特寫", undefined, { context: "shot-size" }),
    cu: t("特寫", undefined, { context: "shot-size" }),
    mcu: t("近景", undefined, { context: "shot-size" }),
    ms: t("中景", undefined, { context: "shot-size" }),
    fs: t("全身", undefined, { context: "shot-size" }),
    ws: t("遠景", undefined, { context: "shot-size" }),
  };
}

export interface SubjectCheck {
  /** N of <Subject N>. */
  number: number;
  /** What the subject chip writes after <Subject N> ("" = the tag alone). */
  phrase: string;
  /** Word stems that tell this character apart (empty = nothing to check). */
  words: readonly string[];
}

export type ShotIssue =
  | { kind: "empty" }
  | { kind: "marker" }
  | { kind: "size" }
  | { kind: "subject" }
  | { kind: "undefined"; subject: number }
  | { kind: "features"; subject: number; phrase: string }
  | { kind: "viewpoint" }
  | { kind: "negation"; word: string };

export interface TextEdit {
  text: string;
  /** Where the caret goes after the edit. */
  caret: number;
}

/** A shot size named anywhere in the description. */
const SIZE_RE =
  /\b(?:(?:extreme|very)[ -]close[ -]?ups?|close[ -]?ups?|medium[ -]close[ -]?ups?|(?:medium|mid)[ -](?:long[ -]|wide[ -]|full[ -])?shots?|waist[ -]up|chest[ -]up|bust[ -]shots?|knee[ -](?:up|length|shots?)|cowboy[ -]shots?|full[ -](?:body[ -])?shots?|full[ -]length|wide[ -]shots?|(?:extreme|very)[ -]wide|long[ -]shots?|establishing[ -]shots?|two[ -]shots?|over[ -]the[ -]shoulder|head[ -]and[ -]shoulders|insert[ -]shots?|aerial[ -]shots?)\b/i;
/** The opening shot-size phrase a size chip replaces ("A close-up of", "a waist-up medium shot of"…). */
const OPENING_RE =
  /^(?:an?\s+)?(?:(?:extreme|very)\s+close[ -]?up|close[ -]?up|(?:chest[ -]up\s+)?medium\s+close[ -]?up|(?:waist[ -]up\s+)?medium\s+shot|full(?:[ -]body)?\s+shot|(?:extreme\s+)?wide\s+shot|long\s+shot)\s+of\b[ \t]*/i;
const SUBJECT_TAG_RE = /<Subject[ \t]*(\d{1,3})>/gi;
const MARKER_RE = /\[Shot[ \t]*\d/;

/** The size chip whose phrase opens the description, if any. */
export function currentShotSize(text: string): ShotSizeId | null {
  const head = text.trimStart().toLowerCase();
  const size = SHOT_SIZES.find((item) => head.startsWith(item.phrase.toLowerCase()) && /^(?:\s|$)/.test(head.slice(item.phrase.length)));
  return size?.id ?? null;
}

/** The size phrase as a chip writes it: lower case when the description continues `At 00:01.209, `. */
export function sizePhrase(size: ShotSize, lowerCase: boolean): string {
  return lowerCase ? size.phrase.charAt(0).toLowerCase() + size.phrase.slice(1) : size.phrase;
}

/** Puts a shot size at the start: it replaces the opening shot-size phrase or goes in front of the text (an article there turns lower case). */
export function applyShotSize(text: string, size: ShotSize, lowerCase: boolean): TextEdit {
  const phrase = sizePhrase(size, lowerCase);
  const body = text.trimStart();
  const opening = OPENING_RE.exec(body);
  const rest = opening ? body.slice(opening[0].length) : body.replace(/^(?:The|A|An|This|That|Her|His|Their|Its)\b/, (word) => word.toLowerCase());
  return { text: `${phrase} ${rest}`, caret: phrase.length + 1 };
}

/** What a subject chip writes: `<Subject 1> with long pink hair and a gold hair clip`. */
export function subjectInsertion(subject: Pick<SubjectCheck, "number" | "phrase">): string {
  const phrase = subject.phrase.trim();
  return phrase === "" ? `<Subject ${subject.number}>` : `<Subject ${subject.number}> ${phrase}`;
}

/** The subjects a description names (<Subject N>, by number): the pressed character chips. */
export function namedSubjects(text: string): Set<number> {
  return new Set([...text.matchAll(SUBJECT_TAG_RE)].map((match) => Number(match[1])));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where a viewpoint chip's phrase is: the earliest one, and at one place the longer (seen from behind at a three-quarter angle, not seen from behind). */
function viewpointSpan(text: string): { viewpoint: Viewpoint; start: number; end: number } | null {
  let best: { viewpoint: Viewpoint; start: number; end: number } | null = null;
  for (const viewpoint of VIEWPOINTS) {
    const found = new RegExp(escapeRegExp(viewpoint.phrase), "i").exec(text);
    if (!found) continue;
    const end = found.index + found[0].length;
    if (!best || found.index < best.start || (found.index === best.start && end > best.end)) best = { viewpoint, start: found.index, end };
  }
  return best;
}

/** The viewpoint chip whose phrase the description has, if any. */
export function currentViewpoint(text: string): ViewpointId | null {
  return viewpointSpan(text)?.viewpoint.id ?? null;
}

/** <Subject N> with its signature phrase, and the characters joined to it ("and <Subject 2> …", ", <Subject 3>"): where the line's characters end. */
function charactersEnd(text: string, subjects: readonly Pick<SubjectCheck, "number" | "phrase">[]): number | null {
  const first = /<Subject[ \t]*\d{1,3}>/i.exec(text);
  if (!first) return null;
  let end = first.index;
  // One character after another: the tag, its signature phrase, then "and" or a comma right before the next tag
  for (;;) {
    const tag = /^<Subject[ \t]*(\d{1,3})>/i.exec(text.slice(end));
    if (!tag) return end;
    end += tag[0].length;
    const phrase = subjects.find((subject) => subject.number === Number(tag[1]))?.phrase.trim() ?? "";
    if (phrase !== "" && text.startsWith(` ${phrase}`, end)) end += phrase.length + 1;
    const joined = /^(?:,?[ \t]+and|,)[ \t]+(?=<Subject[ \t]*\d{1,3}>)/i.exec(text.slice(end));
    if (!joined) return end;
    end += joined[0].length;
  }
}

/**
 * Writes a viewpoint: it replaces the phrase of another viewpoint chip, or goes right after the characters the line
 * names (`… with long pink hair, seen from behind, walking …`); without a character, before the end of the first
 * sentence.
 */
export function applyViewpoint(text: string, viewpoint: Viewpoint, subjects: readonly Pick<SubjectCheck, "number" | "phrase">[]): TextEdit {
  const current = viewpointSpan(text);
  if (current) return { text: text.slice(0, current.start) + viewpoint.phrase + text.slice(current.end), caret: current.start + viewpoint.phrase.length };
  const body = text.trimEnd();
  if (body.trim() === "") return { text: viewpoint.phrase, caret: viewpoint.phrase.length };
  const sentence = /[.!?](?=\s|$)/.exec(body);
  const spot = charactersEnd(body, subjects) ?? sentence?.index ?? body.length;
  const before = body.slice(0, spot).replace(/[ \t]+$/, "");
  const after = body.slice(spot);
  const insertion = `${before === "" ? "" : ", "}${viewpoint.phrase}`;
  // A word right after it needs the comma that closes the inserted phrase
  const tail = /^[ \t]*[A-Za-z0-9<@(]/.test(after) ? `,${/^[ \t]/.test(after) ? "" : " "}` : "";
  return { text: `${before}${insertion}${tail}${after}`, caret: before.length + insertion.length };
}

/**
 * Takes a character out of the description (its character chip pressed again): every <Subject N> of that number with
 * the signature phrase right after it, and the "and" or comma that joined it to the other characters.
 */
export function removeSubject(text: string, subject: Pick<SubjectCheck, "number" | "phrase">): TextEdit {
  const phrase = subject.phrase.trim();
  const spans = [...text.matchAll(/<Subject[ \t]*(\d{1,3})>/gi)].filter((match) => Number(match[1]) === subject.number).map((match) => ({ start: match.index, end: match.index + match[0].length }));
  let out = text;
  let caret = text.length;
  for (const span of spans.reverse()) {
    let { start, end } = span;
    if (phrase !== "" && out.startsWith(` ${phrase}`, end)) end += phrase.length + 1;
    const joinedBefore = /(?:,?[ \t]+and|,)[ \t]+$/i.exec(out.slice(0, start));
    const joinedAfter = joinedBefore ? null : /^(?:,?[ \t]+and|,)[ \t]+/i.exec(out.slice(end));
    if (joinedBefore) start -= joinedBefore[0].length;
    else if (joinedAfter) end += joinedAfter[0].length;
    else if (/[ \t]$/.test(out.slice(0, start)) && /^(?:[ \t]|[,.;:!?]|$)/.test(out.slice(end))) start -= 1;
    // At the very start the description goes on from the next word
    if (start === 0) end += /^[ \t]*/.exec(out.slice(end))?.[0].length ?? 0;
    out = out.slice(0, start) + out.slice(end);
    caret = start;
  }
  return { text: out, caret: Math.min(caret, out.length) };
}

/** Inserts at the selection [start, end), with a space on each side where a word would otherwise touch it. */
export function insertAt(text: string, start: number, end: number, insertion: string): TextEdit {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const trail = after === "" || /^[\s,.;:!?)]/.test(after) ? "" : " ";
  const head = `${before}${lead}${insertion}${trail}`;
  return { text: `${head}${after}`, caret: head.length };
}

export function shotIssues(text: string, subjects: readonly SubjectCheck[]): ShotIssue[] {
  const clean = cleanShotText(text);
  if (clean === "") return [{ kind: "empty" }];
  const issues: ShotIssue[] = [];
  if (MARKER_RE.test(clean)) issues.push({ kind: "marker" });
  if (!SIZE_RE.test(clean)) issues.push({ kind: "size" });
  if (subjects.length === 0) return issues;
  const named = [...new Set([...clean.matchAll(SUBJECT_TAG_RE)].map((match) => Number(match[1])))];
  if (named.length === 0) issues.push({ kind: "subject" });
  const words = new Set(wordStems(clean));
  for (const number of named) {
    const subject = subjects.find((item) => item.number === number);
    if (!subject) issues.push({ kind: "undefined", subject: number });
    else if (subject.words.length > 0 && !subject.words.some((word) => words.has(word))) issues.push({ kind: "features", subject: number, phrase: subject.phrase.trim() });
  }
  if (named.length > 0 && statedViewpoint(clean) === null) issues.push({ kind: "viewpoint" });
  const negation = negationWord(clean);
  if (negation !== null) issues.push({ kind: "negation", word: negation });
  return issues;
}

/** An issue that keeps the description from being saved. */
export function blocksSave(issue: ShotIssue): boolean {
  return issue.kind === "empty" || issue.kind === "marker";
}

export function issueKey(issue: ShotIssue): string {
  return issue.kind === "undefined" || issue.kind === "features" ? `${issue.kind}:${issue.subject}` : issue.kind;
}

/** One short sentence: what is missing and what to add. */
export function issueText(issue: ShotIssue): string {
  switch (issue.kind) {
    case "empty":
      return t("描述是空的：寫出景別、角色、姿勢、動作與場景");
    case "marker":
      return t("描述裡不能有 [Shot n]：H3 會把它當成另一次切鏡，改用文字描述");
    case "size":
      return t("沒寫景別：用景別按鈕放在開頭，否則 H3 容易畫成人設圖的全身站姿");
    case "subject":
      return t("沒寫出角色：用角色按鈕加上 <Subject N>（沒有角色的空鏡可以不管）");
    case "undefined":
      return t("{subject} 沒有定義：subject_definitions 裡沒有這個角色", { subject: `<Subject ${issue.subject}>` });
    case "features":
      return issue.phrase === ""
        ? t("{subject} 沒寫特徵：加上髮色和一個配件，否則快速動作的鏡頭會畫回原角色", { subject: `<Subject ${issue.subject}>` })
        : t("{subject} 沒寫特徵：加上「{phrase}」，否則快速動作的鏡頭會畫回原角色", { subject: `<Subject ${issue.subject}>`, phrase: issue.phrase });
    case "viewpoint":
      return t("沒寫視角：看著左邊的參考畫面按視角按鈕；寫得和原片相反時，H3 會照抄原片那一鏡");
    case "negation":
      return t("有否定詞「{word}」：H3 會畫出被否定的東西，改成描述畫面上有的東西", { word: issue.word });
  }
}
