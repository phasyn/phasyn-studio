// The official H3 sections a prompt lacks, and adding them.
import { insertFragment } from "./edit";
import { parsePrompt } from "./parse";
import { serializePrompt } from "./serialize";
import { H3_SECTIONS, type H3Section, type PromptDocument } from "./types";

/** Official H3 sections the document lacks (in the official order). */
export function missingSections(doc: PromptDocument): H3Section[] {
  const present = new Set(doc.blocks.map((block) => block.section));
  return H3_SECTIONS.filter((section) => !present.has(section));
}

/** Adds the missing H3 sections with empty content: each goes before the next official section present (at the end when none). */
export function addMissingSections(doc: PromptDocument): { text: string; added: H3Section[]; offset: number | null } {
  let current = doc;
  let text = serializePrompt(doc);
  // The first (earliest) added section; sections inserted after it do not move it
  let offset: number | null = null;
  const added = missingSections(doc);
  for (const section of added) {
    const order = H3_SECTIONS.indexOf(section);
    const later = current.blocks.findIndex((block) => block.section !== null && H3_SECTIONS.indexOf(block.section) > order);
    const inserted = insertFragment(current, later >= 0 ? later : current.blocks.length, `${section}:`);
    offset = offset === null ? inserted.offset : Math.min(offset, inserted.offset);
    text = inserted.text;
    current = parsePrompt(text);
  }
  return { text, added, offset };
}
