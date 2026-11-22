import { firstFrameCount } from "@/lib/json";
// Project media as timeline sources, and the readers of the project's one timeline document. The Controller is the
// authority of StudioProject.timeline: it builds the timeline of a project saved before the timeline existed, gives
// every new shot its place and keeps the sources on their shots' active takes on each read and save. Nothing is
// derived here: every reader of the sequence (both workspaces, the status bar, the export) goes through
// projectTimeline and gets the document as the Controller answered it, with the edits made since.
import type { StudioProject, StudioShot, StudioTake, StudioTimeline, TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { MAX_SEQUENCE_FRAMES } from "@/api/generated/timelineLimits";
import { H3_FPS } from "../model/frames";
import { activeTake } from "../model/project";
import { newTrack, type TimelineResult } from "./model";
import { primaryVideoTrack } from "./timelineGeometry";
import { timelineProblem } from "./validation";

/** Stable compact IDs; references retain full source identities. Duplicate IDs are rejected by validation. */
function sourceId(value: string): string {
  let a = 2166136261;
  let b = 3339675911;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 2246822519);
  }
  return `media-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}

function takeSource(project: StudioProject, shot: StudioShot, take: StudioTake | null): TimelineSource {
  const asset = take?.state === "succeeded" && (take.asset?.complete === true) ? take.asset : null;
  const sourceFps = asset?.fps ? asset.fps.num / asset.fps.den : H3_FPS;
  const fps = project.format.fps.num / project.format.fps.den;
  return {
    source_id: sourceId(`shot/${shot.shot_id}/${take?.take_id ?? "pending"}`),
    name: shot.title,
    kind: "video",
    file: asset?.file ?? null,
    duration_frames: Math.max(1, Math.round((firstFrameCount([asset?.frame_count, take?.frames], shot.frames) * fps) / sourceFps)),
    width: asset?.width ?? take?.width ?? project.format.width,
    height: asset?.height ?? take?.height ?? project.format.height,
    has_audio: true,
    shot_id: shot.shot_id,
    ...(take ? { take_id: take.take_id } : {}),
  };
}

/** Available project media. Unknown video/audio durations stay out until probing supplies a duration. */
export function projectSources(project: StudioProject): TimelineSource[] {
  const sources = project.shots.map((shot) => shotSource(project, shot));
  const fps = project.format.fps.num / project.format.fps.den;
  for (const item of project.library ?? []) {
    if (item.kind !== "image" && !(item.duration_seconds !== null && item.duration_seconds > 0)) continue;
    sources.push({
      source_id: sourceId(`library/${item.item_id}`),
      name: item.name,
      kind: item.kind,
      file: item.file,
      duration_frames: item.kind === "image" ? MAX_SEQUENCE_FRAMES : Math.max(1, Math.round((item.duration_seconds ?? 0) * fps)),
      width: item.width ?? 0,
      height: item.height ?? 0,
      has_audio: item.kind === "audio" || item.has_audio === true,
      library_id: item.item_id,
    });
  }
  return sources;
}

/** A shot's source as the timeline binds it (frames at the timeline's rate); file null until the shot has a finished take. */
export function shotSource(project: StudioProject, shot: StudioShot, fps: StudioTimeline["fps"] = project.format.fps): TimelineSource {
  return takeSource({ ...project, format: { ...project.format, fps } }, shot, boundTake(shot));
}

/** The take a shot's clips should show: its active take once that is finished and complete. */
function boundTake(shot: StudioShot): StudioTake | null {
  const take = activeTake(shot);
  return take?.state === "succeeded" && (take.asset?.complete === true) ? take : null;
}

/** A shot's active take that waits to replace the bound media: it is shorter than what the clips use (TimelineSource.pending_take_id). */
export interface ShorterTake {
  sourceId: string;
  shotId: string;
  takeId: string;
  /** Frames of the waiting take at the timeline's rate. */
  durationFrames: number;
}

/**
 * The sources whose shot uses a take that is too short for the edit. The Controller keeps the edit on its media and
 * names the take; the user applies it with the reconcile command, which trims the clips to the media that exists.
 */
export function shorterTakes(project: StudioProject, timeline: StudioTimeline): ShorterTake[] {
  return timeline.sources.flatMap((source): ShorterTake[] => {
    const shot = (source.pending_take_id != null && source.pending_take_id !== "") && (source.shot_id != null && source.shot_id !== "") ? project.shots.find((item) => item.shot_id === source.shot_id) : undefined;
    const take = shot?.takes.find((item) => item.take_id === source.pending_take_id);
    if (!shot || !take || !(source.pending_take_id != null && source.pending_take_id !== "")) return [];
    const durationFrames = takeSource({ ...project, format: { ...project.format, fps: timeline.fps } }, shot, take).duration_frames;
    return [{ sourceId: source.source_id, shotId: shot.shot_id, takeId: source.pending_take_id, durationFrames }];
  });
}

/** The timeline of a project that has none yet (no shot was made): four empty tracks; the first edit saves it. */
export function emptyTimeline(fps: StudioTimeline["fps"]): StudioTimeline {
  return {
    version: 2,
    fps: { ...fps },
    sources: [],
    tracks: [newTrack("video-1", "video", "V1"), newTrack("video-2", "video", "V2"), newTrack("audio-1", "audio", "A1"), newTrack("audio-2", "audio", "A2")],
    clips: [],
    captions: [],
    markers: [],
    master_gain_db: 0,
  };
}

// Project documents are immutable snapshots, so one check per snapshot serves every reader
const checked = new WeakMap<StudioProject, TimelineResult<StudioTimeline>>();

/** The project's one timeline document, or why it cannot be edited. Shots, generation settings and takes are not read. */
export function projectTimeline(project: StudioProject): TimelineResult<StudioTimeline> {
  const cached = checked.get(project);
  if (cached) return cached;
  const timeline = project.timeline ?? emptyTimeline(project.format.fps);
  const error = timelineProblem(timeline);
  const result: TimelineResult<StudioTimeline> = (error != null && error !== "") ? { ok: false, error } : { ok: true, value: timeline };
  checked.set(project, result);
  return result;
}

/** The clips that play a shot's take, in sequence order. */
export function shotClips(timeline: StudioTimeline, shotId: string): TimelineClip[] {
  const sources = new Set(timeline.sources.filter((source) => source.shot_id === shotId).map((source) => source.source_id));
  return timeline.clips.filter((clip) => sources.has(clip.source_id)).sort((a, b) => a.start_frame - b.start_frame);
}

export interface FilmOrder {
  /** Shots with a clip on the timeline, in film order. */
  placed: StudioShot[];
  /** Shots with no clip, in the order they were made. */
  unplaced: StudioShot[];
}

/** The film order of the shots: by their first clip on the first video track (a shot that only sits on other tracks by its first clip there). */
export function filmOrder(project: StudioProject, timeline: StudioTimeline): FilmOrder {
  const main = primaryVideoTrack(timeline)?.track_id;
  const starts = new Map<string, number>();
  for (const shot of project.shots) {
    const clips = shotClips(timeline, shot.shot_id);
    const first = clips.find((clip) => clip.track_id === main) ?? clips[0];
    if (first) starts.set(shot.shot_id, first.start_frame);
  }
  const placed = project.shots.filter((shot) => starts.has(shot.shot_id)).sort((a, b) => (starts.get(a.shot_id) ?? 0) - (starts.get(b.shot_id) ?? 0));
  return { placed, unplaced: project.shots.filter((shot) => !starts.has(shot.shot_id)) };
}
