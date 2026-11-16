// Writing a block document back to text, and locating its blocks in that text.
import type { PromptBlock, PromptDocument } from "./types";

export function blockText(block: PromptBlock): string {
  return block.marker + block.joiner + block.body;
}

export function serializePrompt(doc: PromptDocument): string {
  return doc.lead + doc.blocks.map((block, index) => blockText(block) + (doc.gaps[index] ?? "")).join("");
}

export interface BlockSpan {
  /** Start of the block (first character of the heading). */
  start: number;
  /** Start of the content (after the heading and its separator). */
  bodyStart: number;
  /** End of the content (without the blank lines after it). */
  end: number;
}

/** Position of every block in the text. */
export function blockSpans(doc: PromptDocument): BlockSpan[] {
  let position = doc.lead.length;
  return doc.blocks.map((block, index) => {
    const start = position;
    const bodyStart = start + block.marker.length + block.joiner.length;
    const end = bodyStart + block.body.length;
    position = end + (doc.gaps[index] ?? "").length;
    return { start, bodyStart, end };
  });
}

/** The block that contains offset (an offset on a blank line belongs to the previous block); no blocks → -1. */
export function blockIndexAt(doc: PromptDocument, offset: number): number {
  const spans = blockSpans(doc);
  let found = spans.length > 0 ? 0 : -1;
  spans.forEach((span, index) => {
    if (span.start <= offset) found = index;
  });
  return found;
}

/** Default separator when a heading gets content: a line break at section level, one space on the same line at paragraph level. */
export function defaultJoiner(block: Pick<PromptBlock, "kind" | "level">): string {
  if (block.kind === "paragraph") return "";
  return block.level === "section" ? "\n" : " ";
}

/**
 * Context for editing one block's content: the new full text = prefix + content + suffix. When the content was empty,
 * the prefix carries the default separator so typed text does not stick to the heading (for example a line break after summary:).
 */
export function bodyContext(doc: PromptDocument, index: number): { prefix: string; body: string; suffix: string } | null {
  const block = doc.blocks[index];
  const span = blockSpans(doc)[index];
  if (!block || !span) return null;
  const text = serializePrompt(doc);
  const prefix = block.body.length === 0 && block.joiner.length === 0 ? text.slice(0, span.bodyStart) + defaultJoiner(block) : text.slice(0, span.bodyStart);
  return { prefix, body: block.body, suffix: text.slice(span.end) };
}
