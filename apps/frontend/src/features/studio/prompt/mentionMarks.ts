// The @ names a prompt contains, as the editor's highlight layer draws them (pure): every match of the mention syntax,
// resolved when its name is exactly one of the shot's reference aliases (what compilePrompt converts to an H3 tag) and
// unresolved otherwise (an alias the shot does not have, or the wrong letter case: both are sent as plain text).

export interface MentionMark {
  /** [start, end) in the prompt text (UTF-16 offsets, the same as the textarea's selection). */
  start: number;
  end: number;
  /** The name as written, without the @. */
  alias: string;
  resolved: boolean;
}

/** compilePrompt's MENTION_SOURCE, matched without regard to case so that a wrong-case name is marked as well. */
const MARK_SOURCE = "@((?:image|video|audio)[1-9][0-9]?)\\b";

export function mentionMarks(text: string, aliases: ReadonlySet<string>): MentionMark[] {
  const marks: MentionMark[] = [];
  for (const match of text.matchAll(new RegExp(MARK_SOURCE, "gi"))) {
    const alias = match[1] ?? "";
    marks.push({ start: match.index, end: match.index + match[0].length, alias, resolved: aliases.has(alias) });
  }
  return marks;
}

/** A run of the prompt text: plain, or the mark at that index. */
export interface MarkSegment {
  text: string;
  mark: number | null;
}

/** The text cut into plain runs and marks, in order (concatenated, the segments are the text again). */
export function markSegments(text: string, marks: readonly MentionMark[]): MarkSegment[] {
  const segments: MarkSegment[] = [];
  let cursor = 0;
  marks.forEach((mark, index) => {
    if (mark.start > cursor) segments.push({ text: text.slice(cursor, mark.start), mark: null });
    segments.push({ text: text.slice(mark.start, mark.end), mark: index });
    cursor = mark.end;
  });
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mark: null });
  return segments;
}

/** The resolved mark the caret stands on (just after its @ through its last character); none → -1. */
export function markAtCaret(marks: readonly MentionMark[], caret: number): number {
  return marks.findIndex((mark) => mark.resolved && caret > mark.start && caret <= mark.end);
}
