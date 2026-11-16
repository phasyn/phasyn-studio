// Proposing the next timeline block of a prompt (time heading, [Shot n, a-b] span or official shot cut).
import { cutMarker, shotMarker } from "./headings";
import { formatClock, formatSeconds, rangeLabel } from "./time";
import type { PromptDocument, TimeRange } from "./types";
import { t } from "@/i18n";

export interface TimelineProposal {
  /** Heading to insert (the content stays empty for the user to fill in). */
  fragment: string;
  /** For display: a span (2.0–4.0 秒) or an official shot cut (Shot 2・00:02.000 切入). */
  label: string;
  /** Range of the span forms (time heading, [Shot n, a-b]); an official shot cut has no end, so null. */
  range: TimeRange | null;
  /** Cut-in time of an official shot cut; null for the first shot ([Shot 1]) and the span forms. */
  cue: number | null;
  /** The start / cut-in time already reaches the clip length (the new block will not be generated). */
  exceeds: boolean;
  /** Insert position (before this block; equal to the block count = at the end). */
  index: number;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The next timeline block: after the last timeline block (without one, after detailed_description).
 * - The document already uses time headings or [Shot n, a-b] spans: keep that style and length, the end never past the clip length.
 * - Otherwise (including no timeline at all): the official shot form (Base / Full-Reference guide) — the first shot [Shot 1]
 *   has no time, later ones [Shot n] At mm:ss.sss,; the cut-in time repeats the previous length (2 seconds by default) and
 *   must be below the clip length.
 */
export function proposeTimelineBlock(doc: PromptDocument, durationSeconds?: number | null): TimelineProposal {
  let lastIndex = -1;
  doc.blocks.forEach((block, index) => {
    if (block.range || block.kind === "shot") lastIndex = index;
  });
  const last = doc.blocks[lastIndex];
  const duration = durationSeconds !== undefined && durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null;
  const detailed = doc.blocks.findIndex((block) => block.section === "detailed_description");
  const index = lastIndex >= 0 ? lastIndex + 1 : detailed >= 0 ? detailed + 1 : doc.blocks.length;
  const style = last?.style;
  if (last && (style?.type === "time" || (style?.type === "shot" && style.form === "range"))) {
    const start = last.range ? last.range.end : 0;
    const span = last.range && last.range.end > last.range.start ? last.range.end - last.range.start : 2;
    const exceeds = duration !== null && start >= duration - 1e-3;
    const end = round3(duration !== null && !exceeds ? Math.min(start + span, duration) : start + span);
    const range = { start, end };
    const fragment =
      style.type === "time"
        ? `${style.prefix}${formatSeconds(start, style.decimals)}${style.between}${formatSeconds(end, style.decimals)}${style.suffix}`
        : shotMarker(last.shot ?? 1, range);
    return { fragment, label: rangeLabel(range), range, cue: null, exceeds, index };
  }
  const cuts = doc.blocks.filter((block) => block.style?.type === "shot" && block.style.form === "cut");
  if (cuts.length === 0) return { fragment: cutMarker(1, null), label: t("Shot 1・開場（不加時間）"), range: null, cue: null, exceeds: false, index };
  // Known cut-in points: the first shot without a time starts at 0
  const starts = cuts.flatMap((block, position) => (block.cue !== null ? [block.cue] : position === 0 ? [0] : []));
  const lastStart = starts.at(-1) ?? 0;
  const previous = starts.at(-2);
  const span = previous !== undefined && lastStart > previous ? lastStart - previous : 2;
  let cue = round3(lastStart + span);
  // The default length would pass the clip length but there is room after the last cut-in point: cut in the middle
  // (official: a cut time must be below the clip length)
  if (duration !== null && cue >= duration - 1e-3 && lastStart + 0.5 < duration) cue = round3((lastStart + duration) / 2);
  const exceeds = duration !== null && cue >= duration - 1e-3;
  const shot = Math.max(...cuts.map((block) => block.shot ?? 0)) + 1;
  return { fragment: cutMarker(shot, cue), label: t("Shot {shot}・{cue} 切入", { shot, cue: formatClock(cue) }), range: null, cue, exceeds, index };
}
