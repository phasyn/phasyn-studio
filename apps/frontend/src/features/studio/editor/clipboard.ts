// The editor's clipboard: a project-local snapshot of clips (copying never touches source media or the system
// clipboard) and the edits a paste makes from it. A paste lands at the playhead on the targeted tracks, as in Premiere:
// per kind, the lowest copied track goes to the lowest targeted track and the others keep their distance from it. It
// overwrites what lies there (the `place` command in overwrite mode) or, as a paste insert, moves what follows on the
// sync-locked tracks. Pasted clips keep their offsets and links and get new ids. Pure.
import type { StudioTimeline, TimelineClip, TimelineSource, TimelineTrack } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { activeTransition } from "../model/clipEffects";
import { localId } from "../model/project";
import { executeEdit } from "./commands";
import { clipEnd, selectClips, trackClips, type AllocateId, type TimelineResult } from "./model";
import type { PlaceMode } from "./sourceDrop";

/** Where a copied clip's track stood among the tracks of its kind (0 = V1 or A1). */
export interface ClipboardLayer {
  kind: TimelineTrack["kind"];
  index: number;
}

export interface ClipClipboard {
  clips: TimelineClip[];
  sources: TimelineSource[];
  duration: number;
  /** The copied clips' tracks, by track id. */
  layers: Record<string, ClipboardLayer>;
}

export function copyClips(timeline: StudioTimeline, ids: string[], linked: boolean): TimelineResult<ClipClipboard> {
  if (ids.length === 0 || ids.some((id) => !timeline.clips.some((clip) => clip.clip_id === id))) return { ok: false, error: t("請先選取片段") };
  const clips = selectClips(timeline, ids, linked);
  const selected = new Set(clips.map((clip) => clip.clip_id));
  for (const clip of clips) {
    if (!activeTransition(clip.effects)) continue;
    const ordered = trackClips(timeline, clip.track_id);
    const next = ordered[ordered.findIndex((item) => item.clip_id === clip.clip_id) + 1];
    if (!next || !selected.has(next.clip_id)) return { ok: false, error: t("複製含轉場片段時，請一併選取轉場兩側片段") };
  }
  const start = Math.min(...clips.map((clip) => clip.start_frame));
  const end = Math.max(...clips.map(clipEnd));
  const sources = timeline.sources.filter((source) => clips.some((clip) => clip.source_id === source.source_id));
  const layers: Record<string, ClipboardLayer> = {};
  for (const clip of clips) {
    const track = timeline.tracks.find((item) => item.track_id === clip.track_id);
    if (track) layers[track.track_id] = { kind: track.kind, index: timeline.tracks.filter((item) => item.kind === track.kind).indexOf(track) };
  }
  return { ok: true, value: { clips: structuredClone(clips).map((clip) => ({ ...clip, start_frame: clip.start_frame - start })), sources: structuredClone(sources), duration: end - start, layers } };
}

/**
 * The tracks a paste lands on, by copied track: per kind, the lowest copied track goes to the lowest targeted track of
 * that kind and the others keep their distance above it (A tracks: below it). Refused when no track of a kind the
 * clipboard needs is targeted, or when there are too few tracks for the copied layers.
 */
export function pasteTracks(timeline: StudioTimeline, clipboard: ClipClipboard, targets: ReadonlySet<string>): TimelineResult<Map<string, string>> {
  const out = new Map<string, string>();
  for (const kind of ["video", "audio"] as const) {
    const copied = Object.entries(clipboard.layers).filter(([, layer]) => layer.kind === kind);
    if (copied.length === 0) continue;
    const peers = timeline.tracks.filter((track) => track.kind === kind);
    const base = peers.findIndex((track) => targets.has(track.track_id));
    if (base < 0) return { ok: false, error: kind === "video" ? t("沒有選為目標的視訊軌；請在軌道標頭開啟目標") : t("沒有選為目標的音訊軌；請在軌道標頭開啟目標") };
    const lowest = Math.min(...copied.map(([, layer]) => layer.index));
    for (const [trackId, layer] of copied) {
      const track = peers[base + layer.index - lowest];
      if (!track) return { ok: false, error: kind === "video" ? t("目標軌道上方的視訊軌不夠；請先新增視訊軌") : t("目標軌道下方的音訊軌不夠；請先新增音訊軌") };
      out.set(trackId, track.track_id);
    }
  }
  return { ok: true, value: out };
}

/** The copied clips back on the tracks they were copied from (duplicating in place). */
export function ownTracks(clipboard: ClipClipboard): Map<string, string> {
  return new Map(Object.keys(clipboard.layers).map((trackId) => [trackId, trackId]));
}

export interface Pasted {
  timeline: StudioTimeline;
  /** The new clips (the selection after the paste). */
  selected: string[];
  /** The frame after the pasted material (where the playhead goes). */
  end: number;
}

/** Places the clipboard at a frame on the given tracks; links stay within the pasted clips, under new ids. */
export function pasteClips(
  timeline: StudioTimeline,
  clipboard: ClipClipboard,
  at: number,
  mode: PlaceMode,
  tracks: ReadonlyMap<string, string>,
  allocate: AllocateId = localId,
): TimelineResult<Pasted> {
  const links = new Map<string, string>();
  const clips: TimelineClip[] = [];
  for (const clip of structuredClone(clipboard.clips)) {
    const trackId = tracks.get(clip.track_id);
    if (!(trackId != null && trackId !== "")) return { ok: false, error: t("找不到要貼上的軌道") };
    const next = { ...clip, clip_id: allocate("clip"), track_id: trackId };
    if (clip.linked_id != null && clip.linked_id !== "") {
      let link = links.get(clip.linked_id);
      if (!(link != null && link !== "")) {
        link = allocate("link");
        links.set(clip.linked_id, link);
      }
      next.linked_id = link;
    }
    clips.push(next);
  }
  // Prefer a source resolved since copying over the older snapshot of that source.
  const sources = [...new Map([...clipboard.sources, ...timeline.sources].map((source) => [source.source_id, source])).values()];
  const result = executeEdit({ ...timeline, sources }, { type: "place", clips, mode, at, duration: clipboard.duration }, allocate);
  return result.ok ? { ok: true, value: { timeline: result.value, selected: clips.map((clip) => clip.clip_id), end: at + clipboard.duration } } : result;
}
