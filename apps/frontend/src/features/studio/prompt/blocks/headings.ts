// Heading syntax of a prompt: recognizing the line that starts a block, and writing [Shot n] markers.
//
// Block starts (always at the start of a line):
//  - H3 section: the whole line is subject_definitions: / summary: / retention_analysis: / detailed_description: /
//    overall_soundscape: / non_diegetic_music: (the section names of the official Ref2VA example)
//  - H3 shot (official Base / Full-Reference guide): [Shot 1] (no time on the first shot), [Shot 2] At 00:02.500, (later cuts)
//  - H3 span (official accelerated LoRA example predict_ref2v.py: a span within one shot): [Shot 1, 00:00.000-00:02.000]
//  - Markdown heading: # Title … ###### Title
//  - Bold heading: a whole line **10 秒影片 Prompt**, **整體要求：** content, **0.0–1.5 秒：** content (time heading)
//  - Plain time heading: 0.0–1.5 秒：content, 【0–1.5 秒】content
//  - Paragraph: any other text, separated by blank lines
import { formatClock, parseClock, rangeLabel } from "./time";
import { H3_SECTIONS, type BlockLevel, type H3Section, type Heading, type TimeRange } from "./types";

const SECTION_RE = new RegExp(`^(${H3_SECTIONS.join("|")}):[ \\t]*\\r?$`);
const CLOCK = "\\d{1,3}:\\d{2}(?:\\.\\d{1,3})?";
// [Shot n], [Shot n, a-b] (span), [Shot n] At 00:02.500, (official cut time; seconds such as At 2.5s are accepted too and
// the fix suggestions rewrite them the official way)
const SHOT_RE = new RegExp(
  `^\\[Shot[ \\t]+(\\d{1,3})(?:[ \\t]*,[ \\t]*(${CLOCK})[ \\t]*-[ \\t]*(${CLOCK}))?[ \\t]*\\](?:[ \\t]+At[ \\t]+(${CLOCK}|\\d{1,4}(?:\\.\\d{1,3})?(?:[ \\t]*(?:seconds|second|secs|sec|s)(?![A-Za-z]))?)[ \\t]*,?)?`,
);
const MARKDOWN_RE = /^(#{1,6})[ \t]+(\S[^\r\n]*?)[ \t]*(?:[ \t]#+)?[ \t]*\r?$/;
const BOLD_RE = /^(\*\*|__)(?=\S)(.*?\S)\1/;
const DASH = "[ \\t]*(?:[–—―~～〜\\-－]|至|到)[ \\t]*";
const NUMBER = "(\\d{1,4}(?:\\.\\d{1,3})?)";
const UNIT = "(?:秒|seconds|secs|sec|s)";
const TIME_TITLE_RE = new RegExp(`^${NUMBER}(${DASH})${NUMBER}((?:[ \\t]*${UNIT})?)$`, "i");
const PLAIN_TIME_RE = new RegExp(`^${NUMBER}(${DASH})${NUMBER}([ \\t]*${UNIT}[ \\t]*[：:])`, "i");
const BRACKET_TIME_RE = new RegExp(`^(【[ \\t]*)${NUMBER}(${DASH})${NUMBER}((?:[ \\t]*${UNIT})?[ \\t]*】(?:[ \\t]*[：:])?)`, "i");

function decimalsOf(value: string): number {
  const dot = value.indexOf(".");
  return dot < 0 ? 0 : value.length - dot - 1;
}

/** [Shot n, a-b] span marker (without a range = [Shot n]). */
export function shotMarker(shot: number, range: TimeRange | null): string {
  return range ? `[Shot ${shot}, ${formatClock(range.start)}-${formatClock(range.end)}]` : `[Shot ${shot}]`;
}

/** Official shot marker: [Shot n] (no cut-in time, the first shot) or [Shot n] At mm:ss.sss,. */
export function cutMarker(shot: number, cue: number | null): string {
  return cue === null ? `[Shot ${shot}]` : `[Shot ${shot}] At ${formatClock(cue)},`;
}

/** Cut-in time text (00:02.500, 2.5s, 2.5 seconds) → seconds; unparseable → null. */
function parseCue(text: string): number | null {
  if (text.includes(":")) return parseClock(text);
  const value = Number(text.replace(/[ \t]*(?:seconds|second|secs|sec|s)$/i, ""));
  return Number.isFinite(value) ? value : null;
}

function timeHeading(marker: string, prefix: string, start: string, between: string, end: string, suffix: string): Heading {
  const decimals = Math.max(decimalsOf(start), decimalsOf(end));
  const range = { start: Number(start), end: Number(end) };
  return {
    kind: "time",
    level: "paragraph",
    marker,
    title: rangeLabel(range, decimals),
    range,
    cue: null,
    shot: null,
    section: null,
    style: { type: "time", prefix, between, suffix, decimals },
  };
}

function boldHeading(line: string): Heading | null {
  const match = BOLD_RE.exec(line);
  if (!match) return null;
  const delim = match[1] ?? "**";
  const inner = match[2] ?? "";
  const rest = line.slice(match[0].length);
  const insideColon = /[ \t]*[：:]$/.exec(inner);
  const outsideColon = insideColon ? null : /^[ \t]*[：:]/.exec(rest);
  let marker = match[0];
  let title = inner;
  let close = delim;
  let level: BlockLevel = "paragraph";
  if (insideColon) {
    title = inner.slice(0, insideColon.index);
    close = inner.slice(insideColon.index) + delim;
  } else if (outsideColon) {
    marker += outsideColon[0];
    close = delim + outsideColon[0];
  } else if (rest.trim() === "") {
    level = "section";
  } else {
    return null;
  }
  const time = TIME_TITLE_RE.exec(title);
  if (time) return timeHeading(marker, delim, time[1] ?? "", time[2] ?? "", time[3] ?? "", (time[4] ?? "") + close);
  return { kind: "heading", level, marker, title, range: null, cue: null, shot: null, section: null, style: { type: "bold", open: delim, close } };
}

/** Whether a line starts a block; if so → its heading (formatting and the other pure functions share these recognition rules). */
export function lineHeading(line: string): Heading | null {
  const section = SECTION_RE.exec(line);
  if (section) {
    const name = section[1] as H3Section;
    return { kind: "section", level: "section", marker: `${name}:`, title: name, range: null, cue: null, shot: null, section: name, style: { type: "section" } };
  }
  const shot = SHOT_RE.exec(line);
  if (shot) {
    const start = shot[2] ? parseClock(shot[2]) : null;
    const end = shot[3] ? parseClock(shot[3]) : null;
    const range = start !== null && end !== null ? { start, end } : null;
    const number = Number(shot[1]);
    return {
      kind: "shot",
      level: "paragraph",
      marker: shot[0],
      title: `Shot ${number}`,
      range,
      cue: range === null && shot[4] ? parseCue(shot[4]) : null,
      shot: number,
      section: null,
      style: { type: "shot", form: range ? "range" : "cut" },
    };
  }
  const markdown = MARKDOWN_RE.exec(line);
  if (markdown) {
    const hashes = markdown[1] ?? "#";
    return {
      kind: "heading",
      level: "section",
      marker: line.replace(/[ \t\r]+$/, ""),
      title: (markdown[2] ?? "").trim(),
      range: null,
      cue: null,
      shot: null,
      section: null,
      style: { type: "markdown", hashes },
    };
  }
  const bold = boldHeading(line);
  if (bold) return bold;
  const plain = PLAIN_TIME_RE.exec(line);
  if (plain) return timeHeading(plain[0], "", plain[1] ?? "", plain[2] ?? "", plain[3] ?? "", plain[4] ?? "");
  const bracket = BRACKET_TIME_RE.exec(line);
  if (bracket) return timeHeading(bracket[0], bracket[1] ?? "", bracket[2] ?? "", bracket[3] ?? "", bracket[4] ?? "", bracket[5] ?? "");
  return null;
}
