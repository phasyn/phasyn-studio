// What differs between two takes of a shot, read only from the settings each take stores when it is rendered (prompt,
// Prompt plugins, seed, length, size, route, steps, the reference files sent and the first frame). The monitor's take
// strip shows the short labels as tags on a card and the details in its tooltip. Pure.
import type { StudioTake, StudioTakeReference } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { formatDuration, H3_FPS } from "./frames";

export type TakeDiffKey = "prompt" | "seed" | "references" | "route" | "steps" | "frames" | "size" | "plugins" | "firstFrame";

export interface TakeDifference {
  key: TakeDiffKey;
  /** Short tag: a word or two. */
  label: string;
  /** One line for the tooltip: this take's value against the reference's. */
  detail: string;
  /** Further tooltip lines (the prompt: the first lines that differ). */
  more: string[];
}

export interface TakeDiffOptions {
  /** A route id as people know it (the combination's short name); the id itself by default. */
  routeLabel?: (routeId: string) => string;
  /** The project's frame rate, to write lengths in seconds. */
  fps?: number;
}

/** Prompt lines quoted in a tooltip: at most this many, each cut to EXCERPT characters. */
const PROMPT_EXCERPTS = 2;
const EXCERPT = 72;

function excerpt(line: string): string {
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT - 1)}…` : line;
}

function promptLines(prompt: string): string[] {
  return prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Lines of `text` that `other` does not contain, in order (a line-level comparison: prompts are written in sections). */
function linesMissingFrom(text: readonly string[], other: readonly string[]): string[] {
  const present = new Set(other);
  return text.filter((line) => !present.has(line));
}

function promptDifference(take: string, reference: string): TakeDifference | null {
  if (take === reference) return null;
  const mine = promptLines(take);
  const theirs = promptLines(reference);
  const added = linesMissingFrom(mine, theirs);
  const removed = linesMissingFrom(theirs, mine);
  const count = Math.max(added.length, removed.length);
  const more = [
    ...added.slice(0, PROMPT_EXCERPTS).map((line) => t("這個 take：「{text}」", { text: excerpt(line) })),
    ...removed.slice(0, PROMPT_EXCERPTS).map((line) => t("使用中：「{text}」", { text: excerpt(line) })),
  ];
  // Only spacing or blank lines changed: the lines themselves are the same
  const detail = count > 0 ? t("prompt：{count} 行不同", { count }) : t("prompt：只有空白或換行不同");
  return { key: "prompt", label: "prompt", detail, more };
}

/**
 * A setting with one value per take: `text` writes it for people; when two different values read the same (two routes
 * with one name, lengths that round alike) the raw values are shown instead.
 */
function scalar<T extends string | number | null>(
  field: { key: TakeDiffKey; label: string; name: string },
  value: T,
  reference: T,
  text: (item: T) => string = String,
): TakeDifference | null {
  if (value === reference) return null;
  const same = text(value) === text(reference);
  const values = { label: field.name, value: same ? String(value) : text(value), reference: same ? String(reference) : text(reference) };
  return { key: field.key, label: field.label, detail: t("{label}：{value}（使用中 {reference}）", values), more: [] };
}

/** What makes two sent references the same: kind, file, cut and the held last frame (the alias is the key they are compared under). */
const referenceKey = (ref: StudioTakeReference) =>
  [ref.kind, ref.file.node_id, ref.file.file_id, ref.start_seconds ?? "", ref.end_seconds ?? "", ref.hold_last_frame === true ? "hold" : ""].join("|");

function referenceDifference(take: readonly StudioTakeReference[], reference: readonly StudioTakeReference[]): TakeDifference | null {
  const mine = new Map(take.map((ref) => [ref.alias, referenceKey(ref)]));
  const theirs = new Map(reference.map((ref) => [ref.alias, referenceKey(ref)]));
  const aliases = [...new Set([...mine.keys(), ...theirs.keys()])].filter((alias) => mine.get(alias) !== theirs.get(alias)).sort();
  if (aliases.length === 0) return null;
  const detail = t("參考素材不同：{aliases}（這個 take {count} 個，使用中 {reference} 個）", {
    aliases: formatList(aliases.map((alias) => `@${alias}`)),
    count: take.length,
    reference: reference.length,
  });
  return { key: "references", label: t("參考"), detail, more: [] };
}

function pluginText(take: Pick<StudioTake, "prompt_plugins">): string {
  const refs = [...new Set(take.prompt_plugins ?? [])].sort();
  return refs.length > 0 ? formatList(refs) : t("無");
}

function pluginDifference(take: StudioTake, reference: StudioTake): TakeDifference | null {
  const changed = scalar({ key: "plugins", label: t("插件"), name: t("插件") }, pluginText(take), pluginText(reference));
  if (changed) return changed;
  const revs = (item: StudioTake) => JSON.stringify(Object.entries(item.prompt_plugin_revs ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return revs(take) === revs(reference) ? null : { key: "plugins", label: t("插件"), detail: t("插件的內容版本不同"), more: [] };
}

/** The first frame as a comparable key and a few words. */
function firstFrame(take: StudioTake): { key: string; text: string } {
  const continuity = take.continuity;
  if (!continuity) return { key: "none", text: t("無") };
  if (continuity.mode === "image") return { key: `image|${continuity.item_id}`, text: t("素材庫圖片") };
  const source = [continuity.source_shot_id, continuity.source_take_id, continuity.source_frame_index ?? ""].join("|");
  return { key: `previous|${source}`, text: t("接續前一個鏡頭") };
}

function firstFrameDifference(take: StudioTake, reference: StudioTake): TakeDifference | null {
  const mine = firstFrame(take);
  const theirs = firstFrame(reference);
  if (mine.key === theirs.key) return null;
  if (mine.text === theirs.text) return { key: "firstFrame", label: t("首幀"), detail: t("首幀的來源不同"), more: [] };
  return scalar({ key: "firstFrame", label: t("首幀"), name: t("首幀") }, mine.text, theirs.text);
}

const stepsText = (steps: number | null) => (steps === null ? t("元件預設") : String(steps));

/**
 * How `take` differs from `reference` (normally the shot's active take), most telling first. Empty when every stored
 * setting is the same (two takes of the same settings differ only in what the model made of them).
 */
export function takeDifferences(take: StudioTake, reference: StudioTake, options: TakeDiffOptions = {}): TakeDifference[] {
  if (take.take_id === reference.take_id) return [];
  const route = options.routeLabel ?? ((id: string) => id);
  const fps = options.fps ?? H3_FPS;
  const differences = [
    promptDifference(take.prompt, reference.prompt),
    scalar({ key: "seed", label: "seed", name: "seed" }, take.seed, reference.seed),
    referenceDifference(take.references ?? [], reference.references ?? []),
    scalar({ key: "route", label: t("路線"), name: t("運算路由") }, take.route, reference.route, route),
    scalar({ key: "steps", label: t("步數"), name: t("步數") }, take.steps, reference.steps, stepsText),
    scalar({ key: "frames", label: t("時長"), name: t("時長") }, take.frames, reference.frames, (frames) => formatDuration(frames, fps)),
    scalar({ key: "size", label: t("解析度"), name: t("解析度") }, `${take.width}×${take.height}`, `${reference.width}×${reference.height}`),
    pluginDifference(take, reference),
    firstFrameDifference(take, reference),
  ];
  return differences.filter((item): item is TakeDifference => item !== null);
}
