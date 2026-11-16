// Prompt 結構掃描（純函式，不改字）：H3 欄位、分鏡標記、自訂時間標題、段落與鏡頭片段、<d> 台詞、@ 名稱、
// H3 標籤、Markdown 殘留與 I2VA／FL2VA 對齊行。所有位置都是原文的 [start, end)。
//
// 分鏡標記有三種寫法：
//  - [Shot 1]：開場鏡頭（官方：第一鏡不加時間戳）
//  - [Shot 2] At 00:03.000, …：之後的切鏡（官方 Base／Full-Reference 指南 §4.2／§5.1）
//  - [Shot 1, 00:00.000-00:02.000] …：同一鏡頭內的時段（官方加速 LoRA 範例 predict_ref2v.py；MiniMax 指南未記載）
import { parseCueTime } from "./timing";
import { t } from "@/i18n";

export const BASE_FIELDS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"] as const;
export const REF_FIELDS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
] as const;
export type FieldName = (typeof BASE_FIELDS)[number] | (typeof REF_FIELDS)[number];
export const ALL_FIELDS: readonly FieldName[] = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "integrated_multimodal_description",
  "overall_soundscape",
  "non_diegetic_music",
];
const REF_ONLY_FIELDS: readonly FieldName[] = ["subject_definitions", "summary", "retention_analysis", "detailed_description"];

export function isRefOnlyField(name: FieldName): boolean {
  return REF_ONLY_FIELDS.includes(name);
}

// 行首的欄位名稱：可帶縮排、# 標題或 ** 粗體（Markdown 殘留另有規則），冒號可為全形。
const SECTION_SOURCE = String.raw`^([ \t]*)(#{1,6}[ \t]+)?(\*\*|__)?(${ALL_FIELDS.join("|")})(\*\*|__)?[ \t]*[:：][ \t]*(\*\*|__)?`;
const SHOT_SOURCE = String.raw`\[Shot[ \t]*(\d{1,3})(?:[ \t]*,[ \t]*([0-9:.]{1,12})[ \t]*[-–—~～][ \t]*([0-9:.]{1,12}))?[ \t]*\](?:([ \t]*)At[ \t]+([0-9:.]{1,12})(?:[ \t]*(?:seconds|second|secs|sec|s)(?![A-Za-z]))?[ \t]*(,)?)?`;
const NUM = String.raw`(\d{1,3}(?:\.\d{1,3})?)`;
const UNIT = String.raw`(?:秒鐘|秒|seconds|second|secs|sec|s(?![A-Za-z]))`;
const DASH = String.raw`[ \t]*(?:[–—―~～〜\-－]|至|到)[ \t]*`;
const COLON = "[：:]";
const TIME_HEADING_SOURCES = [
  // **0.0–1.5 秒：** 內容／**0–1.5s**：內容
  { style: "bold", source: String.raw`^([ \t]*)(\*\*|__)[ \t]*${NUM}[ \t]*(?:${UNIT})?${DASH}${NUM}[ \t]*(?:${UNIT})?[ \t]*(?:${COLON})?[ \t]*\2[ \t]*(?:${COLON})?[ \t]*` },
  // 【0–1.5 秒】內容／[0-1.5s] 內容
  { style: "bracket", source: String.raw`^([ \t]*)[【\[][ \t]*${NUM}[ \t]*(?:${UNIT})?${DASH}${NUM}[ \t]*(?:${UNIT})?[ \t]*[】\]][ \t]*(?:${COLON})?[ \t]*` },
  // 0.0–1.5 秒：內容（必須有單位與冒號）
  { style: "plain", source: String.raw`^([ \t]*)${NUM}[ \t]*(?:${UNIT})?${DASH}${NUM}[ \t]*${UNIT}[ \t]*${COLON}[ \t]*` },
] as const;
const MENTION_SOURCE = String.raw`@(image|video|audio)([1-9][0-9]?)(?![0-9A-Za-z_])`;
const LABEL_SOURCE = String.raw`<(Picture|Video|Audio|Subject)[ \t]*(\d{1,3})>`;
const I2VA_LINE_SOURCE = String.raw`^[ \t]*For the target video,[ \t]*at[ \t]+[\d.]+[ \t]+seconds into the target video,[ \t]*<Picture[ \t]*1>[^\n]*?fully referenced\.?[ \t]*$`;
const PAIR_LINE_SOURCE = String.raw`^[ \t]*How the reference pictures align with the target video\b[^\n]*$`;

export interface Section {
  name: FieldName;
  /** 欄位名稱與官方寫法完全相同（小寫）。 */
  exactName: boolean;
  /** 欄位名稱帶 Markdown（# 或 **）。 */
  decorated: boolean;
  /** 行首（含縮排）。 */
  lineStart: number;
  /** 第一個非空白字元。 */
  headStart: number;
  nameStart: number;
  nameEnd: number;
  /** 標題（名稱、冒號與同一行的空白）結束處。 */
  headerEnd: number;
  /** 內容的第一個非空白字元（冒號後換行時在下一行）。 */
  bodyStart: number;
  /** 下一個欄位的行首或全文結尾。 */
  end: number;
  /** 內容（去掉尾端空白）。 */
  body: string;
}

export interface ShotMarker {
  start: number;
  /** 整個標記（含 At …,）的結尾。 */
  end: number;
  /** [Shot …] 本身的結尾。 */
  bracketEnd: number;
  shot: number;
  style: "plain" | "cut" | "range";
  /** [Shot n] At mm:ss.sss, 的時間部分：start／end 含前面的空白與後面的逗號；textStart 是時間文字本身的位置。 */
  at: { text: string; textStart: number; seconds: number | null; start: number; end: number } | null;
  /** [Shot n, a-b] 的時段（startAt／endAt 是兩個時間文字的位置）。 */
  range: { startText: string; endText: string; startAt: number; endAt: number; start: number | null; end: number | null } | null;
}

export interface TimeHeading {
  /** 標題第一個非空白字元。 */
  start: number;
  /** 標題（含後面的空白）結尾＝內容開始。 */
  end: number;
  from: number;
  to: number;
  style: "bold" | "bracket" | "plain";
}

export interface Paragraph {
  start: number;
  end: number;
}

export interface Segment {
  kind: "shot" | "time" | "paragraph";
  start: number;
  end: number;
  /** 顯示用：[Shot 2]、1.5–3 秒、第 3 段。 */
  label: string;
  shot: ShotMarker | null;
  heading: TimeHeading | null;
  section: FieldName | null;
}

export interface Dialogue {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  closed: boolean;
  /** <d>[Chinese] …</d> 的語言標籤；沒有 → null。 */
  tag: string | null;
}

export type RefKind = "image" | "video" | "audio";

export interface Mention {
  start: number;
  end: number;
  raw: string;
  kind: RefKind;
  ordinal: number;
  /** 正確大小寫的名稱（Image1）。 */
  alias: string;
  exactCase: boolean;
}

export interface LabelHit {
  start: number;
  end: number;
  tag: "Picture" | "Video" | "Audio" | "Subject";
  ordinal: number;
}

export interface MarkdownHit {
  start: number;
  end: number;
  kind: "bold" | "heading" | "fence" | "code" | "italic";
}

export interface AlignmentLine {
  kind: "i2va" | "pair";
  start: number;
  end: number;
  /** 是全文第一個非空白行。 */
  first: boolean;
  /** 下一行是空行（或後面沒有其他文字）。 */
  blankAfter: boolean;
}

export interface PromptScan {
  text: string;
  sections: Section[];
  shots: ShotMarker[];
  headings: TimeHeading[];
  paragraphs: Paragraph[];
  segments: Segment[];
  dialogues: Dialogue[];
  mentions: Mention[];
  labels: LabelHit[];
  markdown: MarkdownHit[];
  alignment: AlignmentLine[];
}

const PREFIX: Record<RefKind, string> = { image: "Image", video: "Video", audio: "Audio" };

function isSpace(char: string): boolean {
  return /\s/u.test(char);
}

export function scanSections(text: string): Section[] {
  const heads: Omit<Section, "bodyStart" | "end" | "body">[] = [];
  for (const match of text.matchAll(new RegExp(SECTION_SOURCE, "gim"))) {
    const lineStart = match.index;
    const indent = match[1] ?? "";
    const hashes = match[2] ?? "";
    const open = match[3] ?? "";
    const raw = match[4] ?? "";
    const nameStart = lineStart + indent.length + hashes.length + open.length;
    heads.push({
      name: raw.toLowerCase() as FieldName,
      exactName: raw === raw.toLowerCase(),
      decorated: Boolean(hashes || open || match[5] || match[6]),
      lineStart,
      headStart: lineStart + indent.length,
      nameStart,
      nameEnd: nameStart + raw.length,
      headerEnd: lineStart + match[0].length,
    });
  }
  return heads.map((head, index) => {
    const end = heads[index + 1]?.lineStart ?? text.length;
    let bodyStart = head.headerEnd;
    while (bodyStart < end && isSpace(text.charAt(bodyStart))) bodyStart += 1;
    return { ...head, bodyStart, end, body: text.slice(bodyStart, end).replace(/\s+$/u, "") };
  });
}

export function scanShots(text: string): ShotMarker[] {
  const out: ShotMarker[] = [];
  for (const match of text.matchAll(new RegExp(SHOT_SOURCE, "dgi"))) {
    const start = match.index;
    const whole = match[0];
    const closeIndex = whole.indexOf("]");
    const bracketEnd = start + closeIndex + 1;
    const rangeStart = match[2];
    const rangeEnd = match[3];
    const atText = match[5];
    const at5 = match.indices?.[5];
    const at2 = match.indices?.[2];
    const at3 = match.indices?.[3];
    const range =
      rangeStart !== undefined && rangeEnd !== undefined && at2 && at3
        ? { startText: rangeStart, endText: rangeEnd, startAt: at2[0], endAt: at3[0], start: parseCueTime(rangeStart), end: parseCueTime(rangeEnd) }
        : null;
    const at = atText !== undefined && at5 ? { text: atText, textStart: at5[0], seconds: parseCueTime(atText), start: bracketEnd, end: start + whole.length } : null;
    out.push({
      start,
      end: start + whole.length,
      bracketEnd,
      shot: Number(match[1]),
      style: range ? "range" : at ? "cut" : "plain",
      at,
      range,
    });
  }
  return out;
}

/** 不是鏡頭描述的欄位：這些欄位裡的 [Shot n] 是「提到某個鏡頭」，不是分鏡標記。 */
const NON_DESCRIPTION_FIELDS: readonly FieldName[] = ["subject_definitions", "summary", "retention_analysis", "overall_soundscape", "non_diegetic_music"];

/**
 * 真正的分鏡標記：排除對齊句裡的「(from [Shot 1])」，以及 subject_definitions／summary／retention_analysis／聲音欄位裡
 * 「for [Shot 1], [Shot 2]」「(appears in [Shot 1])」這類提到鏡頭的寫法。
 */
export function scanShotMarkers(text: string, sections: readonly Section[] = scanSections(text), alignment: readonly AlignmentLine[] = scanAlignment(text)): ShotMarker[] {
  return scanShots(text).filter(
    (shot) =>
      !alignment.some((line) => shot.start >= line.start && shot.start < line.end) &&
      !sections.some((section) => NON_DESCRIPTION_FIELDS.includes(section.name) && shot.start >= section.headStart && shot.start < section.end),
  );
}

export function scanTimeHeadings(text: string): TimeHeading[] {
  const out: TimeHeading[] = [];
  for (const { style, source } of TIME_HEADING_SOURCES) {
    for (const match of text.matchAll(new RegExp(source, "gim"))) {
      const indent = match[1] ?? "";
      const from = Number(style === "bold" ? match[3] : match[2]);
      const to = Number(style === "bold" ? match[4] : match[3]);
      out.push({ start: match.index + indent.length, end: match.index + match[0].length, from, to, style });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function scanParagraphs(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  const push = (from: number, to: number) => {
    let start = from;
    let end = to;
    while (start < end && isSpace(text.charAt(start))) start += 1;
    while (end > start && isSpace(text.charAt(end - 1))) end -= 1;
    if (end > start) out.push({ start, end });
  };
  let cursor = 0;
  for (const match of text.matchAll(/\n[ \t\u3000\r]*\n/g)) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, text.length);
  return out;
}

function trimRange(text: string, from: number, to: number): Paragraph | null {
  let start = from;
  let end = to;
  while (start < end && isSpace(text.charAt(start))) start += 1;
  while (end > start && isSpace(text.charAt(end - 1))) end -= 1;
  return end > start ? { start, end } : null;
}

function sectionNameAt(sections: readonly Section[], offset: number): FieldName | null {
  let found: FieldName | null = null;
  for (const section of sections) if (section.headStart <= offset && offset < section.end) found = section.name;
  return found;
}

function scanSegments(text: string, paragraphs: readonly Paragraph[], sections: readonly Section[], shots: readonly ShotMarker[], headings: readonly TimeHeading[]): Segment[] {
  // 段落再依欄位標題切開（標題文字本身不屬於任何片段）
  const pieces: Paragraph[] = [];
  for (const paragraph of paragraphs) {
    let cursor = paragraph.start;
    for (const section of sections) {
      if (section.headStart < paragraph.start || section.headStart >= paragraph.end) continue;
      const before = trimRange(text, cursor, section.headStart);
      if (before) pieces.push(before);
      cursor = Math.max(cursor, Math.min(section.headerEnd, paragraph.end));
    }
    const rest = trimRange(text, cursor, paragraph.end);
    if (rest) pieces.push(rest);
  }
  const markers = [
    ...shots.map((shot) => ({ start: shot.start, shot, heading: null })),
    ...headings.map((heading) => ({ start: heading.start, shot: null, heading })),
  ].sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let paragraphCount = 0;
  const pushParagraph = (range: Paragraph | null) => {
    if (!range) return;
    paragraphCount += 1;
    out.push({ kind: "paragraph", ...range, label: t("第 {paragraphCount} 段", { paragraphCount }), shot: null, heading: null, section: sectionNameAt(sections, range.start) });
  };
  for (const piece of pieces) {
    const inside = markers.filter((marker) => marker.start >= piece.start && marker.start < piece.end);
    const first = inside[0];
    if (!first) {
      pushParagraph(piece);
      continue;
    }
    pushParagraph(trimRange(text, piece.start, first.start));
    inside.forEach((marker, index) => {
      const range = trimRange(text, marker.start, inside[index + 1]?.start ?? piece.end);
      if (!range) return;
      const section = sectionNameAt(sections, range.start);
      if (marker.shot) {
        out.push({ kind: "shot", ...range, label: text.slice(marker.shot.start, marker.shot.bracketEnd), shot: marker.shot, heading: null, section });
      } else if (marker.heading) {
        out.push({ kind: "time", ...range, label: t("{from}–{to} 秒", { from: marker.heading.from, to: marker.heading.to }), shot: null, heading: marker.heading, section });
      }
    });
  }
  return out;
}

export function scanDialogues(text: string): Dialogue[] {
  const out: Dialogue[] = [];
  const tagOf = (inner: string) => /^\s*\[([A-Za-z][A-Za-z -]{0,30})\]/.exec(inner)?.[1] ?? null;
  let open: number | null = null;
  for (const match of text.matchAll(/<\/?d>/g)) {
    const closing = match[0].startsWith("</");
    if (!closing) {
      if (open !== null) out.push({ start: open, end: open + 3, innerStart: open + 3, innerEnd: open + 3, closed: false, tag: null });
      open = match.index;
      continue;
    }
    if (open === null) {
      out.push({ start: match.index, end: match.index + match[0].length, innerStart: match.index, innerEnd: match.index, closed: false, tag: null });
      continue;
    }
    const inner = text.slice(open + 3, match.index);
    out.push({ start: open, end: match.index + match[0].length, innerStart: open + 3, innerEnd: match.index, closed: true, tag: tagOf(inner) });
    open = null;
  }
  if (open !== null) out.push({ start: open, end: open + 3, innerStart: open + 3, innerEnd: open + 3, closed: false, tag: null });
  return out.sort((a, b) => a.start - b.start);
}

export function scanMentions(text: string): Mention[] {
  return [...text.matchAll(new RegExp(MENTION_SOURCE, "gi"))].map((match) => {
    const word = (match[1] ?? "").toLowerCase() as RefKind;
    const ordinal = Number(match[2]);
    const alias = `${PREFIX[word]}${ordinal}`;
    return { start: match.index, end: match.index + match[0].length, raw: match[0], kind: word, ordinal, alias, exactCase: match[0].slice(1) === alias };
  });
}

export function scanLabels(text: string): LabelHit[] {
  return [...text.matchAll(new RegExp(LABEL_SOURCE, "g"))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    tag: match[1] as LabelHit["tag"],
    ordinal: Number(match[2]),
  }));
}

export function scanMarkdown(text: string): MarkdownHit[] {
  const hits: MarkdownHit[] = [];
  const fences: Paragraph[] = [];
  for (const match of text.matchAll(/^[ \t]*```[^\n]*$/gm)) {
    const range = { start: match.index, end: match.index + match[0].length };
    fences.push(range);
    hits.push({ ...range, kind: "fence" });
  }
  const inFence = (offset: number) => fences.some((fence) => offset >= fence.start && offset < fence.end);
  for (const match of text.matchAll(/\*\*|__/g)) if (!inFence(match.index)) hits.push({ start: match.index, end: match.index + 2, kind: "bold" });
  for (const match of text.matchAll(/^[ \t]*(#{1,6})[ \t]+/gm)) {
    const start = match.index + match[0].indexOf("#");
    hits.push({ start, end: start + (match[1] ?? "").length, kind: "heading" });
  }
  for (const match of text.matchAll(/`[^`\n]+`/g)) if (!inFence(match.index)) hits.push({ start: match.index, end: match.index + match[0].length, kind: "code" });
  for (const match of text.matchAll(/(?<![*\w])\*(?=[^\s*])[^*\n]*?[^\s*]\*(?![*\w])/g)) hits.push({ start: match.index, end: match.index + match[0].length, kind: "italic" });
  return hits.sort((a, b) => a.start - b.start);
}

export function scanAlignment(text: string): AlignmentLine[] {
  const firstContent = text.search(/\S/u);
  const out: AlignmentLine[] = [];
  for (const [kind, source] of [
    ["i2va", I2VA_LINE_SOURCE],
    ["pair", PAIR_LINE_SOURCE],
  ] as const) {
    for (const match of text.matchAll(new RegExp(source, "gim"))) {
      const indent = /^[ \t]*/.exec(match[0])?.[0].length ?? 0;
      const start = match.index + indent;
      const end = match.index + match[0].length;
      const after = text.slice(end);
      out.push({ kind, start, end, first: start === firstContent, blankAfter: after.trim() === "" || /^[ \t]*\r?\n[ \t\r]*\n/.test(after) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function scanPrompt(text: string): PromptScan {
  const sections = scanSections(text);
  const alignment = scanAlignment(text);
  const shots = scanShotMarkers(text, sections, alignment);
  const headings = scanTimeHeadings(text);
  const paragraphs = scanParagraphs(text);
  return {
    text,
    sections,
    shots,
    headings,
    paragraphs,
    segments: scanSegments(text, paragraphs, sections, shots, headings),
    dialogues: scanDialogues(text),
    mentions: scanMentions(text),
    labels: scanLabels(text),
    markdown: scanMarkdown(text),
    alignment,
  };
}

/** 第一個同名欄位。 */
export function sectionOf(scan: PromptScan, name: FieldName): Section | undefined {
  return scan.sections.find((section) => section.name === name);
}

/** offset 所在的欄位（沒有 → null）。 */
export function sectionAt(scan: PromptScan, offset: number): Section | null {
  let found: Section | null = null;
  for (const section of scan.sections) if (section.headStart <= offset && offset < section.end) found = section;
  return found;
}
