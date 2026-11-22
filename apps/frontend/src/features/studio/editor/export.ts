import { isNonzeroNumber } from "@/lib/json";
// The one sequence export of a project: its timeline document becomes a media.concat run. The export dialog, the
// Render workspace and the character-swap panel all send this request.
import type { ComponentDescriptor, FileRef, MediaClipTitle, StudioProject, StudioTimeline, TimelineCaption, TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { uploadBlob } from "@/api/files";
import type { RunRequestBody } from "@/api/types";
import { t } from "@/i18n";
import { activeTransition, titleKey, titleLayerState } from "../model/clipEffects";
import { renderTitlePng } from "../model/titleLayout";
import { exportGeometry } from "../model/project";
import type { ExportOptions, ExportTarget } from "../model/pipelines";
import { isAdjustment, isGenerated } from "./adjustment";
import { clipEnabled, timelineDuration, trackClips } from "./model";
import { projectTimeline } from "./sources";
import { timelineTitleProblem } from "./validation";

export function captionKey(text: string, position: string, size: string, width: number, height: number): string {
  return JSON.stringify([text, position, size, width, height]);
}

type TextRaster = Pick<MediaClipTitle, "text" | "position" | "size" | "style">;
// Immutable snapshot identity limits reuse to the same edit. Failed jobs are retryable.
// No prepared snapshot is written back over a project that may have changed during upload.
const preparedImages = new WeakMap<StudioTimeline, Map<string, Promise<FileRef>>>();

function rasterCache(timeline: StudioTimeline, width: number, height: number): Map<string, Promise<FileRef>> {
  let cache = preparedImages.get(timeline);
  if (!cache) {
    cache = new Map();
    preparedImages.set(timeline, cache);
  }
  for (const clip of timeline.clips) {
    const title = clip.effects?.title;
    if (title?.image && titleLayerState(title, width, height) === "fresh") cache.set(titleKey(title, width, height), Promise.resolve(title.image));
  }
  for (const caption of timeline.captions) {
    const fresh = caption.image && caption.image_key === captionKey(caption.text, caption.position, caption.size, width, height);
    if ((fresh === true) && caption.image) cache.set(titleKey(caption, width, height), Promise.resolve(caption.image));
  }
  return cache;
}

function prepareRaster(text: TextRaster, width: number, height: number, cache: Map<string, Promise<FileRef>>): Promise<FileRef> {
  const key = titleKey(text, width, height);
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = renderTitlePng(text, width, height).then((png) => uploadBlob(png, "image/png"));
  cache.set(key, pending);
  void pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

/** Generated text remains editable in the saved project; only the export snapshot is rasterized. */
export function rasterizeTextSources(timeline: StudioTimeline, width: number, height: number): StudioTimeline {
  const used = new Set(timeline.clips.map((clip) => clip.source_id));
  const sources: TimelineSource[] = timeline.sources.filter((source) => used.has(source.source_id) && source.kind !== "text");
  const ids = new Set(timeline.sources.map((source) => source.source_id));
  let serial = 0;
  const clips = timeline.clips.map((clip) => {
    const source = timeline.sources.find((item) => item.source_id === clip.source_id);
    if (source?.kind !== "text") return clip;
    const title = clip.effects?.title;
    if (!title?.image || titleLayerState(title, width, height) !== "fresh") throw new Error(t("「{name}」的標題圖層尚未完成", { name: clip.name }));
    let sourceId = `text-render.${String(serial++)}`;
    while (ids.has(sourceId)) sourceId = `text-render.${String(serial++)}`;
    ids.add(sourceId);
    sources.push({ source_id: sourceId, name: clip.name, kind: "image", file: title.image, width, height, duration_frames: source.duration_frames, has_audio: false });
    const { title: _title, ...effects } = clip.effects ?? {};
    return { ...clip, source_id: sourceId, effects };
  });
  return { ...timeline, clips, sources };
}

/**
 * The export snapshot of the project's timeline: every title and caption rasterized (linked titles and identical
 * captions share one upload) and text layers turned into image sources. The project itself is not changed.
 */
export async function prepareTimelineExport(project: StudioProject): Promise<StudioProject> {
  const result = projectTimeline(project);
  if (!result.ok) throw new Error(result.error);
  const timeline = result.value;
  const { width, height } = exportGeometry(project);
  // Keyed by the document, so a second export of the same edit reuses the uploads
  const cache = rasterCache(timeline, width, height);
  const clips: TimelineClip[] = [];
  for (const clip of timeline.clips) {
    const title = clip.effects?.title;
    if (!title || titleLayerState(title, width, height) === "fresh") {
      clips.push(clip);
      continue;
    }
    const image = await prepareRaster(title, width, height, cache);
    clips.push({ ...clip, effects: { ...clip.effects, title: { ...title, image, image_key: titleKey(title, width, height) } } });
  }
  const captions: TimelineCaption[] = [];
  for (const caption of timeline.captions) {
    const key = captionKey(caption.text, caption.position, caption.size, width, height);
    if (caption.image && caption.image_key === key) {
      captions.push(caption);
      continue;
    }
    const image = await prepareRaster(caption, width, height, cache);
    captions.push({ ...caption, image, image_key: key });
  }
  const prepared = { ...timeline, clips, captions };
  const titleProblem = timelineTitleProblem(prepared, width, height);
  if (titleProblem != null && titleProblem !== "") throw new Error(titleProblem);
  return { ...project, timeline: rasterizeTextSources(prepared, width, height) };
}

/**
 * The document as the export component reads it: a version 1 timeline. A switched-off clip is left out (a transition
 * into it becomes a cut), and what only the editor uses stays behind: playback proxies, a waiting take, the
 * Controller's bookkeeping of placed shots and migration notes, and where each transition's cut is (the export draws
 * the overlap; the cut only tells the editor what to give back). The Controller's own export makes the same document.
 */
export function exportSnapshot(timeline: StudioTimeline): StudioTimeline {
  const { placed_shot_ids: _placed, migration_notes: _notes, ...document } = timeline;
  const off = new Set(timeline.clips.filter((clip) => !clipEnabled(clip)).map((clip) => clip.clip_id));
  const cut = new Set<string>();
  for (const track of timeline.tracks) {
    const ordered = trackClips(timeline, track.track_id);
    ordered.forEach((clip, index) => {
      const next = ordered[index + 1];
      if (next && off.has(next.clip_id) && activeTransition(clip.effects)) cut.add(clip.clip_id);
    });
  }
  const clips = timeline.clips
    .filter((clip) => !off.has(clip.clip_id))
    .map(({ enabled: _enabled, ...clip }): TimelineClip => {
      const transition = activeTransition(clip.effects);
      if (!clip.effects || !transition) return clip;
      if (cut.has(clip.clip_id)) {
        const { transition_out: _transition, ...effects } = clip.effects;
        return { ...clip, effects };
      }
      if (!transition.cut) return clip;
      const { cut: _cut, ...overlap } = transition;
      return { ...clip, effects: { ...clip.effects, transition_out: overlap } };
    });
  const used = new Set(clips.map((clip) => clip.source_id));
  const sources = timeline.sources
    .filter((source) => used.has(source.source_id))
    .map(({ proxy: _proxy, proxy_run_id: _run, proxy_error: _error, proxy_source_sha256: _sha, pending_take_id: _pending, ...source }): TimelineSource => source);
  return { ...document, version: 1, clips, sources };
}

/** The export component a run is sent to, with what its descriptor says it can do (facts.timeline_export). */
export function exportTarget(component: Pick<ComponentDescriptor, "node_id" | "component_id" | "facts">): ExportTarget {
  const facts = component.facts?.["timeline_export"];
  const adjustment = typeof facts === "object" && facts !== null && "adjustment" in facts && facts.adjustment === true;
  return { node_id: component.node_id, component_id: component.component_id, adjustment };
}

export function timelineRequest(
  timeline: StudioTimeline,
  geometry: { width: number; height: number; fit?: "contain" | "cover" },
  target: ExportTarget,
  label: string,
  options: ExportOptions = {},
): RunRequestBody {
  const range = options.range === "work_area" && timeline.work_area ? { render_range: timeline.work_area } : {};
  return {
    pipeline: {
      pipeline_id: "studio-export",
      label,
      inputs: [{ name: "sequence", type_id: "media.sequence.v1", required: true, transport: "inline", description: t("多軌剪輯序列") }],
      steps: [
        {
          step_id: "concat",
          node_id: target.node_id,
          component_id: target.component_id,
          inputs: { sequence: { from_input: "sequence" } },
          parameters: {
            crf: options.crf ?? 18,
            preset: options.preset ?? "medium",
            audio_bitrate: options.audioBitrate ?? 192000,
            ...(isNonzeroNumber(options.loudnessLufs) ? { loudness_lufs: options.loudnessLufs } : {}),
          },
        },
      ],
      outputs: { final: { from_step: "concat", output: "asset" } },
    },
    inputs: { sequence: { type_id: "media.sequence.v1", value: { clips: [], timeline: exportSnapshot(timeline), ...range, ...geometry, fps: timeline.fps } } },
    label,
    ...(options.purpose ? { purpose: options.purpose } : {}),
  };
}

export interface SequenceExport {
  /** The document that is exported; null when the project's timeline cannot be built. */
  timeline: StudioTimeline | null;
  /** The run request; null while a problem blocks the export or no export component was given. */
  body: RunRequestBody | null;
  /** What blocks the export. */
  problems: string[];
  /** Frames the export will have (the marked range when options.range is "work_area"). */
  totalFrames: number;
  clips: number;
  /** The shots whose takes the sequence uses (recorded with the export). */
  shotIds: string[];
  /** Media left out as silence because it is not rendered yet (options.unrendered "gap"), by name. */
  gaps: string[];
}

/** What exporting the project's sequence means right now: the document, what blocks it and the request to send. */
export function sequenceExport(project: StudioProject, target: ExportTarget | null, options: ExportOptions = {}): SequenceExport {
  const result = projectTimeline(project);
  if (!result.ok) return { timeline: null, body: null, problems: [result.error], totalFrames: 0, clips: 0, shotIds: [], gaps: [] };
  const problems: string[] = [];
  const fullFrames = timelineDuration(result.value);
  if (fullFrames === 0) problems.push(t("時間軸沒有可匯出的內容"));
  // A switched-off clip is not exported, so its media need not exist
  const enabled = new Set(result.value.clips.filter(clipEnabled).map((clip) => clip.source_id));
  const unrendered = result.value.sources.filter((source) => enabled.has(source.source_id) && !isGenerated(source) && !source.file);
  const gap = options.unrendered === "gap";
  const missing = new Set(unrendered.map((source) => source.source_id));
  // As a gap, an unrendered shot's clips leave the request (its time stays silent); otherwise it blocks it
  const timeline = gap && missing.size > 0 ? { ...result.value, clips: result.value.clips.filter((clip) => !missing.has(clip.source_id)), sources: result.value.sources.filter((source) => !missing.has(source.source_id)) } : result.value;
  if (!gap) for (const source of unrendered) problems.push(t("「{name}」尚未完成渲染", { name: source.name }));
  if (gap && timeline.clips.filter(clipEnabled).length === 0 && fullFrames > 0) problems.push(t("還沒有任何已渲染的鏡頭可以混音"));
  const used = new Set(timeline.clips.filter(clipEnabled).map((clip) => clip.source_id));
  // An export component that predates adjustment layers would refuse the whole document (even a switched-off layer)
  if (target && target.adjustment !== true && timeline.clips.some((clip) => isAdjustment(timeline, clip))) {
    problems.push(t("匯出元件還不能合成調整圖層；請更新 Node 並重啟後再匯出，或先移除調整圖層"));
  }
  const area = options.range === "work_area" ? timeline.work_area : undefined;
  if (options.range === "work_area" && (!area || area.start_frame >= area.end_frame || area.end_frame > fullFrames)) {
    problems.push(t("請先設定有效的序列入出點；匯出範圍不得超過序列長度"));
  }
  const label = t("Studio：{title}・序列匯出", { title: project.title });
  const body = target && problems.length === 0 ? timelineRequest(timeline, exportGeometry(project), target, label, options) : null;
  const shotIds = [...new Set(timeline.sources.flatMap((source) => (used.has(source.source_id) && (source.shot_id != null && source.shot_id !== "") ? [source.shot_id] : [])))];
  const gaps = gap ? unrendered.map((source) => source.name) : [];
  return { timeline, body, problems, totalFrames: area ? area.end_frame - area.start_frame : fullFrames, clips: timeline.clips.length, shotIds, gaps };
}
