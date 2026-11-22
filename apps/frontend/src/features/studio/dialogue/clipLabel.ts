// A clip as the owner knows it: the shot's title (else the media's name) and where it sits on the sequence, written
// 「鏡頭名・時間碼」. Internal ids (v-media-…) never reach the panel.
import type { StudioProject, StudioTimeline, TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { clipEnabled } from "../editor/model";
import { formatTimecode } from "../model/frames";

export function sourceTitle(project: StudioProject, source: TimelineSource | undefined): string {
  const shotId = source?.shot_id ?? source?.candidate_origin?.shot_id;
  const shot = shotId === undefined ? undefined : project.shots.find((item) => item.shot_id === shotId);
  const title = shot?.title.trim() ?? "";
  if (title !== "") return title;
  const name = source?.name.trim() ?? "";
  return name !== "" ? name : t("未命名片段");
}

export function clipLabel(project: StudioProject, timeline: StudioTimeline, clip: TimelineClip, fps: number): string {
  const source = timeline.sources.find((item) => item.source_id === clip.source_id);
  return t("{name}・{timecode}", { name: sourceTitle(project, source), timecode: formatTimecode(clip.start_frame, fps) });
}

/** The clip's media when it carries sound the transcription can hear. */
export function audibleSource(timeline: StudioTimeline, clip: TimelineClip): TimelineSource | null {
  const source = timeline.sources.find((item) => item.source_id === clip.source_id);
  if (!source?.file || !clipEnabled(clip)) return null;
  return source.kind === "audio" || (source.kind === "video" && source.has_audio) ? source : null;
}
