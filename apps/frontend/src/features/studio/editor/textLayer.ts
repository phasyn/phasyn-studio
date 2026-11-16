import type { StudioTimeline, TimelineClip, TimelineSource, TimelineTrack } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { Title } from "../model/clipEffects";
import { defaultTitleStyle } from "../model/titleLayout";
import { clipEnd, defaultMotion, MAX_TIMELINE_FRAMES, MAX_TIMELINE_TRACKS, newTrack, type AllocateId, type TimelineResult } from "./model";
import { timelineProblem } from "./validation";

/** Why a text layer cannot start at a frame. */
const OUTSIDE = t("文字圖層起點超出時間軸範圍");
/** Why no track can take a new text layer. */
const NO_TRACK = t("請先在未鎖定的影像軌保留文字圖層空間，或移除不用的軌道");

/** What a text layer is called on the timeline: the first line it says (the default name when it says nothing). */
export function textLayerName(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, 200) || t("文字圖層");
}

/** Whether a new text layer can start at a frame. */
function validStart(at: number): boolean {
  return Number.isSafeInteger(at) && at >= 0 && at < MAX_TIMELINE_FRAMES;
}

/** Whether a track shows something in [at, at + frames). */
function busy(timeline: StudioTimeline, track: TimelineTrack, at: number, frames: number): boolean {
  return timeline.clips.some((clip) => clip.track_id === track.track_id && clip.start_frame < at + frames && clipEnd(clip) > at);
}

/**
 * The video track a new layer (a title, an adjustment layer) takes in [at, at + frames): the lowest unlocked one above
 * the main picture (the first video track) and above every video track that shows something there, so the layer is on
 * top of what plays under it without a new track when an upper one is free. Null when every such track is taken or
 * locked.
 */
export function freeLayerTrack(timeline: StudioTimeline, at: number, frames: number): TimelineTrack | null {
  const video = timeline.tracks.filter((track) => track.kind === "video");
  const above = Math.max(1, ...video.map((track, index) => (busy(timeline, track, at, frames) ? index + 1 : 0)));
  return video.slice(above).find((track) => !track.locked) ?? null;
}

/** A new video track for text, when the timeline has room for one. */
function textTrack(timeline: StudioTimeline, allocate: AllocateId): TimelineTrack | null {
  return timeline.tracks.length < MAX_TIMELINE_TRACKS ? newTrack(allocate("track"), "video", t("文字圖層")) : null;
}

/** The generated source and the independent clip of a text layer of `frames` frames at `at` on a track, at its default motion. */
export function textLayerParts(
  at: number,
  frames: number,
  title: Title,
  trackId: string,
  size: { width: number; height: number },
  allocate: AllocateId,
): { source: TimelineSource; clip: TimelineClip } {
  const name = textLayerName(title.text);
  const source: TimelineSource = { source_id: allocate("text"), name, kind: "text", file: null, width: size.width, height: size.height, duration_frames: MAX_TIMELINE_FRAMES, has_audio: false };
  const clip: TimelineClip = { clip_id: allocate("clip"), name, source_id: source.source_id, track_id: trackId, start_frame: at, in_frame: 0, out_frame: frames, motion: defaultMotion(), effects: { title } };
  return { source, clip };
}

/** The timeline with a text layer's source and clip, and its track when the track is new; the reason when the document cannot take them. */
export function withTextLayer(timeline: StudioTimeline, source: TimelineSource, clip: TimelineClip, track: TimelineTrack): TimelineResult<{ timeline: StudioTimeline; clipId: string }> {
  const tracks = timeline.tracks.some((item) => item.track_id === track.track_id) ? timeline.tracks : [...timeline.tracks, track];
  const next = { ...timeline, sources: [...timeline.sources, source], tracks, clips: [...timeline.clips, clip] };
  const problem = timelineProblem(next);
  return problem ? { ok: false, error: problem } : { ok: true, value: { timeline: next, clipId: clip.clip_id } };
}

/** The frames a text layer of `seconds` takes from `at`: whole frames, at least one, inside the sequence's bound. */
export function textLayerFrames(timeline: StudioTimeline, at: number, seconds: number): number {
  return Math.min(MAX_TIMELINE_FRAMES - at, Math.max(1, Math.round((seconds * timeline.fps.num) / timeline.fps.den)));
}

/**
 * Where a title placed at `at` for `frames` goes: the free upper track (freeLayerTrack), else a new track on top; the
 * reason when the frame is outside the sequence or no track can take it.
 */
export function titlePlacement(timeline: StudioTimeline, at: number, frames: number, allocate: AllocateId): TimelineResult<TimelineTrack> {
  if (!validStart(at)) return { ok: false, error: OUTSIDE };
  const track = freeLayerTrack(timeline, at, frames) ?? textTrack(timeline, allocate);
  return track ? { ok: true, value: track } : { ok: false, error: NO_TRACK };
}

/** Add a generated source and independent clip as one undoable document transaction. */
export function createTextLayer(timeline: StudioTimeline, at: number, width: number, height: number, allocate: AllocateId): TimelineResult<{ timeline: StudioTimeline; clipId: string }> {
  if (!validStart(at)) return { ok: false, error: OUTSIDE };
  const duration = textLayerFrames(timeline, at, 5);
  const topVideo = [...timeline.tracks].reverse().find((track) => track.kind === "video");
  const available = topVideo && !topVideo.locked && !busy(timeline, topVideo, at, duration) ? topVideo : null;
  const track = available ?? textTrack(timeline, allocate);
  if (!track) return { ok: false, error: NO_TRACK };
  const title: Title = { text: t("新標題"), position: "center", size: "medium", style: defaultTitleStyle(), start_frame: 0, end_frame: null, image: null, image_key: null };
  const { source, clip } = textLayerParts(at, duration, title, track.track_id, { width, height }, allocate);
  // The default layer keeps its generic name until its text is changed
  const name = t("文字圖層");
  return withTextLayer(timeline, { ...source, name }, { ...clip, name }, track);
}
