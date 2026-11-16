// Prompt templates in the editors (pure): which ones an empty editor offers first, how a template joins a prompt that
// already has text (one that starts with a heading is added as blocks, plain text goes to the caret) and where its first
// [TODO: …] placeholder is, so the caret can land on it. The inline editor and the professional editor share these.
import type { PromptTemplate } from "./advisor";
import type { PromptTask } from "./advisorSlot";
import { parsePrompt } from "./blocks";
import { describeBlock } from "./outline";

/** The name of a template's first block when the template starts with a heading (it is added as blocks); null = plain text. */
export function templateHeading(text: string): string | null {
  const first = parsePrompt(text).blocks[0];
  if (!first || first.kind === "paragraph") return null;
  const info = describeBlock(first);
  return info.title || info.kind;
}

/** The first [TODO: …] placeholder of a text (the advisor's "template placeholder left" rule finds the same ones). */
export function firstPlaceholder(text: string): { start: number; end: number } | null {
  const match = /\[TODO\b[^\]\n]*\]/.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

const START_COUNT = 3;
/** Shot skeletons in the order an empty editor prefers them (three cuts is the common case). */
const SKELETON_ORDER = ["timeline-3", "action-depth", "timeline-2"];

function skeletonRank(template: PromptTemplate): number {
  const rank = SKELETON_ORDER.indexOf(template.id);
  return rank < 0 ? SKELETON_ORDER.length : rank;
}

/**
 * What an empty editor offers, most relevant first (at most three): the official format of the shot's task, a shot
 * skeleton (any task), then the guide example of the task; the rest of the places go to the next ones of the same kinds.
 * One-line fragments (the I2VA alignment line) and templates that cannot be inserted stay in the full list only; with
 * the task unknown every official format qualifies and no example does.
 */
export function startTemplates(templates: readonly PromptTemplate[], mode: PromptTask | null | undefined): PromptTemplate[] {
  const usable = templates.filter((template) => template.unavailable === null && template.text.includes("\n"));
  const formats = usable.filter((template) => !template.example && template.modes !== null && (!mode || template.modes.includes(mode)));
  const skeletons = usable.filter((template) => !template.example && template.modes === null).sort((a, b) => skeletonRank(a) - skeletonRank(b));
  const examples = mode ? usable.filter((template) => template.example && template.modes?.includes(mode) === true) : [];
  const groups = [formats, skeletons, examples];
  const picked: PromptTemplate[] = [];
  for (const group of groups) {
    const first = group[0];
    if (first) picked.push(first);
  }
  for (const group of groups) for (const template of group.slice(1)) picked.push(template);
  return picked.slice(0, START_COUNT);
}
