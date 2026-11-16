// `limits.swap` on a DiT component definition: the one-click swap capacity this deployment measured for that DiT
// (how many characters and how many frames per segment fit). The JSON shape is documented with the component
// definition; this module only validates it at runtime and converts it to camelCase. It holds no measured values:
// without data the wizard falls back to SWAP_DEFAULT_CAPACITY (see limits.ts).
import { isRecord } from "@/lib/json";
import { alignFrames, H3_FRAME_MAX, H3_FRAME_MIN } from "../model/frames";
import { t } from "@/i18n";

/** Characters (reference images) the swap data model allows; a measured limit never goes above it. */
export const MAX_SWAP_CHARACTERS = 4;
/** Shortest H3 generation (96 aligned up to 17n+5 = 107 frames). */
export const MIN_SEGMENT_FRAMES = alignFrames(H3_FRAME_MIN);
const NOTE_MAX = 500;
const MAX_AREA_PX = 1_000_000_000;
const MAX_SHORT_EDGE = 8192;
/** The official reference video short edge: it uses the top-level entry, never a by_reference_short_edge one. */
export const OFFICIAL_REFERENCE_VIDEO_SHORT_EDGE = 768;

/** Table keyed by character count. */
export type ByCharacters = Readonly<Record<number, number>>;
/** Whether going beyond the limit was observed to fail (e.g. out of memory) or simply not tried. */
export type BeyondLimit = "fails" | "untested";

export interface SwapCapacity {
  maxCharacters: number;
  /** Longest segment for any character count (17n+5); the per-count limit is maxFramesFor(). */
  maxFrames: number;
  maxFramesByCharacters: ByCharacters | null;
  /** Total preprocessed reference area (px²) at measurement time, by character count; null = no area check. */
  referenceAreaByCharacters: ByCharacters | null;
  /** Largest output frame (width × height px) the limits were measured at; null = not recorded (no check). */
  maxOutputPixels: number | null;
  beyondLimit: BeyondLimit;
  /** Free text from the deployment (where and how it was measured), shown as is. */
  note: string | null;
}

export interface SwapLimitsSpec extends SwapCapacity {
  /** Complete, separate entries for other TE reference_video_short_edge values (key = short edge in px). */
  byReferenceShortEdge: Readonly<Record<number, SwapCapacity>>;
}

export type SwapLimitsParse = { kind: "absent" } | { kind: "ok"; spec: SwapLimitsSpec } | { kind: "invalid"; problem: string };

const CAPACITY_KEYS = new Set(["max_characters", "max_frames", "max_frames_by_characters", "reference_area_px_by_characters", "max_output_pixels", "beyond_limit", "note"]);
const TOP_KEYS = new Set([...CAPACITY_KEYS, "by_reference_short_edge"]);

class SpecProblem extends Error {}

/** Largest 17n+5 frame count not above value. */
export function floorFrames(value: number): number {
  return value - ((((value - 5) % 17) + 17) % 17);
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new SpecProblem(t("{path} 必須是 {min}–{max} 的整數", { path, min, max }));
  return value;
}

function frames(value: unknown, path: string): number {
  return floorFrames(integer(value, path, MIN_SEGMENT_FRAMES, H3_FRAME_MAX));
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SpecProblem(t("{path} 必須是物件", { path }));
  return value;
}

function keyNumber(key: string, path: string, min: number, max: number, what: string): number {
  const value = /^\d+$/.test(key) ? Number(key) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) throw new SpecProblem(t("{path} 的 key 必須是 {min}–{max} 的整數（{what}）", { path, min, max, what }));
  return value;
}

function byCharacters(value: unknown, path: string, read: (item: unknown, itemPath: string) => number): ByCharacters | null {
  if (value === undefined || value === null) return null;
  const out: Record<number, number> = {};
  for (const [key, item] of Object.entries(record(value, path))) {
    out[keyNumber(key, path, 1, MAX_SWAP_CHARACTERS, t("角色數"))] = read(item, `${path}.${key}`);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function rejectUnknown(value: Record<string, unknown>, path: string, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new SpecProblem(t("{path} 不認得這個欄位", { path: `${path}.${unknown}` }));
}

function capacity(value: Record<string, unknown>, path: string): SwapCapacity {
  const beyond = value.beyond_limit;
  if (beyond !== undefined && beyond !== "fails" && beyond !== "untested") throw new SpecProblem(t("{path} 只能是 fails 或 untested", { path: `${path}.beyond_limit` }));
  const note = value.note;
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > NOTE_MAX)) throw new SpecProblem(t("{path} 必須是 {max} 字以內的文字", { path: `${path}.note`, max: NOTE_MAX }));
  return {
    maxCharacters: integer(value.max_characters, `${path}.max_characters`, 1, MAX_SWAP_CHARACTERS),
    maxFrames: frames(value.max_frames, `${path}.max_frames`),
    maxFramesByCharacters: byCharacters(value.max_frames_by_characters, `${path}.max_frames_by_characters`, frames),
    referenceAreaByCharacters: byCharacters(value.reference_area_px_by_characters, `${path}.reference_area_px_by_characters`, (item, itemPath) => integer(item, itemPath, 1, MAX_AREA_PX)),
    maxOutputPixels: value.max_output_pixels === undefined || value.max_output_pixels === null ? null : integer(value.max_output_pixels, `${path}.max_output_pixels`, 1, MAX_AREA_PX),
    beyondLimit: beyond === "fails" ? "fails" : "untested",
    note: typeof note === "string" && note.trim() ? note.trim() : null,
  };
}

/** Validates `component.limits` and returns its `swap` entry; absent when the component declares none. */
export function parseSwapLimits(limits: unknown): SwapLimitsParse {
  if (limits === undefined || limits === null) return { kind: "absent" };
  const path = "limits.swap";
  try {
    const root = record(limits, "limits");
    if (root.swap === undefined || root.swap === null) return { kind: "absent" };
    const swap = record(root.swap, path);
    rejectUnknown(swap, path, TOP_KEYS);
    const byEdge: Record<number, SwapCapacity> = {};
    const edges = swap.by_reference_short_edge;
    if (edges !== undefined && edges !== null) {
      const edgesPath = `${path}.by_reference_short_edge`;
      for (const [key, entry] of Object.entries(record(edges, edgesPath))) {
        const edge = keyNumber(key, edgesPath, 1, MAX_SHORT_EDGE, t("參考影片短邊 px"));
        const entryPath = `${edgesPath}.${key}`;
        if (edge === OFFICIAL_REFERENCE_VIDEO_SHORT_EDGE) throw new SpecProblem(t("{path}：官方的參考影片短邊 768 用頂層的值，不必另外列出", { path: entryPath }));
        const value = record(entry, entryPath);
        rejectUnknown(value, entryPath, CAPACITY_KEYS);
        byEdge[edge] = capacity(value, entryPath);
      }
    }
    return { kind: "ok", spec: { ...capacity(swap, path), byReferenceShortEdge: byEdge } };
  } catch (error) {
    if (error instanceof SpecProblem) return { kind: "invalid", problem: error.message };
    throw error;
  }
}

/** A capacity as `limits.swap` stores it (the documented snake_case keys); empty tables and missing values are left out. */
export function swapCapacityJson(capacity: SwapCapacity): Record<string, unknown> {
  const table = (value: ByCharacters | null) => (value && Object.keys(value).length > 0 ? { ...value } : undefined);
  const entries: [string, unknown][] = [
    ["max_characters", capacity.maxCharacters],
    ["max_frames", capacity.maxFrames],
    ["max_frames_by_characters", table(capacity.maxFramesByCharacters)],
    ["reference_area_px_by_characters", table(capacity.referenceAreaByCharacters)],
    ["max_output_pixels", capacity.maxOutputPixels ?? undefined],
    ["beyond_limit", capacity.beyondLimit],
    ["note", capacity.note ?? undefined],
  ];
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}
