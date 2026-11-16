// Shot variants (pure): one shot rendered several ways in one run, every way a take of the same shot. The axes a
// person sets in the generation row's 數量 popover: the seeds (the shot's own fixed seed, new random seeds, typed fixed
// seeds), the file behind one reference alias (another library file of the same kind; its clip window stays when the
// new file holds it, the rule of 換成其他檔案) and the route (other ready routes of the same task). The takes are every
// combination, routes × files × seeds with the shot's own value first on each axis, so the first take is the shot as
// it is whenever its own values are chosen; there are MIN_VARIANT_TAKES–MAX_VARIANT_TAKES of them. A random seed is
// drawn once, so every file and route is tried with the same seeds. Nothing here changes the shot: each take records
// what it was rendered with (renderPlan.ts), variantBadge says what a variant take has that the shot does not, and
// takeSettings copies a take's seed, references and route back, so the shot matches that take again (the stale check
// of project.ts). The same axes for several shots at once, all in one batch run, are model/variantBatch.ts.
import type { FileRef, StudioLibraryItem, StudioReference, StudioShot, StudioTake, StudioTakeReference } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { joinInline } from "@/i18n/format";
import { replacedReference, videoLibrary } from "../references/materials";
import { MAX_SEED, RANDOM_SEED, randomSeed, type ShotPatch } from "./project";
import { sameTakeReferences, takeReferences } from "./takeRefs";

export const MIN_VARIANT_TAKES = 2;
export const MAX_VARIANT_TAKES = 8;
/** How many new random seeds the popover offers (0: the other choices make the takes). */
export const RANDOM_SEED_COUNTS = [0, 1, 2, 3, 4] as const;

/** What a variant take renders differently: its seed, its route and maybe its references (the rest is the shot's). */
export type ShotVariant = Pick<StudioShot, "seed" | "route" | "references">;

/** The variants of one shot in a batch of several shots' variants (model/variantBatch.ts). */
export interface ShotVariants {
  shotId: string;
  variants: readonly ShotVariant[];
}

/** The person's choices in the popover. */
export interface VariantChoices {
  /** The shot's own seed (only a fixed one counts). */
  ownSeed: boolean;
  randomSeeds: number;
  /** Typed fixed seeds, in the order they were added. */
  fixedSeeds: readonly number[];
  /** The reference whose file varies (its ref_id) and the library items to try; null = every reference keeps its file. */
  files: { refId: string; itemIds: readonly string[] } | null;
  /** The routes to try; null = the shot's route (it follows the shot until a route is picked here). */
  routes: readonly string[] | null;
}

/** Where the popover starts: two new random seeds, the 數量 ×2 of before. */
export const INITIAL_CHOICES: VariantChoices = { ownSeed: false, randomSeeds: 2, fixedSeeds: [], files: null, routes: null };

/** One seed to try: the shot's own or a typed one, or a new random draw. */
export type VariantSeed = { kind: "own" | "fixed"; seed: number } | { kind: "random" };

/** The values of every axis, in the order they are combined. */
export interface VariantAxes {
  seeds: VariantSeed[];
  /** The reference that varies and the files it tries (its own first when chosen); null = the files stay. */
  files: { ref: StudioReference; items: StudioLibraryItem[] } | null;
  routes: string[];
}

/** One take of the run: its route, the file the varying reference uses (null = the files stay) and its seed (an index into the axes' seeds). */
export interface VariantCombo {
  route: string;
  item: StudioLibraryItem | null;
  seed: number;
}

/** Seeds typed in one go (「42 1001, 7」): the numbers, or why one of them is not a seed. */
export function parseSeeds(text: string): { seeds: number[]; problem: string | null } {
  const seeds: number[] = [];
  for (const token of text.split(/[\s,;、，；]+/u).filter(Boolean)) {
    const value = /^\d{1,10}$/u.test(token) ? Number(token) : Number.NaN;
    if (!Number.isInteger(value) || value > MAX_SEED) return { seeds: [], problem: t("「{value}」不是 seed：seed 是 0–{max} 的整數", { value: token, max: MAX_SEED }) };
    seeds.push(value);
  }
  return { seeds, problem: null };
}

/** The files a reference can try: its own first, then the other library files of its kind (no Image Studio masks). */
export function fileChoices(ref: StudioReference, library: readonly StudioLibraryItem[]): StudioLibraryItem[] {
  const items = videoLibrary(library).filter((item) => item.kind === ref.kind);
  return [...items.filter((item) => item.item_id === ref.item_id), ...items.filter((item) => item.item_id !== ref.item_id)];
}

export function variantAxes(shot: StudioShot, choices: VariantChoices, library: readonly StudioLibraryItem[]): VariantAxes {
  const seeds: VariantSeed[] = [];
  const seen = new Set<number>();
  if (choices.ownSeed && shot.seed !== RANDOM_SEED) {
    seeds.push({ kind: "own", seed: shot.seed });
    seen.add(shot.seed);
  }
  for (const seed of choices.fixedSeeds) {
    if (seen.has(seed)) continue;
    seen.add(seed);
    seeds.push({ kind: "fixed", seed });
  }
  for (let index = 0; index < choices.randomSeeds; index += 1) seeds.push({ kind: "random" });
  const pick = choices.files;
  const ref = pick ? (shot.references ?? []).find((item) => item.ref_id === pick.refId) : undefined;
  const files = pick && ref ? { ref, items: fileChoices(ref, library).filter((item) => pick.itemIds.includes(item.item_id)) } : null;
  return { seeds, files, routes: [...new Set(choices.routes ?? [shot.route])] };
}

export function variantCount(axes: VariantAxes): number {
  return axes.seeds.length * (axes.files ? axes.files.items.length : 1) * axes.routes.length;
}

/** Every take of the run in order: routes, then files, then seeds. */
export function variantCombos(axes: VariantAxes): VariantCombo[] {
  const items = axes.files ? axes.files.items : [null];
  return axes.routes.flatMap((route) => items.flatMap((item) => axes.seeds.map((_seed, seed) => ({ route, item, seed }))));
}

/** Why the choices make no run (nothing on an axis, too few or too many takes); null when they do. */
export function choicesProblem(axes: VariantAxes): string | null {
  if (axes.seeds.length === 0) return t("至少選一個 seed");
  if (axes.files && axes.files.items.length === 0) return t("至少選一個 @{alias} 的檔案", { alias: axes.files.ref.alias });
  if (axes.routes.length === 0) return t("至少選一條路線");
  const count = variantCount(axes);
  if (count < MIN_VARIANT_TAKES) return t("至少要 {min} 個 take：再多選一個 seed、檔案或路線", { min: MIN_VARIANT_TAKES });
  if (count > MAX_VARIANT_TAKES) return t("最多 {max} 個 take（目前 {count} 個）：少選幾個 seed、檔案或路線", { max: MAX_VARIANT_TAKES, count });
  return null;
}

/** The shot as one take renders it: the combination's seed, file and route; everything else is the shot's. */
function comboShot(shot: StudioShot, axes: VariantAxes, combo: VariantCombo, seed: number): StudioShot {
  const ref = axes.files?.ref;
  const item = combo.item;
  const references =
    ref && item && item.item_id !== ref.item_id
      ? (shot.references ?? []).map((entry) => (entry.ref_id === ref.ref_id ? replacedReference(entry, item.item_id, item.duration_seconds) : entry))
      : shot.references;
  return { ...shot, seed, route: combo.route, ...(references ? { references } : {}) };
}

/** Every seed as a number: fixed ones as they are, a random one drawn once (unlike the others in the run). */
export function drawSeeds(seeds: readonly VariantSeed[], draw: () => number = randomSeed): number[] {
  const used = new Set(seeds.flatMap((seed) => (seed.kind === "random" ? [] : [seed.seed])));
  return seeds.map((seed) => {
    if (seed.kind !== "random") return seed.seed;
    let value = draw();
    for (let attempt = 0; used.has(value) && attempt < 16; attempt += 1) value = draw();
    used.add(value);
    return value;
  });
}

/** The takes to send, in order, with their random seeds drawn now. */
export function variantShots(shot: StudioShot, axes: VariantAxes, draw: () => number = randomSeed): StudioShot[] {
  const seeds = drawSeeds(axes.seeds, draw);
  return variantCombos(axes).map((combo) => comboShot(shot, axes, combo, seeds[combo.seed] ?? RANDOM_SEED));
}

/** The same takes before sending (the estimate and the render check): a random seed is still -1, drawn when sent. */
export function previewShots(shot: StudioShot, axes: VariantAxes): StudioShot[] {
  return variantCombos(axes).map((combo) => {
    const seed = axes.seeds[combo.seed];
    return comboShot(shot, axes, combo, seed && seed.kind !== "random" ? seed.seed : RANDOM_SEED);
  });
}

/** A long file name cut in the middle, its start and its end with the extension kept: 「night-…smallblur.mp4」. */
export function shortFileName(name: string, max = 20): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const tail = Math.ceil(((max - 1) * 2) / 3);
  return `${chars.slice(0, max - 1 - tail).join("")}…${chars.slice(-tail).join("")}`;
}

const routePart = (name: string) => t("路線 {name}", { name });

export interface VariantBadge {
  /** 「seed 20261116・@Video1 night-…smallblur.mp4・路線 B」, or 「同鏡頭設定」. */
  text: string;
  /** Nothing differs from the shot. */
  same: boolean;
}

const badgeOf = (parts: readonly string[]): VariantBadge => (parts.length > 0 ? { text: joinInline(parts), same: false } : { text: t("同鏡頭設定"), same: true });

/** What one take of the run changes from the shot (the popover's list): 「隨機 seed 2・@Video1 night-…blur.mp4」. */
export function comboBadge(shot: StudioShot, axes: VariantAxes, combo: VariantCombo, routeLabel: (routeId: string) => string): VariantBadge {
  const parts: string[] = [];
  const seed = axes.seeds[combo.seed];
  if (seed?.kind === "fixed") parts.push(`seed ${seed.seed}`);
  else if (seed?.kind === "random") parts.push(t("隨機 seed {number}", { number: axes.seeds.slice(0, combo.seed + 1).filter((item) => item.kind === "random").length }));
  const ref = axes.files?.ref;
  if (ref && combo.item && combo.item.item_id !== ref.item_id) parts.push(`@${ref.alias} ${shortFileName(combo.item.name)}`);
  if (combo.route !== shot.route) parts.push(routePart(routeLabel(combo.route)));
  return badgeOf(parts);
}

// ---------------------------------------------------------------- variant takes

/** A take of a run that rendered several takes of this shot (variants, and the random-seed variations of before). */
export function isVariantTake(shot: StudioShot, take: StudioTake): boolean {
  return shot.takes.filter((item) => item.run_id === take.run_id).length > 1;
}

/** Some run rendered several takes of this shot. */
export function hasVariantTakes(shot: StudioShot): boolean {
  const runs = new Set<string>();
  for (const take of shot.takes) {
    if (runs.has(take.run_id)) return true;
    runs.add(take.run_id);
  }
  return false;
}

const fileKey = (file: FileRef) => `${file.node_id}\n${file.file_id}`;
const clipKey = (ref: StudioTakeReference) => [ref.start_seconds ?? "", ref.end_seconds ?? "", ref.hold_last_frame === true ? "hold" : ""].join("|");

function fileName(file: FileRef, library: readonly StudioLibraryItem[]): string {
  return library.find((item) => fileKey(item.file) === fileKey(file))?.name ?? t("不在素材庫的檔案");
}

/** The references a take sent that the shot does not send now, by alias: the file, or only the clip. */
function referenceParts(sent: readonly StudioTakeReference[], current: readonly StudioTakeReference[], library: readonly StudioLibraryItem[]): string[] {
  const now = new Map(current.map((ref) => [ref.alias, ref]));
  const parts: string[] = [];
  for (const ref of sent) {
    const other = now.get(ref.alias);
    if (other?.kind === ref.kind && fileKey(other.file) === fileKey(ref.file)) {
      if (clipKey(other) !== clipKey(ref)) parts.push(t("@{alias} 片段不同", { alias: ref.alias }));
      continue;
    }
    parts.push(`@${ref.alias} ${shortFileName(fileName(ref.file, library))}`);
  }
  const aliases = new Set(sent.map((ref) => ref.alias));
  for (const ref of current) if (!aliases.has(ref.alias)) parts.push(t("沒有 @{alias}", { alias: ref.alias }));
  return parts;
}

/**
 * What a variant take was rendered with that the shot does not have now: its seed (always, for a shot whose seed is
 * random: it is what tells the takes apart), the files of its references (ref2va) and its route. Null for a take that
 * is not a variant.
 */
export function variantBadge(take: StudioTake, shot: StudioShot, library: readonly StudioLibraryItem[], routeLabel: (routeId: string) => string): VariantBadge | null {
  if (!isVariantTake(shot, take)) return null;
  const parts: string[] = [];
  if (shot.seed === RANDOM_SEED || take.seed !== shot.seed) parts.push(`seed ${take.seed}`);
  if (take.task === "ref2va") parts.push(...referenceParts(take.references ?? [], takeReferences(shot.references ?? [], library), library));
  if (take.route !== shot.route) parts.push(routePart(routeLabel(take.route)));
  return badgeOf(parts);
}

// ---------------------------------------------------------------- 套用這個 take 的設定

export interface TakeSettings {
  /** The shot edit that makes it render the take's seed, references and route; null when they already match. */
  patch: ShotPatch | null;
  /** What the edit changes, in words (seed, @Video1, 路線). */
  changes: string[];
  /** Why the take's references cannot be copied (a file it used is no longer in the library); null when they can. */
  problem: string | null;
}

/** The library item behind a sent file: the one the shot's reference names when that is the file, else the first. */
function itemForFile(want: StudioTakeReference, before: StudioReference | undefined, library: readonly StudioLibraryItem[]): StudioLibraryItem | undefined {
  const holds = (item: StudioLibraryItem) => item.kind === want.kind && fileKey(item.file) === fileKey(want.file);
  const own = before ? library.find((item) => item.item_id === before.item_id) : undefined;
  if (own && holds(own)) return own;
  return videoLibrary(library).find(holds) ?? library.find(holds);
}

const sameSent = (a: StudioReference, b: StudioReference) =>
  a.item_id === b.item_id && a.start_seconds === b.start_seconds && a.end_seconds === b.end_seconds && (a.hold_last_frame === true) === (b.hold_last_frame === true);

/**
 * The shot's references as the take sent them: a reference keeps its id and sound setting and takes the file, clip and
 * held last frame the take used; one the take did not send goes, one only the take had comes back with a new id.
 */
function referencesFromTake(
  sent: readonly StudioTakeReference[],
  current: readonly StudioReference[],
  library: readonly StudioLibraryItem[],
  newRefId: () => string,
): { references: StudioReference[]; changed: string[]; problem: string | null } {
  const key = (ref: Pick<StudioReference, "kind" | "alias">) => `${ref.kind}:${ref.alias}`;
  const wanted = new Map(sent.map((ref) => [key(ref), ref]));
  const placed = new Set<string>();
  const references: StudioReference[] = [];
  const changed: string[] = [];
  const build = (want: StudioTakeReference, before: StudioReference | undefined): StudioReference | null => {
    const item = itemForFile(want, before, library);
    if (!item) return null;
    const base: StudioReference = before ?? { ref_id: newRefId(), kind: want.kind, alias: want.alias, item_id: item.item_id, start_seconds: null, end_seconds: null, ...(want.kind === "video" ? { use_embedded_audio: null } : {}) };
    const next: StudioReference = { ...base, item_id: item.item_id, start_seconds: want.start_seconds, end_seconds: want.end_seconds };
    if (want.hold_last_frame === true) next.hold_last_frame = true;
    else if (next.hold_last_frame !== undefined) next.hold_last_frame = null;
    return next;
  };
  const missing = (alias: string) => ({ references: [], changed: [], problem: t("@{alias} 用的檔案已不在素材庫，無法套用這個 take 的參考", { alias }) });
  for (const before of current) {
    const want = wanted.get(key(before));
    if (!want || placed.has(key(before))) {
      changed.push(before.alias);
      continue;
    }
    placed.add(key(before));
    const next = build(want, before);
    if (!next) return missing(want.alias);
    if (!sameSent(next, before)) changed.push(want.alias);
    references.push(next);
  }
  for (const want of sent) {
    if (placed.has(key(want))) continue;
    placed.add(key(want));
    const next = build(want, undefined);
    if (!next) return missing(want.alias);
    references.push(next);
    changed.push(want.alias);
  }
  return { references, changed: [...new Set(changed)], problem: null };
}

/**
 * 「套用這個 take 的設定」: the shot edit that copies the take's seed, references (a ref2va take; other takes sent none)
 * and route to the shot, so the shot is no longer stale against it (unless its prompt or another setting changed since).
 */
export function takeSettings(take: StudioTake, shot: StudioShot, library: readonly StudioLibraryItem[], newRefId: () => string): TakeSettings {
  const patch: ShotPatch = {};
  const changes: string[] = [];
  if (take.seed !== shot.seed) {
    patch.seed = take.seed;
    changes.push("seed");
  }
  if (take.task === "ref2va" && !sameTakeReferences(take, takeReferences(shot.references ?? [], library))) {
    const rebuilt = referencesFromTake(take.references ?? [], shot.references ?? [], library, newRefId);
    if (rebuilt.problem !== null) return { patch: null, changes: [], problem: rebuilt.problem };
    patch.references = rebuilt.references;
    changes.push(...(rebuilt.changed.length > 0 ? rebuilt.changed.map((alias) => `@${alias}`) : [t("參考")]));
  }
  if (take.route !== shot.route) {
    patch.route = take.route;
    changes.push(t("路線"));
  }
  return { patch: Object.keys(patch).length > 0 ? patch : null, changes, problem: null };
}
