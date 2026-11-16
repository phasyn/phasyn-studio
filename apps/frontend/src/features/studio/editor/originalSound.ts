// The timeline clips that play an original video's own sound: an audio clip that is heard in the export (enabled, not
// muted, on an audible track) whose source is the library video a face swap was made from or a video a shot uses as its
// reference. Its lines belong to the original characters, so the export dialog warns that mouths and voices will not
// match the new ones. Pure.
import type { StudioProject, StudioTimeline } from "@/api/generated/contracts";
import { findSwapJob } from "../swap/job";

/** Library ids and file ids of the videos the project remakes (the swap source and every shot's reference video). */
function originalVideos(project: StudioProject): { items: Set<string>; files: Set<string> } {
  const library = new Map((project.library ?? []).map((item) => [item.item_id, item]));
  const ids = new Set<string>();
  const swapSource = findSwapJob(project)?.source.item_id;
  if (swapSource) ids.add(swapSource);
  for (const shot of project.shots) for (const ref of shot.references ?? []) if (ref.kind === "video") ids.add(ref.item_id);
  const files = new Set<string>();
  for (const id of ids) {
    const item = library.get(id);
    if (item?.kind === "video") files.add(item.file.file_id);
  }
  return { items: ids, files };
}

/** Names of the audible audio clips that play an original video's sound, in timeline order (each name once). */
export function originalSoundClips(project: StudioProject, timeline: StudioTimeline): string[] {
  const { items, files } = originalVideos(project);
  if (items.size === 0) return [];
  const audioTracks = timeline.tracks.filter((track) => track.kind === "audio");
  const solo = audioTracks.some((track) => track.solo);
  const audible = new Set(audioTracks.filter((track) => !track.muted && (!solo || track.solo)).map((track) => track.track_id));
  const sources = new Map(timeline.sources.map((source) => [source.source_id, source]));
  const names = timeline.clips
    .filter((clip) => audible.has(clip.track_id) && clip.enabled !== false && clip.effects?.mute !== true)
    .filter((clip) => {
      const source = sources.get(clip.source_id);
      if (!source || source.kind !== "video" || !source.has_audio) return false;
      return (source.library_id !== undefined && items.has(source.library_id)) || (source.file !== null && files.has(source.file.file_id));
    })
    .sort((a, b) => a.start_frame - b.start_frame)
    .map((clip) => clip.name);
  return [...new Set(names)];
}
