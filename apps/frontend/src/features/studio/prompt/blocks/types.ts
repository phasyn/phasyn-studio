// Types of the prompt block model, and the official H3 section names.

export const H3_SECTIONS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
] as const;
export type H3Section = (typeof H3_SECTIONS)[number];

export type BlockKind = "section" | "shot" | "time" | "heading" | "paragraph";
export type BlockLevel = "section" | "paragraph";

export interface TimeRange {
  start: number;
  end: number;
}

/**
 * How a [Shot n] marker is written: cut = official shot cut ([Shot 1], [Shot n] At mm:ss.sss,; the time is the cut-in
 * point); range = [Shot n, a-b] (the "span within one shot" of the official accelerated LoRA example).
 */
export type ShotForm = "cut" | "range";

/** Original style used to regenerate a heading: only the name or numbers change, every other character (dashes, units, colons, bold markers) stays as written. */
export type MarkerStyle =
  | { type: "section" }
  | { type: "shot"; form: ShotForm }
  | { type: "markdown"; hashes: string }
  | { type: "bold"; open: string; close: string }
  | { type: "time"; prefix: string; between: string; suffix: string; decimals: number };

export interface PromptBlock {
  kind: BlockKind;
  level: BlockLevel;
  /** Heading as written (empty for a paragraph). */
  marker: string;
  /** Text between the heading and the content as written (spaces or line breaks). */
  joiner: string;
  body: string;
  /** Display name (empty for a paragraph). */
  title: string;
  range: TimeRange | null;
  /** Cut-in time (seconds) of an official shot [Shot n] At mm:ss.sss,; null for other blocks. */
  cue: number | null;
  shot: number | null;
  section: H3Section | null;
  style: MarkerStyle | null;
}

export interface PromptDocument {
  /** Blank lines before the first block. */
  lead: string;
  blocks: PromptBlock[];
  /** gaps[i]: line breaks and blank lines after block i (may be empty after the last block). */
  gaps: string[];
}

export type Heading = Omit<PromptBlock, "joiner" | "body">;
