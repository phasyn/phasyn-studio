// What 「從片段辨識台詞」 works on, and the requests it sends: the selected clip when it has sound, else the clips with
// sound inside the sequence In/Out (or the whole sequence). Clips that play the same media share one run, whose
// transcript is then imported for each of them.
import type { StudioProject, StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import type { RunRequestBody } from "@/api/types";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";
import { clipEnd } from "../editor/model";
import { audibleSource, clipLabel } from "./clipLabel";
import type { TranscribeRoute } from "./dialogueRoutes";

/** At most this many media files per click: each is one transcription run. */
export const MAX_TRANSCRIBE_SOURCES = 12;

export interface TranscribeTarget {
  scope: "clip" | "range" | "sequence";
  clips: TimelineClip[];
}

export function transcribeTarget(timeline: StudioTimeline, selected: TimelineClip | null): TranscribeTarget {
  if (selected && audibleSource(timeline, selected)) return { scope: "clip", clips: [selected] };
  const area = timeline.work_area;
  const audible = timeline.clips.filter((clip) => audibleSource(timeline, clip) !== null).sort((a, b) => a.start_frame - b.start_frame);
  if (area) return { scope: "range", clips: audible.filter((clip) => clip.start_frame < area.end_frame && clipEnd(clip) > area.start_frame) };
  return { scope: "sequence", clips: audible };
}

export function targetText(project: StudioProject, timeline: StudioTimeline, target: TranscribeTarget, fps: number): string {
  const first = target.clips[0];
  if (!first) return target.scope === "range" ? t("序列入出點之間沒有帶聲音的片段") : t("時間軸上沒有帶聲音的片段");
  if (target.scope === "clip") return t("辨識「{clip}」的台詞", { clip: clipLabel(project, timeline, first, fps) });
  if (target.scope === "range") return t("辨識序列入出點之間 {count} 個片段的台詞", { count: target.clips.length });
  return t("辨識整個序列 {count} 個片段的台詞（可先選取片段，或標記入出點縮小範圍）", { count: target.clips.length });
}

export interface TranscribeRequest {
  body: RunRequestBody;
  clipIds: string[];
  label: string;
}

/** One request per distinct media file; clips whose media the route cannot take are left out. */
export function transcribeRequests(project: StudioProject, timeline: StudioTimeline, target: TranscribeTarget, route: TranscribeRoute, fps: number): TranscribeRequest[] {
  const groups = new Map<string, TimelineClip[]>();
  for (const clip of target.clips) {
    const file = audibleSource(timeline, clip)?.file;
    if (!file) continue;
    groups.set(file.sha256, [...(groups.get(file.sha256) ?? []), clip]);
  }
  return [...groups.values()].slice(0, MAX_TRANSCRIBE_SOURCES).flatMap((clips) => {
    const first = clips[0];
    const source = first ? audibleSource(timeline, first) : null;
    if (!first || !source?.file) return [];
    const family = source.file.media_type.startsWith("audio/") || source.kind === "audio" ? "audio" : "video";
    const input = route.inputs[family];
    if (input === null) return [];
    const label = clipLabel(project, timeline, first, fps);
    const clipIds = clips.map((clip) => clip.clip_id);
    return [{
      clipIds, label,
      body: {
        pipeline: withTraditionalChinese(route),
        inputs: { [input]: { type_id: `media.${family}.v1`, file: source.file } },
        label: t("{project}・辨識台詞・{clip}", { project: project.title, clip: label }),
        // A JSON note naming the project lists the run with the project's runs (「從過去結果選」)
        origin: { note: JSON.stringify({ type: "studio.dialogue.v1", project_id: project.project_id, kind: "transcribe", clip_ids: clipIds }) },
      },
    }];
  });
}

/**
 * The Studio writes Traditional Chinese: a transcriber that can fix the script (chinese_script) is asked for it, so a
 * Chinese clip does not come back once in Traditional and once in Simplified characters. A transcriber without that
 * parameter (an older runtime would refuse it) gets the pipeline as it is.
 */
export function withTraditionalChinese(route: TranscribeRoute): TranscribeRoute["pipeline"] {
  const schema = route.entry.descriptor.settings.parameters_schema;
  const properties = isRecord(schema) ? schema["properties"] : null;
  if (!isRecord(properties) || !("chinese_script" in properties)) return route.pipeline;
  return {
    ...route.pipeline,
    steps: route.pipeline.steps.map((step) =>
      step.node_id === route.entry.descriptor.node_id && step.component_id === route.entry.descriptor.component_id
        ? { ...step, parameters: { chinese_script: "traditional", ...step.parameters } }
        : step,
    ),
  };
}
