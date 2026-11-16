// 修正用的文字轉換（純函式）。每個函式都從「傳進來的文字」重新找出問題再修正，不依賴分析當下的位置；
// 對已修正的文字再套用一次結果不變（冪等）。呼叫端一定先預覽差異，使用者確認後才套用。
import {
  BASE_FIELDS,
  REF_FIELDS,
  scanAlignment,
  scanDialogues,
  scanMentions,
  scanPrompt,
  scanSections,
  scanShotMarkers,
  scanTimeHeadings,
  type FieldName,
  type PromptScan,
  type Segment,
} from "./parse";
import type { LabelPlan } from "./labels";
import { I2VA_ALIGNMENT_LINE, PLACEHOLDER, retentionLines, shotAppearances, subjectDefinitionLines } from "./templates";
import { guessLanguageTag } from "./text";
import { formatCueTime, isCanonicalCueTime } from "./timing";

interface Edit {
  start: number;
  end: number;
  insert: string;
}

/** 依位置由後往前套用；與前一個（較後面的）修改重疊的會被略過。 */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let limit = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > limit) continue;
    out = out.slice(0, edit.start) + edit.insert + out.slice(edit.end);
    limit = edit.start;
  }
  return out;
}

/** 刪除整行（含換行）；被刪的行在開頭或前一行是空行時，順便刪掉後面一個空行，避免留下連續空行。 */
function removeWholeLines(text: string, ranges: readonly { start: number; end: number }[]): string {
  const edits = ranges.map((range) => {
    let start = text.lastIndexOf("\n", range.start - 1) + 1;
    const newline = text.indexOf("\n", range.end);
    // 最後一行：連同前面的空行一起刪，不留下結尾空行
    if (newline < 0) start = text.slice(0, start).replace(/[ \t\r\n]+$/u, "").length;
    let end = newline < 0 ? text.length : newline + 1;
    const before = text.slice(0, start);
    const previousBlank = start === 0 || /(?:^|\n)[ \t\r]*\n$/.test(before);
    const blankNext = /^[ \t\r]*\n/.exec(text.slice(end));
    if (previousBlank && blankNext) end += blankNext[0].length;
    return { start, end, insert: "" };
  });
  return applyEdits(text, edits);
}

/** 移除 Markdown 標記、保留文字：``` 區塊線、`程式碼`、行首 #、**／__、*斜體*。 */
export function stripMarkdown(text: string): string {
  let out = text.replace(/^[ \t]*```[^\n]*(?:\n|$)/gm, "");
  out = out.replace(/`([^`\n]+)`/g, "$1");
  out = out.replace(/^([ \t]*)#{1,6}[ \t]+/gm, "$1");
  out = out.replace(/\*\*|__/g, "");
  out = out.replace(/(?<![*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1");
  return out;
}

/** 自訂時間標題 → 官方分鏡標記：第一段 [Shot 1]，之後 [Shot n] At mm:ss.sss,（時間取該段的起點）。 */
export function convertTimeHeadings(text: string): string {
  const headings = scanTimeHeadings(text);
  return applyEdits(
    text,
    headings.map((heading, index) => {
      const marker = index === 0 ? "[Shot 1]" : `[Shot ${index + 1}] At ${formatCueTime(heading.from)},`;
      const next = text.charAt(heading.end);
      const separator = heading.end >= text.length || next === "\n" || next === "\r" ? "" : " ";
      return { start: heading.start, end: heading.end, insert: marker + separator };
    }),
  );
}

/** 第一個鏡頭不加時間戳：刪掉第一個 [Shot …] 後面的 At mm:ss.sss,。 */
export function removeFirstShotTime(text: string): string {
  const first = scanShotMarkers(text)[0];
  if (!first?.at || first.style !== "cut") return text;
  const next = text.charAt(first.at.end);
  const separator = first.at.end < text.length && !/\s/u.test(next) ? " " : "";
  return text.slice(0, first.at.start) + separator + text.slice(first.at.end);
}

/** [Shot n]／[Shot n] At … 依出現順序重新編號 1、2、3…（[Shot n, a-b] 時段寫法不動）。 */
export function renumberShots(text: string): string {
  const edits: Edit[] = [];
  scanShotMarkers(text)
    .filter((shot) => shot.style !== "range")
    .forEach((shot, index) => {
      if (shot.shot === index + 1) return;
      const digits = /\d+/.exec(text.slice(shot.start, shot.bracketEnd));
      if (!digits) return;
      const start = shot.start + digits.index;
      edits.push({ start, end: start + digits[0].length, insert: String(index + 1) });
    });
  return applyEdits(text, edits);
}

/** 把 At 與時段的時間改成官方 MM:SS.mmm。 */
export function canonicalizeCueTimes(text: string): string {
  const edits: Edit[] = [];
  for (const shot of scanShotMarkers(text)) {
    if (shot.at && shot.at.seconds !== null && !isCanonicalCueTime(shot.at.text)) {
      edits.push({ start: shot.at.textStart, end: shot.at.textStart + shot.at.text.length, insert: formatCueTime(shot.at.seconds) });
    }
    if (shot.range) {
      const { range } = shot;
      if (range.start !== null && !isCanonicalCueTime(range.startText)) edits.push({ start: range.startAt, end: range.startAt + range.startText.length, insert: formatCueTime(range.start) });
      if (range.end !== null && !isCanonicalCueTime(range.endText)) edits.push({ start: range.endAt, end: range.endAt + range.endText.length, insert: formatCueTime(range.end) });
    }
  }
  return applyEdits(text, edits);
}

const RANK: Record<FieldName, number> = {
  subject_definitions: 0,
  summary: 1,
  retention_analysis: 2,
  detailed_description: 3,
  integrated_multimodal_description: 3,
  overall_soundscape: 4,
  non_diegetic_music: 5,
};

export function sectionRank(name: FieldName): number {
  return RANK[name];
}

/** 欄位依官方順序重排（欄位之前的文字保持在最前面）；已經是官方順序時原樣傳回。 */
export function reorderSections(text: string): string {
  const sections = scanSections(text);
  const first = sections[0];
  if (!first || sections.length < 2) return text;
  const chunks = sections.map((section, index) => ({ rank: RANK[section.name], index, body: text.slice(section.lineStart, section.end).replace(/\s+$/u, "") }));
  const sorted = [...chunks].sort((a, b) => a.rank - b.rank || a.index - b.index);
  if (sorted.every((chunk, index) => chunk === chunks[index])) return text;
  const preamble = text.slice(0, first.lineStart);
  const head = preamble.trim() ? `${preamble.replace(/\s+$/u, "")}\n\n` : "";
  return `${head}${sorted.map((chunk) => chunk.body).join("\n\n")}${/\n\s*$/u.test(text) ? "\n" : ""}`;
}

/**
 * 一個新欄位的內容：角色與保留的行依參考素材預先填好（retention 的 appears in 取自 text 裡 @ 名稱所在的鏡頭），
 * 其他是寫著該填什麼的 [TODO: …]。
 */
function sectionChunk(name: FieldName, block: boolean, plan: LabelPlan, text: string): string {
  const body: Record<FieldName, () => string> = {
    integrated_multimodal_description: () => PLACEHOLDER.shot1,
    overall_soundscape: () => PLACEHOLDER.soundscape,
    non_diegetic_music: () => PLACEHOLDER.music,
    subject_definitions: () => subjectDefinitionLines(plan),
    summary: () => PLACEHOLDER.summary,
    retention_analysis: () => retentionLines(plan, shotAppearances(text, plan)),
    detailed_description: () => `${PLACEHOLDER.styleOpening}\n${PLACEHOLDER.refShot1}`,
  };
  return block ? `${name}:\n${body[name]()}` : `${name}: ${body[name]()}`;
}

/** 補上缺少的欄位（放在官方順序的位置，內容是 [TODO: …]）。format＝base（三欄）或 ref（六段）。 */
export function addMissingSections(text: string, format: "base" | "ref", plan: LabelPlan): string {
  const sections = scanSections(text);
  const present = new Set(sections.map((section) => section.name));
  const order: readonly FieldName[] = format === "ref" ? REF_FIELDS : BASE_FIELDS;
  const hasMain = present.has("detailed_description") || present.has("integrated_multimodal_description");
  const missing = order.filter((name) => !present.has(name) && !((name === "detailed_description" || name === "integrated_multimodal_description") && hasMain));
  if (missing.length === 0) return text;
  const block = format === "ref";
  const inserts = new Map<number, string[]>();
  const appended: string[] = [];
  for (const name of missing) {
    const anchor = sections.find((section) => RANK[section.name] > RANK[name]);
    const chunk = sectionChunk(name, block, plan, text);
    if (anchor) inserts.set(anchor.lineStart, [...(inserts.get(anchor.lineStart) ?? []), chunk]);
    else appended.push(chunk);
  }
  let out = applyEdits(
    text,
    [...inserts.entries()].map(([start, chunks]) => ({ start, end: start, insert: `${chunks.join("\n\n")}\n\n` })),
  );
  if (appended.length > 0) {
    const trimmed = out.replace(/\s+$/u, "");
    out = `${trimmed}${trimmed ? "\n\n" : ""}${appended.join("\n\n")}`;
  }
  return out;
}

/** 沒有任何欄位時：整段放進 integrated_multimodal_description，補上兩個聲音欄位（I2VA 對齊首行保持在最前面）。 */
export function wrapBaseFields(text: string, plan: LabelPlan): string {
  if (scanSections(text).length > 0) return text;
  const alignment = scanAlignment(text).find((line) => line.first);
  const head = alignment ? `${text.slice(alignment.start, alignment.end).trim()}\n\n` : "";
  const body = (alignment ? text.slice(alignment.end) : text).trim();
  return `${head}integrated_multimodal_description: ${body || PLACEHOLDER.shot1}\n\n${sectionChunk("overall_soundscape", false, plan, text)}\n\n${sectionChunk("non_diegetic_music", false, plan, text)}`;
}

/**
 * 沒有任何欄位時：整段放進 detailed_description，依參考素材補上其他五段（角色一行一個參考素材、要保留的外觀寫好
 * 出現的鏡頭；摘要與聲音留下寫著該填什麼的空段）。
 */
export function wrapRefSections(text: string, plan: LabelPlan): string {
  if (scanSections(text).length > 0) return text;
  const body = text.trim() || `${PLACEHOLDER.styleOpening}\n${PLACEHOLDER.refShot1}`;
  return [
    sectionChunk("subject_definitions", true, plan, text),
    sectionChunk("summary", true, plan, text),
    sectionChunk("retention_analysis", true, plan, text),
    `detailed_description:\n${body}`,
    sectionChunk("overall_soundscape", true, plan, text),
    sectionChunk("non_diegetic_music", true, plan, text),
  ].join("\n\n");
}

/** Ref2VA 的主體欄位改名：integrated_multimodal_description → detailed_description（已有 detailed_description 時不動）。 */
export function renameMainField(text: string): string {
  const sections = scanSections(text);
  if (sections.some((section) => section.name === "detailed_description")) return text;
  return applyEdits(
    text,
    sections.filter((section) => section.name === "integrated_multimodal_description").map((section) => ({ start: section.nameStart, end: section.nameEnd, insert: "detailed_description" })),
  );
}

/** 欄位名稱改成官方的小寫。 */
export function lowercaseFieldNames(text: string): string {
  return applyEdits(
    text,
    scanSections(text)
      .filter((section) => !section.exactName)
      .map((section) => ({ start: section.nameStart, end: section.nameEnd, insert: section.name })),
  );
}

/** I2VA 對齊句放在第一行、後面空一行（移除其他對齊句，包括需要尾幀的 FL2VA／L2VA 句）。 */
export function ensureI2vaLine(text: string): string {
  const lines = scanAlignment(text);
  const i2va = lines.filter((line) => line.kind === "i2va");
  const first = i2va[0];
  if (first && first.first && first.blankAfter && lines.length === 1) return text;
  const keep = first ? text.slice(first.start, first.end).trim() : I2VA_ALIGNMENT_LINE;
  const rest = removeWholeLines(text, lines).replace(/^\s+/u, "");
  return rest ? `${keep}\n\n${rest}` : keep;
}

/** 移除所有對齊句（t2va 沒有首幀；Ref2VA 不接受首幀）。 */
export function removeAlignmentLines(text: string): string {
  return removeWholeLines(text, scanAlignment(text));
}

const NEGATIVE_LINE_SOURCE = String.raw`^[ \t]*(?:\*\*|__)?[ \t]*(?:negative[ _-]?prompts?|negatives?|負面提示詞?|反向提示詞?|負向提示詞?|反面提示詞?)[ \t]*(?:\*\*|__)?[ \t]*[:：][^\n]*$`;

export function negativePromptLines(text: string): { start: number; end: number }[] {
  return [...text.matchAll(new RegExp(NEGATIVE_LINE_SOURCE, "gim"))].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

/** 刪掉「Negative prompt: …」這類行。 */
export function removeNegativePromptLines(text: string): string {
  return removeWholeLines(text, negativePromptLines(text));
}

const TITLE_LINE = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*([^\n]{0,30}?(?:prompt|提示詞|咒語)[^\n]{0,12}?)[ \t]*(?:\*\*|__)?[ \t]*[:：]?[ \t]*(?:\*\*|__)?[ \t]*$/i;

/** 像文件標題的行（「10 秒影片 Prompt」「# Prompt」）：短、含 prompt／提示詞、沒有句子標點。 */
export function isTitleLine(line: string): boolean {
  const match = TITLE_LINE.exec(line);
  if (!match) return false;
  const inner = match[1] ?? "";
  return !/[。，,.!?！？；;]/u.test(inner) && !/_/.test(inner);
}

/**
 * 第一個內容行：略過開頭空白與對齊句；第一行是欄位標題時，取欄位內容的第一行
 * （「integrated_multimodal_description: 10 秒影片 Prompt」→「10 秒影片 Prompt」）。
 */
export function firstContentLine(text: string): { start: number; end: number } | null {
  const sections = scanSections(text);
  const alignment = scanAlignment(text);
  let position = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    while (position < text.length && /\s/u.test(text.charAt(position))) position += 1;
    if (position >= text.length) return null;
    const line = alignment.find((item) => item.start === position);
    if (line) {
      position = line.end;
      continue;
    }
    const section = sections.find((item) => item.headStart === position);
    if (section) {
      if (section.bodyStart >= section.end) return null;
      position = section.bodyStart;
    }
    const newline = text.indexOf("\n", position);
    return { start: position, end: newline < 0 ? text.length : newline };
  }
  return null;
}

/** 刪掉開頭連續的標題行（和後面的空行）；標題在第一個欄位內容的開頭也會處理。 */
export function removeMetaTitle(text: string): string {
  let out = text;
  for (let guard = 0; guard < 5; guard += 1) {
    const line = firstContentLine(out);
    if (!line || !isTitleLine(out.slice(line.start, line.end))) break;
    const blankAfter = /^(?:[ \t\r]*\n)*[ \t\r]*/.exec(out.slice(line.end))?.[0].length ?? 0;
    out = out.slice(0, line.start) + out.slice(line.end + blankAfter);
  }
  return out;
}

/** @image1 → @Image1（只修正存在的參考名稱）。 */
export function fixMentionCase(text: string, aliases: ReadonlySet<string>): string {
  return applyEdits(
    text,
    scanMentions(text)
      .filter((mention) => !mention.exactCase && aliases.has(mention.alias))
      .map((mention) => ({ start: mention.start + 1, end: mention.end, insert: mention.alias })),
  );
}

/** <d> 內補上語言標籤（依內容推測：漢字→Chinese、假名→Japanese、韓文→Korean、其他→English）。 */
export function addDialogueLanguageTags(text: string): string {
  return applyEdits(
    text,
    scanDialogues(text)
      .filter((dialogue) => dialogue.closed && dialogue.tag === null)
      .map((dialogue) => {
        const inner = text.slice(dialogue.innerStart, dialogue.innerEnd);
        const lead = /^\s*/u.exec(inner)?.[0].length ?? 0;
        const at = dialogue.innerStart + lead;
        return { start: at, end: at, insert: `[${guessLanguageTag(inner)}] ` };
      }),
  );
}

export const ONSCREEN_SOURCE = String.raw`(招牌|看板|字幕|標語|橫幅|霓虹燈?|寫著|印著|顯示著?|標題字|\bsigns?\b|\bbanners?\b|\bcaptions?\b|\bsubtitles?\b|\btitle cards?\b|\breads\b|\breading\b)(\s*[:：]?\s*)([「『“‘])([^」』”’"\n]{1,60})([」』”’])`;

/** 畫面文字改用英文雙引號（只處理前面有招牌、字幕、寫著、reading 等提示的引號）。 */
export function quoteOnscreenText(text: string): string {
  return text.replace(new RegExp(ONSCREEN_SOURCE, "gi"), (_match, cue: string, gap: string, _open: string, inner: string) => `${cue}${gap}"${inner}"`);
}

interface CameraCommand {
  pattern: RegExp;
  en: string;
  zh: string;
}

const CAMERA_COMMANDS: readonly CameraCommand[] = [
  { pattern: /^pans?\s*left$/i, en: "The camera pans left.", zh: "鏡頭向左搖。" },
  { pattern: /^pans?\s*right$/i, en: "The camera pans right.", zh: "鏡頭向右搖。" },
  { pattern: /^pans?$/i, en: "The camera pans across the scene.", zh: "鏡頭橫搖。" },
  { pattern: /^tilts?\s*up$/i, en: "The camera tilts up.", zh: "鏡頭向上仰。" },
  { pattern: /^tilts?\s*down$/i, en: "The camera tilts down.", zh: "鏡頭向下俯。" },
  { pattern: /^zooms?\s*in$|^zoom$/i, en: "The lens zooms in.", zh: "鏡頭變焦拉近。" },
  { pattern: /^zooms?\s*out$/i, en: "The lens zooms out.", zh: "鏡頭變焦拉遠。" },
  { pattern: /^push(?:es)?\s*in$|^dolly\s*in$/i, en: "The camera pushes in.", zh: "鏡頭向前推近。" },
  { pattern: /^pull(?:s)?\s*(?:out|back)$|^dolly\s*out$/i, en: "The camera pulls out.", zh: "鏡頭向後拉遠。" },
  { pattern: /^trucks?\s*left$/i, en: "The camera trucks left.", zh: "鏡頭向左平移。" },
  { pattern: /^trucks?\s*right$/i, en: "The camera trucks right.", zh: "鏡頭向右平移。" },
  { pattern: /^pedestal\s*up$/i, en: "The camera pedestals up.", zh: "鏡頭垂直上升。" },
  { pattern: /^pedestal\s*down$/i, en: "The camera pedestals down.", zh: "鏡頭垂直下降。" },
  { pattern: /^tracking(?:\s*shot)?$|^track$/i, en: "The camera tracks the moving subject.", zh: "鏡頭跟隨主體移動。" },
  { pattern: /^static(?:\s*shot)?$|^fixed(?:\s*shot)?$/i, en: "The camera holds a static shot.", zh: "鏡頭保持固定。" },
  { pattern: /^arc(?:\s*shot)?$|^orbit$/i, en: "The camera arcs around the subject.", zh: "鏡頭沿弧線環繞主體。" },
  { pattern: /^shake(?:\s*slightly)?$|^handheld$/i, en: "The camera shakes slightly.", zh: "鏡頭輕微晃動。" },
  { pattern: /^shake\s*strongly$/i, en: "The camera shakes strongly.", zh: "鏡頭劇烈晃動。" },
  { pattern: /^roll\s*clockwise$/i, en: "The camera rolls clockwise.", zh: "鏡頭順時針旋轉。" },
  { pattern: /^roll\s*counter-?clockwise$/i, en: "The camera rolls counterclockwise.", zh: "鏡頭逆時針旋轉。" },
  { pattern: /^(?:推近|推鏡|推進)$/, en: "The camera pushes in.", zh: "鏡頭向前推近。" },
  { pattern: /^(?:拉遠|拉鏡|拉出)$/, en: "The camera pulls out.", zh: "鏡頭向後拉遠。" },
  { pattern: /^(?:左搖|向左搖)$/, en: "The camera pans left.", zh: "鏡頭向左搖。" },
  { pattern: /^(?:右搖|向右搖)$/, en: "The camera pans right.", zh: "鏡頭向右搖。" },
  { pattern: /^(?:上搖|向上搖)$/, en: "The camera tilts up.", zh: "鏡頭向上仰。" },
  { pattern: /^(?:下搖|向下搖)$/, en: "The camera tilts down.", zh: "鏡頭向下俯。" },
  { pattern: /^(?:跟拍|跟鏡|追蹤鏡頭)$/, en: "The camera tracks the moving subject.", zh: "鏡頭跟隨主體移動。" },
  { pattern: /^(?:固定鏡頭|靜止鏡頭)$/, en: "The camera holds a static shot.", zh: "鏡頭保持固定。" },
  { pattern: /^(?:環繞|環繞鏡頭|繞拍)$/, en: "The camera arcs around the subject.", zh: "鏡頭沿弧線環繞主體。" },
  { pattern: /^(?:手持|手持晃動)$/, en: "The camera shakes slightly.", zh: "鏡頭輕微晃動。" },
  { pattern: /^(?:變焦|變焦推近)$/, en: "The lens zooms in.", zh: "鏡頭變焦拉近。" },
];

export interface BracketCommand {
  start: number;
  end: number;
  inner: string;
  sentence: string;
}

/** 找出括號運鏡指令（只認得上表的運鏡；[Shot 1]、[English]、[TODO] 等不算）。 */
export function bracketCameraCommands(text: string): BracketCommand[] {
  const out: BracketCommand[] = [];
  for (const match of text.matchAll(/[[【]([^\]\n【】[]{1,24})[\]】]/g)) {
    const inner = (match[1] ?? "").trim();
    const command = CAMERA_COMMANDS.find((item) => item.pattern.test(inner));
    if (!command) continue;
    out.push({ start: match.index, end: match.index + match[0].length, inner, sentence: /[A-Za-z]/.test(inner) ? command.en : command.zh });
  }
  return out;
}

/** 括號運鏡指令 → 自然句子（官方 Base 指南 §4.3：寫成鏡頭內的自然動作；幅度與速度需要時再補）。 */
export function bracketCameraToSentences(text: string): string {
  return applyEdits(
    text,
    bracketCameraCommands(text).map((command) => {
      const next = text.charAt(command.end);
      const separator = command.end < text.length && !/\s/u.test(next) && /[A-Za-z]/.test(command.sentence) ? " " : "";
      return { start: command.start, end: command.end, insert: command.sentence + separator };
    }),
  );
}

/** 時間軸最後一個鏡頭（或時間段）之後、同一欄位內的段落；沒有 → null。 */
export function trailingText(scan: PromptScan): { first: Segment; last: Segment; trailing: Segment[] } | null {
  const segments = scan.segments;
  let lastIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]?.kind !== "paragraph") {
      lastIndex = index;
      break;
    }
  }
  const last = segments[lastIndex];
  if (!last) return null;
  const trailing: Segment[] = [];
  for (const segment of segments.slice(lastIndex + 1)) {
    if (segment.section !== last.section) break;
    trailing.push(segment);
  }
  const first = segments.find((segment) => segment.kind !== "paragraph" && segment.section === last.section);
  if (trailing.length === 0 || !first) return null;
  return { first, last, trailing };
}

/** 時間軸之後的整體說明移到第一個鏡頭之前（官方：整體風格寫在 [Shot 1] 開頭或之前）。 */
export function moveTrailingText(text: string): string {
  const found = trailingText(scanPrompt(text));
  const head = found?.trailing[0];
  const tail = found?.trailing[found.trailing.length - 1];
  if (!found || !head || !tail) return text;
  const moved = text.slice(head.start, tail.end);
  return applyEdits(text, [
    { start: found.first.start, end: found.first.start, insert: `${moved}\n\n` },
    { start: found.last.end, end: tail.end, insert: "" },
  ]);
}

/** summary 開頭補上 [reference generation]（官方 Full-Reference 指南 §3 最常見的任務類型；請依實際用途修改）。 */
export function prefixSummary(text: string): string {
  const summary = scanSections(text).find((section) => section.name === "summary");
  if (!summary || summary.body === "" || summary.body.startsWith("[")) return text;
  return `${text.slice(0, summary.bodyStart)}[reference generation] ${text.slice(summary.bodyStart)}`;
}
