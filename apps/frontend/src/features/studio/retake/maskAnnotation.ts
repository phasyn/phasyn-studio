// The media.mask-annotations.v1 value the mask route takes (the same document components/common/MaskAnnotationInput
// writes): per marked native frame its foreground/background points and an optional box, in source pixels.
import type { WireTypedValue } from "@/api/types";
import { natural, type FrameAddress } from "@/components/common/maskFramePreview";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";

export const MASK_ANNOTATIONS = "media.mask-annotations.v1";
export const MAX_POINTS = 64;
export const MAX_OBJECT = 2_147_483_647;
export type Direction = "forward" | "backward" | "both";
export type MarkTool = "positive" | "negative" | "box";
export interface XY { x: number; y: number }
export type Point = XY & { label: 0 | 1 };
export type Box = [number, number, number, number];
export type Mark = FrameAddress & { points: Point[]; box?: Box };
export interface Annotation { version: 1; revision?: number; source_sha256: string; width: number; height: number; object_id: number; direction: Direction; marks: Mark[] }

export function inside(n: unknown, bound: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n < bound;
}
export function isDirection(value: unknown): value is Direction {
  return value === "forward" || value === "backward" || value === "both";
}
export function isBox(v: unknown, w: number, h: number): v is Box {
  return Array.isArray(v) && v.length === 4 && inside(v[0], w) && inside(v[1], h)
    && inside(v[2], w) && inside(v[3], h) && v[0] < v[2] && v[1] < v[3];
}
export function boxFrom(a: XY, b: XY): Box {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

function readMark(v: unknown, w: number, h: number): Mark | null {
  if (!isRecord(v)) return null;
  const { frame_index: index, time_us: time, points: rawPoints = [], box } = v;
  if (("time_us" in v) === ("frame_index" in v)) return null;
  const frame: FrameAddress | null = natural(index) ? { frame_index: index } : natural(time) ? { time_us: time } : null;
  if (!frame || !Array.isArray(rawPoints) || rawPoints.length > MAX_POINTS) return null;
  if (box !== undefined && !isBox(box, w, h)) return null;
  const points: Point[] = [];
  for (const item of rawPoints as unknown[]) {
    if (!isRecord(item)) return null;
    const { x, y, label } = item;
    if (!inside(x, w) || !inside(y, h) || (label !== 0 && label !== 1)) return null;
    points.push({ x, y, label });
  }
  return points.length || box ? { ...frame, points, ...(box ? { box } : {}) } : null;
}

export function frameKey(frame: FrameAddress): string {
  return frame.frame_index !== undefined ? `f${String(frame.frame_index)}` : `t${String(frame.time_us)}`;
}

/** The annotation in a typed value, or null when it is absent or malformed. */
export function readAnnotation(value: WireTypedValue | null): Annotation | null {
  if (value?.type_id !== MASK_ANNOTATIONS || !("value" in value) || !isRecord(value.value)) return null;
  const { version, revision, source_sha256, width, height, object_id, direction, marks: rows } = value.value;
  if (version !== 1 || (revision !== undefined && (!natural(revision, 1) || revision > MAX_OBJECT)) || typeof source_sha256 !== "string" || !natural(width, 1) || !natural(height, 1)
    || !natural(object_id, 1) || object_id > MAX_OBJECT || !isDirection(direction) || !Array.isArray(rows)) return null;
  const marks: Mark[] = [];
  const frames = new Set<string>();
  for (const row of rows as unknown[]) {
    const mark = readMark(row, width, height);
    if (!mark || frames.has(frameKey(mark))) return null;
    frames.add(frameKey(mark));
    marks.push(mark);
  }
  return { version: 1, ...(revision !== undefined ? { revision } : {}), source_sha256, width, height, object_id, direction, marks };
}

export function frameLabel(frame: FrameAddress): string {
  return frame.frame_index !== undefined
    ? t("第 {index} 幀（從 0 起算）", { index: frame.frame_index })
    : t("距第一幀 {us} 微秒", { us: frame.time_us });
}

export function numberField(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
