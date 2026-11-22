import { isRecord } from "@/lib/json";
// In and Out marks of the sources loaded in the Source monitor: remembered per browser, bounded, and keyed by the
// media version and the timebase, so changed media or another frame rate starts with fresh marks. Marks never alter
// the shots the media came from.
import type { StudioTimeline, TimelineSource } from "@/api/generated/contracts";
import { createPersistentStore } from "@/lib/persistentStore";
import { MAX_SOURCE_FRAMES } from "@/api/generated/timelineLimits";

export interface SourceRange {
  inFrame: number;
  outFrame: number;
}

interface SourceMark extends SourceRange {
  key: string;
}

function isMark(item: unknown): item is SourceMark {
  if (!isRecord(item)) return false;
  const entry = item;
  const { key, inFrame, outFrame } = entry;
  if (typeof key !== "string" || key.length > 600 || typeof inFrame !== "number" || typeof outFrame !== "number") return false;
  return Number.isSafeInteger(inFrame) && inFrame >= 0 && Number.isSafeInteger(outFrame) && outFrame > inFrame && outFrame <= MAX_SOURCE_FRAMES;
}

const marks = createPersistentStore<SourceMark[]>({
  key: "phasyn.studio.source-marks",
  initial: [],
  parse: (raw: unknown) => (Array.isArray(raw) ? raw.filter(isMark).slice(-500) : []),
});

function identity(projectId: string, source: TimelineSource, fps: StudioTimeline["fps"]): string {
  return JSON.stringify([projectId, source.source_id, source.file?.sha256 ?? null, fps.num, fps.den]);
}

/** A still shows for five seconds unless marked otherwise; other media starts with its whole length marked. */
function defaultRange(source: TimelineSource, fps: StudioTimeline["fps"]): SourceRange {
  const still = Math.min(source.duration_frames, Math.max(1, Math.round((fps.num / fps.den) * 5)));
  return { inFrame: 0, outFrame: source.kind === "image" ? still : source.duration_frames };
}

function rangeIn(all: readonly SourceMark[], projectId: string, source: TimelineSource, fps: StudioTimeline["fps"]): SourceRange {
  const stored = all.find((item) => item.key === identity(projectId, source, fps));
  return stored && stored.outFrame <= source.duration_frames ? { inFrame: stored.inFrame, outFrame: stored.outFrame } : defaultRange(source, fps);
}

/** The marked range of a source right now (for the key map, which acts whether or not the Source monitor is shown). */
export function sourceRange(projectId: string, source: TimelineSource, fps: StudioTimeline["fps"]): SourceRange {
  return rangeIn(marks.get(), projectId, source, fps);
}

export function setSourceRange(projectId: string, source: TimelineSource, fps: StudioTimeline["fps"], next: SourceRange): void {
  const valid = Number.isSafeInteger(next.inFrame) && Number.isSafeInteger(next.outFrame) && next.inFrame >= 0 && next.inFrame < next.outFrame && next.outFrame <= source.duration_frames;
  if (!valid) return;
  const key = identity(projectId, source, fps);
  marks.set((current) => [...current.filter((item) => item.key !== key).slice(-499), { key, ...next }]);
}

export function useSourceMarks(projectId: string, source: TimelineSource | null, fps: StudioTimeline["fps"]) {
  const all = marks.use();
  const range = source ? rangeIn(all, projectId, source, fps) : null;
  const setRange = (next: SourceRange) => {
    if (source) setSourceRange(projectId, source, fps, next);
  };
  return { range, setRange };
}
