// Prompt 格式化（純函式；套用前一定先預覽差異，不會默默改字）：
//  - markdown：移除 **粗體**、__粗體__、*斜體*、`程式碼`、``` 區塊線與行首 # 標題符號（H3 會把它們當成字）
//  - whitespace：統一換行、去掉行尾空白、連續空行只留一行、去掉頭尾空行
//  - cjk：行內全形空白改半形、連續空白合併、全形標點旁的空白移除（行首縮排不動，中英文之間的空白不增不減）
//  - timeline：把區塊檢視認得的時間標題（**0.0–1.5 秒：**、0.0–1.5 秒：、【0–1.5 秒】）換成 H3 標記：
//    sequential＝官方分鏡（[Shot 1]、[Shot 2] At 00:01.500,：每段是一次切鏡）；
//    single＝同一個連續鏡頭內的時段（[Shot 1, 00:00.000-00:01.500]，官方加速 LoRA 範例的寫法）
// 其他文字（中文內容、@Image1、<Picture 1>、[Shot …]、subject_definitions 這類名稱）保持原樣。
import { cutMarker, formatClock, lineHeading } from "./blocks";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export type TimelineMode = "keep" | "single" | "sequential";

export interface FormatOptions {
  markdown: boolean;
  whitespace: boolean;
  cjk: boolean;
  /** keep＝不轉換；single＝全部 Shot 1（一個連續鏡頭內的時段）；sequential＝每段一個鏡頭（官方分鏡 [Shot 1]、[Shot 2] At …）。 */
  timeline: TimelineMode;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = { markdown: true, whitespace: true, cjk: true, timeline: "keep" };

export interface FormatCounts {
  markdown: number;
  whitespace: number;
  cjk: number;
  timeline: number;
}

export interface FormatResult {
  text: string;
  counts: FormatCounts;
}

interface Counter {
  n: number;
}

function countingReplace(text: string, pattern: RegExp, replacement: string, counter: Counter): string {
  return text.replace(pattern, (...args: unknown[]) => {
    counter.n += 1;
    const groups = args.slice(1, -2) as (string | undefined)[];
    return replacement.replace(/\$(\d)/g, (_, digit: string) => groups[Number(digit) - 1] ?? "");
  });
}

function convertTimeline(text: string, mode: TimelineMode, counter: Counter): string {
  let shot = 0;
  return text
    .split("\n")
    .map((line) => {
      const heading = line.trim() === "" ? null : lineHeading(line);
      if (heading?.kind !== "time" || !heading.range) return line;
      shot = mode === "sequential" ? shot + 1 : 1;
      counter.n += 1;
      const rest = line.slice(heading.marker.length).replace(/^[ \t\u3000]+/, "");
      // 官方分鏡：第一鏡不加時間，之後寫切入時間（＝這一段的起點）
      const marker =
        mode === "sequential"
          ? cutMarker(shot, shot === 1 ? null : heading.range.start)
          : `[Shot ${shot}, ${formatClock(heading.range.start)}-${formatClock(heading.range.end)}]`;
      return rest.length > 0 ? `${marker} ${rest}` : marker;
    })
    .join("\n");
}

function stripMarkdown(text: string, counter: Counter): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (/^[ \t]*```/.test(line)) {
      counter.n += 1;
      continue;
    }
    let next = countingReplace(line, /^#{1,6}[ \t]+/, "", counter);
    if (next !== line) next = next.replace(/[ \t]+#+[ \t]*$/, "");
    next = countingReplace(next, /\*\*(?=\S)([^*\n]*?\S)\*\*/g, "$1", counter);
    next = countingReplace(next, /(?<![\w])__(?=\S)([^_\n]*?\S)__(?![\w])/g, "$1", counter);
    next = countingReplace(next, /(?<![*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1", counter);
    next = countingReplace(next, /(`+)([^`\n]+?)\1/g, "$2", counter);
    lines.push(next);
  }
  return lines.join("\n");
}

// 全形標點本身已含字距，旁邊的空白可以安全移除
const FULLWIDTH_PUNCTUATION = "，。、；：！？（）「」『』【】〈〉《》";
const SPACE_BEFORE_PUNCTUATION = new RegExp(`[ \\t]+([${FULLWIDTH_PUNCTUATION}])`, "g");
const SPACE_AFTER_PUNCTUATION = new RegExp(`([${FULLWIDTH_PUNCTUATION}])[ \\t]+(?=\\S)`, "g");

function tidyCjk(text: string, counter: Counter): string {
  return text
    .split("\n")
    .map((line) => {
      const indent = /^[ \t\u3000]*/.exec(line)?.[0] ?? "";
      let content = line.slice(indent.length);
      content = countingReplace(content, /\u3000/g, " ", counter);
      content = countingReplace(content, / {2,}(?=\S)/g, " ", counter);
      content = countingReplace(content, SPACE_BEFORE_PUNCTUATION, "$1", counter);
      content = countingReplace(content, SPACE_AFTER_PUNCTUATION, "$1", counter);
      return indent + content;
    })
    .join("\n");
}

function tidyWhitespace(text: string, counter: Counter): string {
  const unified = text.replace(/\r\n?/g, "\n");
  if (unified !== text) counter.n += 1;
  const out: string[] = [];
  for (const line of unified.split("\n")) {
    const trimmed = line.replace(/[ \t\u3000]+$/, "");
    // 開頭的空行與連續空行的第二行起不保留
    const skip = trimmed === "" && (out.length === 0 || out[out.length - 1] === "");
    if (skip || trimmed !== line) counter.n += 1;
    if (!skip) out.push(trimmed);
  }
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
    counter.n += 1;
  }
  return out.join("\n");
}

export function formatPrompt(text: string, options: FormatOptions): FormatResult {
  const counters = { markdown: { n: 0 }, whitespace: { n: 0 }, cjk: { n: 0 }, timeline: { n: 0 } };
  let next = text;
  if (options.timeline !== "keep") next = convertTimeline(next, options.timeline, counters.timeline);
  if (options.markdown) next = stripMarkdown(next, counters.markdown);
  if (options.cjk) next = tidyCjk(next, counters.cjk);
  if (options.whitespace) next = tidyWhitespace(next, counters.whitespace);
  return {
    text: next,
    counts: { markdown: counters.markdown.n, whitespace: counters.whitespace.n, cjk: counters.cjk.n, timeline: counters.timeline.n },
  };
}

/** 套用後的提示文字，例如「已格式化：Markdown 標記 8 處、空白 1 處」。 */
export function formatSummary(counts: FormatCounts): string {
  const parts = [
    counts.timeline > 0 ? t("時間標題 {timeline} 個", { timeline: counts.timeline }) : null,
    counts.markdown > 0 ? t("Markdown 標記 {markdown} 處", { markdown: counts.markdown }) : null,
    counts.cjk > 0 ? t("全形空白與標點旁空白 {cjk} 處", { cjk: counts.cjk }) : null,
    counts.whitespace > 0 ? t("空白與空行 {whitespace} 處", { whitespace: counts.whitespace }) : null,
  ].filter(Boolean);
  return parts.length > 0 ? formatList(parts) : t("沒有需要調整的地方");
}
