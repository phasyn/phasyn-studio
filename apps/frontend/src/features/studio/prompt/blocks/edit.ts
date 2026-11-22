// Edits of a block document: content, order, duplication, deletion, inserted fragments and heading changes.
import { cutMarker, shotMarker } from "./headings";
import { parsePrompt } from "./parse";
import { blockSpans, defaultJoiner, serializePrompt } from "./serialize";
import { formatSeconds } from "./time";
import type { H3Section, PromptBlock, PromptDocument, TimeRange } from "./types";
import { t } from "@/i18n";

function newlines(gap: string): number {
  return gap.split("\n").length - 1;
}

/** Repairs separators after a structural edit: a heading must start a line; a paragraph without a heading needs a blank line before it, or it merges into the previous block. */
function repaired(lead: string, blocks: PromptBlock[], gaps: string[]): PromptDocument {
  const fixed = [...gaps];
  for (let index = 1; index < blocks.length; index += 1) {
    const need = blocks[index]?.kind === "paragraph" ? 2 : 1;
    if (newlines(fixed[index - 1] ?? "") < need) fixed[index - 1] = "\n\n";
  }
  return { lead, blocks, gaps: fixed };
}

export function replaceBlock(doc: PromptDocument, index: number, block: PromptBlock): PromptDocument {
  if (!doc.blocks[index]) return doc;
  const blocks = [...doc.blocks];
  blocks[index] = block;
  return { ...doc, blocks };
}

/** Changes a block's content; a heading that had no content gets the default separator, clearing the content removes it. */
export function setBlockBody(doc: PromptDocument, index: number, body: string): PromptDocument {
  const block = doc.blocks[index];
  if (!block) return doc;
  if (block.kind === "paragraph") return replaceBlock(doc, index, { ...block, body });
  const joiner = body.length === 0 ? "" : block.joiner.length > 0 ? block.joiner : defaultJoiner(block);
  return replaceBlock(doc, index, { ...block, joiner, body });
}

export function moveBlock(doc: PromptDocument, index: number, delta: -1 | 1): PromptDocument {
  const target = index + delta;
  const a = doc.blocks[index];
  const b = doc.blocks[target];
  if (!a || !b) return doc;
  const blocks = [...doc.blocks];
  blocks[index] = b;
  blocks[target] = a;
  return repaired(doc.lead, blocks, doc.gaps);
}

export function duplicateBlock(doc: PromptDocument, index: number): PromptDocument {
  const block = doc.blocks[index];
  if (!block) return doc;
  const gap = doc.gaps[index] ?? "";
  const separator = newlines(gap) >= (block.kind === "paragraph" ? 2 : 1) ? gap : "\n\n";
  const blocks = [...doc.blocks];
  blocks.splice(index + 1, 0, { ...block });
  const gaps = [...doc.gaps];
  gaps.splice(index, 1, separator, gap);
  return repaired(doc.lead, blocks, gaps);
}

export function deleteBlock(doc: PromptDocument, index: number): PromptDocument {
  if (!doc.blocks[index]) return doc;
  const blocks = [...doc.blocks];
  blocks.splice(index, 1);
  const gaps = [...doc.gaps];
  // Deleting the last block: the previous block takes over the trailing separator (usually empty), so no extra blank line is left
  if (index === doc.blocks.length - 1 && index > 0) gaps.splice(index - 1, 1);
  else gaps.splice(index, 1);
  return repaired(doc.lead, blocks, gaps);
}

/**
 * Inserts a piece of text before block `index` (index ≥ block count = at the end), with one blank line before and after.
 * Returns the new full text and where the inserted text starts (to select the new block).
 */
export function insertFragment(doc: PromptDocument, index: number, fragment: string): { text: string; offset: number } {
  const text = serializePrompt(doc);
  const span = blockSpans(doc)[index];
  const at = span ? span.start : text.length;
  const before = text.slice(0, at).replace(/\s+$/, "");
  const after = text.slice(at).replace(/^\s+/, "");
  const piece = fragment.replace(/^\s*\n/, "").replace(/\s+$/, "");
  const head = before.length > 0 ? `${before}\n\n` : "";
  return { text: head + piece + (after.length > 0 ? `\n\n${after}` : ""), offset: head.length };
}

export type HeadingEdit =
  | { type: "title"; title: string }
  | { type: "section"; section: H3Section }
  | { type: "range"; range: TimeRange }
  /** Cut-in time (seconds) of an official shot; null = no time ([Shot n], how the first shot is written). */
  | { type: "cue"; cue: number | null }
  | { type: "shot"; shot: number };

function validRange(range: TimeRange): string | null {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return t("時間必須是數字");
  if (range.start < 0) return t("起點不可小於 0");
  if (range.end <= range.start) return t("終點必須大於起點");
  if (range.end >= 6000) return t("時間必須小於 100 分鐘");
  return null;
}

/** Changes a block's heading (keeping its heading style); invalid → { error }. */
export function setBlockHeading(doc: PromptDocument, index: number, edit: HeadingEdit): PromptDocument | { error: string } {
  const block = doc.blocks[index];
  const style = block?.style;
  if (!block || !style) return { error: t("這個區塊沒有標題") };
  let marker: string | null = null;
  if (edit.type === "title" && (style.type === "bold" || style.type === "markdown")) {
    const title = edit.title.replace(/[ \t]*[：:]+[ \t]*$/, "").trim();
    if (title.length === 0) return { error: t("標題不可為空") };
    if (/[\r\n]/.test(title)) return { error: t("標題不可換行") };
    if (style.type === "bold" && /[*_]{2}/.test(title)) return { error: t("標題不可包含 ** 或 __") };
    marker = style.type === "bold" ? `${style.open}${title}${style.close}` : `${style.hashes} ${title}`;
  } else if (edit.type === "section" && style.type === "section") {
    marker = `${edit.section}:`;
  } else if (edit.type === "range" && (style.type === "time" || (style.type === "shot" && style.form === "range"))) {
    const problem = validRange(edit.range);
    if (problem != null && problem !== "") return { error: problem };
    marker =
      style.type === "shot"
        ? shotMarker(block.shot ?? 1, edit.range)
        : `${style.prefix}${formatSeconds(edit.range.start, style.decimals)}${style.between}${formatSeconds(edit.range.end, style.decimals)}${style.suffix}`;
  } else if (edit.type === "cue" && style.type === "shot" && style.form === "cut") {
    if (edit.cue !== null) {
      if (!Number.isFinite(edit.cue)) return { error: t("時間必須是數字") };
      if (edit.cue < 0) return { error: t("切入時間不可小於 0") };
      if (edit.cue >= 6000) return { error: t("時間必須小於 100 分鐘") };
    }
    marker = cutMarker(block.shot ?? 1, edit.cue);
  } else if (edit.type === "shot" && style.type === "shot") {
    if (!Number.isInteger(edit.shot) || edit.shot < 1 || edit.shot > 999) return { error: t("鏡頭編號必須是 1–999 的整數") };
    marker = style.form === "range" ? shotMarker(edit.shot, block.range) : cutMarker(edit.shot, block.cue);
  }
  if (marker === null) return { error: t("這種標題不能這樣修改") };
  const reparsed = parsePrompt(marker + block.joiner + block.body).blocks[0];
  if (reparsed?.kind !== block.kind) return { error: t("修改後不再是同一種標題；請改用全文編輯") };
  return replaceBlock(doc, index, { ...reparsed, joiner: block.joiner, body: block.body });
}
