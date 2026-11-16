// The run request that makes a playback proxy of a video source: the source alone on a timeline of its own, scaled
// down to fit 960×540 (never enlarged), at the sequence's frame rate and for the source's whole length. A proxy is a
// new verified rendition, never a replacement of the bound original: an export always reads the original media.
import type { StudioTimeline, TimelineSource } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { ExportTarget } from "../model/pipelines";
import { timelineRequest } from "./export";
import { defaultMotion, newTrack } from "./model";

const PROXY_MAX_WIDTH = 960;
const PROXY_MAX_HEIGHT = 540;

/** A scaled side as an even number of pixels (the encoder needs even sides), at least 2. */
function evenSide(side: number, scale: number): number {
  return Math.max(2, Math.floor((side * scale) / 2) * 2);
}

export function proxyRequest(timeline: StudioTimeline, source: TimelineSource, target: ExportTarget) {
  if (source.kind !== "video" || !source.file || source.width < 2 || source.height < 2) throw new Error(t("代理媒體需要已完成且尺寸已知的原始影片"));
  const scale = Math.min(1, PROXY_MAX_WIDTH / source.width, PROXY_MAX_HEIGHT / source.height);
  const width = evenSide(source.width, scale);
  const height = evenSide(source.height, scale);
  const tracks = [newTrack("video", "video", "V1"), ...(source.has_audio ? [newTrack("audio", "audio", "A1")] : [])];
  const edit: StudioTimeline = {
    version: 1,
    fps: timeline.fps,
    sources: [source],
    tracks,
    captions: [],
    markers: [],
    master_gain_db: 0,
    clips: tracks.map((track) => ({
      clip_id: track.track_id,
      source_id: source.source_id,
      track_id: track.track_id,
      name: source.name,
      start_frame: 0,
      in_frame: 0,
      out_frame: source.duration_frames,
      motion: defaultMotion(),
    })),
  };
  return timelineRequest(edit, { width, height, fit: "contain" }, target, t("建立代理：{name}", { name: source.name }), { crf: 28, preset: "veryfast", audioBitrate: 128000, purpose: "proxy" });
}
