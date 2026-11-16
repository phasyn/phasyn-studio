// Prompt 檢查（純函式，不擋渲染）：時間軸重疊／空隙／超過鏡頭長度、官方分鏡的切入時間（遞增、小於片長）、
// 空的區塊、重複的 H3 區段、沒用到的參考（@ 名稱或直接寫的 H3 標籤都算用到）、大小寫打錯的 @ 名稱、
// 直接寫的 H3 標籤編號超過素材數。擋渲染的問題只有 compilePrompt 的 problems。
import type { StudioReference } from "@/api/generated/contracts";
import { formatClock, formatSeconds, type PromptDocument } from "./blocks";
import { t } from "@/i18n";

export interface PromptNote {
  tone: "warning" | "info";
  text: string;
}

const EPSILON = 0.001;

function span(start: number, end: number): string {
  return t("{start}–{end} 秒", { start: formatSeconds(start), end: formatSeconds(end) });
}

export function analyzePrompt(
  doc: PromptDocument,
  text: string,
  options: { references: readonly StudioReference[]; usedAliases: readonly string[]; durationSeconds?: number | null },
): PromptNote[] {
  const notes: PromptNote[] = [];
  const duration = options.durationSeconds ?? null;
  let previous: { start: number; end: number } | null = null;
  for (const block of doc.blocks) {
    const range = block.range;
    if (!range) continue;
    if (range.end <= range.start) {
      notes.push({ tone: "warning", text: t("時間範圍 {span}無效：終點必須大於起點", { span: span(range.start, range.end) }) });
      continue;
    }
    if (previous) {
      if (range.start < previous.end - EPSILON) notes.push({ tone: "warning", text: t("時間軸重疊：{span}與 {span2}", { span: span(previous.start, previous.end), span2: span(range.start, range.end) }) });
      else if (range.start > previous.end + 0.05) notes.push({ tone: "info", text: t("時間軸 {span}沒有描述", { span: span(previous.end, range.start) }) });
    }
    if (duration !== null && range.end > duration + 0.05) {
      notes.push({ tone: "warning", text: t("時間軸 {span}超過鏡頭長度 {duration} 秒；超過的部分不會被生成", { span: span(range.start, range.end), duration: formatSeconds(duration, 2) }) });
    }
    previous = range;
  }

  // 官方分鏡 [Shot n] At mm:ss.sss,：切入時間嚴格遞增、小於片長（第一鏡沒有時間＝從 0 開始）
  let lastCue: number | null = null;
  for (const block of doc.blocks) {
    if (block.style?.type !== "shot" || block.style.form !== "cut") continue;
    const cue = block.cue ?? (lastCue === null ? 0 : null);
    if (cue === null) continue;
    if (lastCue !== null && block.cue !== null && cue <= lastCue + EPSILON) {
      notes.push({ tone: "warning", text: t("{title} 的切入時間 {cue} 沒有晚於前一個切鏡（官方：切鏡時間嚴格遞增）", { title: block.title, cue: formatClock(cue) }) });
    }
    if (duration !== null && block.cue !== null && cue >= duration - EPSILON) {
      notes.push({ tone: "warning", text: t("{title} 的切入時間 {cue} 不在鏡頭長度 {duration} 秒內；這個分鏡不會被生成", { title: block.title, cue: formatClock(cue), duration: formatSeconds(duration, 2) }) });
    }
    lastCue = Math.max(lastCue ?? 0, cue);
  }

  const sections = new Map<string, number>();
  for (const block of doc.blocks) {
    if (block.section) sections.set(block.section, (sections.get(block.section) ?? 0) + 1);
    if (block.kind !== "paragraph" && block.body.trim().length === 0) notes.push({ tone: "info", text: t("「{title}」區塊沒有內容", { title: block.title }) });
  }
  for (const [section, count] of sections) if (count > 1) notes.push({ tone: "warning", text: t("H3 區段 {section} 出現 {count} 次", { section, count }) });

  for (const match of text.matchAll(/@(image|video|audio)([1-9][0-9]?)\b/gi)) {
    const [whole, prefix = "", ordinal = ""] = match;
    const proper = `${prefix.charAt(0).toUpperCase()}${prefix.slice(1).toLowerCase()}`;
    if (prefix !== proper) notes.push({ tone: "warning", text: t("{whole} 不會被轉換成參考：名稱大小寫要一致（@{proper}{ordinal}）", { whole, proper, ordinal }) });
  }

  if (options.references.length > 0) {
    const used = new Set(options.usedAliases);
    for (const ref of options.references) {
      if (!used.has(ref.alias)) notes.push({ tone: "info", text: t("@{alias} 沒有在 prompt 中使用（仍會送給 H3）", { alias: ref.alias }) });
    }
    const count = (kind: StudioReference["kind"]) => options.references.filter((ref) => ref.kind === kind).length;
    // 聲音標籤的上限包含可能有原聲的參考影片
    const limits: Record<string, number> = { Picture: count("image"), Video: count("video"), Audio: count("audio") + count("video") };
    for (const match of text.matchAll(/<(Picture|Video|Audio) (\d+)>/g)) {
      const [whole, tag = "", ordinal = "0"] = match;
      const limit = limits[tag] ?? 0;
      if (Number(ordinal) > limit) notes.push({ tone: "warning", text: t("prompt 直接寫了 {whole}，但這個鏡頭送出的這類參考只有 {limit} 個", { whole, limit }) });
    }
  }
  return [...new Map(notes.map((note) => [note.text, note])).values()];
}
