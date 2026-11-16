// Placing a source on the timeline: which tracks a drop lands on, and the one "place" edit that an insert or overwrite
// button, a shot that joins the film and a drop all run. Pure: the timeline previews a drop with the same edit that a
// release then commits.
import type { StudioTimeline, TimelineClip, TimelineSource, TimelineTrack } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { EditCommand } from "./commands";
import { defaultMotion, type AllocateId, type TimelineResult } from "./model";

export type PlaceMode = "insert" | "overwrite";

export interface PlaceEdit {
  /** The timeline with the source registered (a source of the project that the timeline did not hold yet). */
  timeline: StudioTimeline;
  command: Extract<EditCommand, { type: "place" }>;
  clipIds: string[];
}

/** The edit that puts a source range on the given tracks at a frame; clips on several tracks are linked. */
export function placeEdit(
  timeline: StudioTimeline,
  source: TimelineSource,
  inFrame: number,
  outFrame: number,
  mode: PlaceMode,
  at: number,
  tracks: readonly TimelineTrack[],
  allocate: AllocateId,
): PlaceEdit {
  const linkId = tracks.length > 1 ? allocate("link") : null;
  const clips: TimelineClip[] = tracks.map((track) => ({
    clip_id: allocate("clip"),
    source_id: source.source_id,
    track_id: track.track_id,
    name: source.name,
    start_frame: 0,
    in_frame: inFrame,
    out_frame: outFrame,
    ...(linkId ? { linked_id: linkId } : {}),
    motion: defaultMotion(),
  }));
  const sources = [...new Map([...timeline.sources, source].map((item) => [item.source_id, item])).values()];
  return {
    timeline: { ...timeline, sources },
    command: { type: "place", clips, at, duration: outFrame - inFrame, mode },
    clipIds: clips.map((clip) => clip.clip_id),
  };
}

/** The track of a kind that pairs with a position in the other kind: the same position, else the last one there is. */
function paired(tracks: readonly TimelineTrack[], kind: TimelineTrack["kind"], index: number): TimelineTrack | undefined {
  const peers = tracks.filter((track) => track.kind === kind);
  return peers[Math.min(index, peers.length - 1)];
}

export interface DropTargets {
  /** The track under the pointer; null when the pointer is over no track (the patched tracks receive the drop). */
  trackId: string | null;
  /** The source-patched tracks: where the Source monitor's insert and overwrite land. */
  video: TimelineTrack | undefined;
  audio: TimelineTrack | undefined;
}

/**
 * The tracks a dropped source lands on. Its picture goes to the video track under the pointer and its sound to the
 * audio track at the same position (V2 with A2), and the other way round over an audio track; a source without the
 * part that fits the track under the pointer lands on the paired track of its own kind.
 */
export function dropTracks(timeline: StudioTimeline, source: TimelineSource, targets: DropTargets): TimelineResult<TimelineTrack[]> {
  const picture = source.kind !== "audio";
  const sound = source.kind === "audio" || source.has_audio === true;
  const hovered = timeline.tracks.find((track) => track.track_id === targets.trackId);
  let video = targets.video;
  let audio = targets.audio;
  if (hovered) {
    const index = timeline.tracks.filter((track) => track.kind === hovered.kind).findIndex((track) => track.track_id === hovered.track_id);
    video = hovered.kind === "video" ? hovered : paired(timeline.tracks, "video", index);
    audio = hovered.kind === "audio" ? hovered : paired(timeline.tracks, "audio", index);
  }
  const wanted = [...(picture ? [video] : []), ...(sound ? [audio] : [])];
  const tracks = wanted.flatMap((track) => (track ? [track] : []));
  if (tracks.length !== wanted.length) return { ok: false, error: t("請先新增對應的視訊軌或音訊軌") };
  return { ok: true, value: tracks };
}
