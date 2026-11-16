// 文字統計小工具（純函式）：中英文比例、英文字數、句數、子句切分、台詞語言推測。
import type { PromptScan } from "./parse";

const HAN = /\p{Script=Han}/gu;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN_LETTER = /[A-Za-z]/g;
const ENGLISH_WORD = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

export function countCjk(text: string): number {
  return text.match(CJK)?.length ?? 0;
}

export function countHan(text: string): number {
  return text.match(HAN)?.length ?? 0;
}

export function englishWords(text: string): number {
  return text.match(ENGLISH_WORD)?.length ?? 0;
}

/** 拉丁字母至少占字母的 60%（英文為主）。 */
export function mostlyEnglish(text: string): boolean {
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  const cjk = countCjk(text);
  // 一個漢字大約相當於一個英文單字的資訊量：以 4 個字母折算一個漢字比較
  return latin > 0 && latin >= 0.6 * (latin + cjk * 4);
}

/** 英文句數（以 . ! ? 結尾；小數點不算）。 */
export function sentenceCount(text: string): number {
  return text
    .split(/[.!?。！？]+(?=\s|$)/u)
    .map((part) => part.trim())
    .filter((part) => /[A-Za-z\p{Script=Han}]/u.test(part)).length;
}

export interface Clause {
  start: number;
  end: number;
  text: string;
}

/** 子句：以中文標點（含全形逗號）、分號、換行與英文句點切開；英文逗號與頓號不切（a short, fast lateral move 是同一件事）。 */
export function clauses(text: string, offset = 0): Clause[] {
  const out: Clause[] = [];
  let start = 0;
  const pattern = /[。！？；;!?\n，]|\.(?=\s|$)/g;
  const push = (from: number, to: number) => {
    const piece = text.slice(from, to);
    if (piece.trim()) out.push({ start: offset + from, end: offset + to, text: piece });
  };
  for (const match of text.matchAll(pattern)) {
    push(start, match.index);
    start = match.index + match[0].length;
  }
  push(start, text.length);
  return out;
}

const OPENERS = new Set(["「", "『", "（", "(", "“", "【"]);
const CLOSERS = new Set(["」", "』", "）", ")", "”", "】"]);
const SENTENCE_END = new Set(["。", "！", "？"]);

/**
 * 說明的第一句（工具列浮層只顯示這一句）：到第一個不在引號或括號裡的 。！？ 為止；英文以 . ! ? 後接空白與大寫字母
 * 為句尾。找不到句尾時是整段。說明的第一句不放含句號的例句（例如 <d> 台詞），例句寫在後面。
 */
export function firstSentence(text: string): string {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (OPENERS.has(char)) depth += 1;
    else if (CLOSERS.has(char)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && SENTENCE_END.has(char)) return text.slice(0, index + 1);
    else if (depth === 0 && /[.!?]/.test(char) && /^\s+[A-Z]/.test(text.slice(index + 1, index + 3))) return text.slice(0, index + 1);
  }
  return text;
}

/** 依台詞內容推測語言標籤（只用在預覽中的建議修正）。 */
export function guessLanguageTag(content: string): string {
  if (HANGUL.test(content)) return "Korean";
  if (KANA.test(content)) return "Japanese";
  if (countHan(content) > 0) return "Chinese";
  return "English";
}

/** 用空白蓋掉 [start, end) 區間（UTF-16 位置與長度不變）。 */
export function blank(text: string, ranges: readonly { start: number; end: number }[]): string {
  if (ranges.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(cursor, range.start);
    if (start > cursor) out += text.slice(cursor, start);
    const end = Math.max(start, range.end);
    out += " ".repeat(end - start);
    cursor = end;
  }
  return out + text.slice(cursor);
}

/**
 * 「散文」：去掉不影響語言判斷的部分（<d> 台詞、引號內的畫面文字、H3 標籤、@ 名稱、分鏡標記、欄位名稱、[TODO]），
 * 位置不變（被去掉的地方換成空白）。
 */
export function proseOnly(scan: PromptScan): string {
  const text = scan.text;
  const ranges: { start: number; end: number }[] = [];
  for (const dialogue of scan.dialogues) if (dialogue.closed) ranges.push({ start: dialogue.innerStart, end: dialogue.innerEnd });
  for (const label of scan.labels) ranges.push(label);
  for (const mention of scan.mentions) ranges.push(mention);
  for (const shot of scan.shots) ranges.push(shot);
  for (const heading of scan.headings) ranges.push(heading);
  for (const section of scan.sections) ranges.push({ start: section.lineStart, end: section.headerEnd });
  for (const line of scan.alignment) ranges.push(line);
  for (const match of text.matchAll(/"[^"\n]{1,80}"|\[TODO\b[^\]\n]*\]/g)) ranges.push({ start: match.index, end: match.index + match[0].length });
  return blank(text, ranges);
}
