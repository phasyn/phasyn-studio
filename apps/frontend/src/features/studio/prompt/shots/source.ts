// Where each shot of the 逐鏡描述 dialog takes its picture and time range from (pure). The motion reference (the video
// the `… is a motion and camera reference` line names) is a library file used from start_seconds to end_seconds (or the
// file's end). Shot k starts start_seconds + its At time into that file; its picture is read 0.15 s after that (half
// the shot when it is shorter), inside the window. The last shot ends where the clip does: the window or the shot's own
// length, whichever is shorter.
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { t } from "@/i18n";
import { aliasLabels } from "../../references/materials";
import type { MotionReference, ShotLine } from "./layout";

/** Seconds after a cut at which a shot's picture is read (past the cut's first frames). */
const FRAME_OFFSET = 0.15;
/** One frame at 24 fps: the latest picture is read this far before the window ends. */
const FRAME_SECONDS = 1 / 24;

export interface MotionSource {
  /** Studio alias (Video1). */
  alias: string;
  url: string;
  /** The window in the file, in seconds (end null = unknown). */
  start: number;
  end: number | null;
}

export type MotionSourceResult = { ok: true; source: MotionSource } | { ok: false; reason: string };

export interface ShotTiming {
  /** Seconds into the window; null = unknown. */
  start: number | null;
  end: number | null;
}

export function motionSource(motion: MotionReference | null, references: readonly StudioReference[], library: readonly StudioLibraryItem[]): MotionSourceResult {
  if (!motion) return { ok: false, reason: t("Prompt 裡沒有動作參考影片那一行（@Video1 is a motion and camera reference…），所以沒有畫面") };
  let alias: string | null = null;
  if ("alias" in motion) alias = motion.alias;
  else for (const [candidate, label] of aliasLabels(references)) if (label === `<Video ${String(motion.tag)}>`) alias = candidate;
  const name = "alias" in motion ? `@${motion.alias}` : `<Video ${String(motion.tag)}>`;
  const reference = references.find((ref) => ref.kind === "video" && ref.alias === alias);
  if (!(alias != null && alias !== "") || !reference) return { ok: false, reason: t("這個鏡頭沒有 {name} 參考影片，所以沒有畫面", { name }) };
  const item = library.find((entry) => entry.item_id === reference.item_id);
  if (!item) return { ok: false, reason: t("{name} 的檔案已不在素材庫", { name: `@${alias}` }) };
  const start = Math.max(0, reference.start_seconds ?? 0);
  const end = reference.end_seconds ?? item.duration_seconds;
  return { ok: true, source: { alias, url: mediaUrl(item.file.node_id, item.file.file_id), start, end: end !== null && end > start ? end : null } };
}

/** Each shot from its At time to the next shot's; the last one to `clipEnd` (seconds into the window; null = unknown). */
export function shotTimings(shots: readonly ShotLine[], clipEnd: number | null): ShotTiming[] {
  return shots.map((shot, index) => {
    const next = index + 1 < shots.length ? (shots[index + 1]?.start ?? null) : clipEnd;
    return { start: shot.start, end: shot.start !== null && next !== null && next > shot.start ? next : null };
  });
}

/** Seconds of the file to read for a shot's picture; null when the shot's start is unknown. */
export function frameSeconds(timing: ShotTiming, source: MotionSource): number | null {
  if (timing.start === null) return null;
  const into = timing.end !== null ? Math.min(FRAME_OFFSET, (timing.end - timing.start) / 2) : FRAME_OFFSET;
  const at = source.start + timing.start + into;
  const latest = source.end !== null ? Math.max(source.start, source.end - FRAME_SECONDS) : at;
  return Math.max(source.start, Math.min(at, latest));
}

/** Where the clip ends, in seconds into the window: the window's length or the shot's length, whichever is known and shorter. */
export function clipEnd(source: MotionSource | null, durationSeconds: number | null): number | null {
  const window = source && source.end !== null ? source.end - source.start : null;
  const known = [window, durationSeconds].filter((value): value is number => value !== null && value > 0);
  return known.length > 0 ? Math.min(...known) : null;
}
