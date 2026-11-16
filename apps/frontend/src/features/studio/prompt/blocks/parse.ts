// Parsing prompt text into blocks (see headings.ts for the block starts). "Section level" headings (H3 sections,
// Markdown headings, whole-line bold headings) own all text up to the next heading (possibly several paragraphs);
// "paragraph level" headings (timeline markers, time headings, bold headings with a colon) own only their own paragraph
// (up to a blank line).
import { lineHeading } from "./headings";
import type { BlockLevel, Heading, PromptBlock, PromptDocument } from "./types";

const GAP_RE = /(?:\n[ \t\r\u3000]*)*$/;
const NEWLINE_JOINER_RE = /^[ \t\u3000\r]*\n(?:[ \t\u3000\r]*\n)*/;
const SPACE_JOINER_RE = /^[ \t\u3000]*/;

function splitContent(content: string, heading: Heading | null): PromptBlock {
  if (!heading) {
    return { kind: "paragraph", level: "paragraph", marker: "", joiner: "", body: content, title: "", range: null, cue: null, shot: null, section: null, style: null };
  }
  const rest = content.slice(heading.marker.length);
  const joiner = NEWLINE_JOINER_RE.exec(rest)?.[0] ?? SPACE_JOINER_RE.exec(rest)?.[0] ?? "";
  return { ...heading, joiner, body: rest.slice(joiner.length) };
}

export function parsePrompt(text: string): PromptDocument {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let position = 0;
  for (const line of lines) {
    offsets.push(position);
    position += line.length + 1;
  }
  const starts: { line: number; heading: Heading | null }[] = [];
  let owner: BlockLevel = "paragraph";
  let previousBlank = true;
  lines.forEach((line, index) => {
    const blank = line.trim() === "";
    const heading = blank ? null : lineHeading(line);
    if (heading) {
      starts.push({ line: index, heading });
      owner = heading.level;
    } else if (!blank && owner === "paragraph" && previousBlank) {
      starts.push({ line: index, heading: null });
    }
    previousBlank = blank;
  });
  const first = starts[0];
  if (!first) return { lead: text, blocks: [], gaps: [] };
  const blocks: PromptBlock[] = [];
  const gaps: string[] = [];
  starts.forEach((start, index) => {
    const next = starts[index + 1];
    const raw = text.slice(offsets[start.line] ?? 0, next ? (offsets[next.line] ?? text.length) : text.length);
    const gap = GAP_RE.exec(raw)?.[0] ?? "";
    blocks.push(splitContent(raw.slice(0, raw.length - gap.length), start.heading));
    gaps.push(gap);
  });
  return { lead: text.slice(0, offsets[first.line] ?? 0), blocks, gaps };
}
