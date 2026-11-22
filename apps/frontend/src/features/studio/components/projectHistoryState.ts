import type { Origin, StudioProject, StudioTimeline, StudioWorkOrigin } from "@/api/generated/contracts";
import { matchesReply } from "@/api/http";
import { asAsset, asTypedValue, type WireRun } from "@/api/types";
import { t } from "@/i18n";
import { isRecord, valuesEqual } from "@/lib/json";
import { exportSnapshot } from "../editor/export";
import { clipEnd, sourceFrameAtTimeline } from "../editor/model";
import { exportGeometry } from "../model/project";
import { DEFAULT_SCENE } from "../previs/composition";
import { audioMixSignature } from "./exportSnapshot";

type Kind = StudioWorkOrigin["operation_kind"];
export const workKinds: Record<Kind, string> = {
  render: t("渲染"), draft: t("批次草稿"), draft_branch: t("精修分支"), mask: t("遮罩"),
  audio_mix: t("純音訊混音試聽"), animatic: t("預演"), seam: t("接縫預覽"),
  export: t("匯出"), reference: t("參考素材"), retake: t("局部重製"),
};

function noteOf(origin?: Origin): Record<string, unknown> {
  if (origin?.note === undefined || origin.note.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(origin.note);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function workKind(job: { studio_work?: StudioWorkOrigin; request: { origin?: Origin } }): Kind | undefined {
  return (job.studio_work ?? job.request.origin?.studio_work)?.operation_kind;
}

const shotChanged = () => t("來源鏡頭已移除");
const clipChanged = () => t("來源片段或所選區間已變更");
const mediaChanged = () => t("綁定的素材內容已變更");

function digestChanged(value: unknown, digest: unknown) {
  return typeof digest === "string" && value !== digest;
}

function contextSamples(timeline: StudioTimeline, track: string, frame: number) {
  return timeline.clips.filter(c => c.track_id === track && c.start_frame <= frame && frame < clipEnd(c)).map(c => {
    const source = timeline.sources.find(s => s.source_id === c.source_id);
    return [source?.file?.sha256 ?? source?.source_id, sourceFrameAtTimeline(c, frame)];
  });
}

function seamReason(command: unknown, timeline: StudioTimeline, project: StudioProject, captured: StudioTimeline | null, snapshot: StudioTimeline) {
  if (!isRecord(command) || command["op"] !== "range_candidate") return null;
  const { track_id: track, start_frame: start, end_frame: end } = command;
  if (typeof track !== "string" || typeof start !== "number" || typeof end !== "number") return null;
  if (!timeline.tracks.some(row => row.track_id === track)) return clipChanged();
  const clips = timeline.clips.filter(clip => clip.track_id === track).sort((a,b) => a.start_frame - b.start_frame);
  const covered = clips.filter(clip => clip.start_frame < end && clipEnd(clip) > start);
  if (command["mode"] === "fill_gap") {
    if (covered.length > 0 || !clips.some(clip => clipEnd(clip) === start) || !clips.some(clip => clip.start_frame === end)) return clipChanged();
  } else if (command["mode"] === "replace_range") {
    let cursor = start;
    for (const clip of covered) {
      if (clip.start_frame > cursor) break;
      cursor = Math.max(cursor, clipEnd(clip));
    }
    if (cursor < end) return clipChanged();
  }
  if (captured && [start - 1, end].some(frame => frame >= 0 &&
        !valuesEqual(contextSamples(captured, track, frame), contextSamples(snapshot, track, frame)))) return clipChanged();
  const digest = command["expected_source_sha256"];
  if (typeof command["library_id"] === "string" && digestChanged(project.library?.find(i => i.item_id === command["library_id"])?.file.sha256, digest)) return mediaChanged();
  if (typeof command["source_id"] === "string" && digestChanged(timeline.sources.find(i => i.source_id === command["source_id"])?.file?.sha256, digest)) return mediaChanged();
  if (typeof command["shot_id"] === "string" && typeof command["take_id"] === "string" && digestChanged(
    project.shots.find(i => i.shot_id === command["shot_id"])?.takes.find(i => i.take_id === command["take_id"])?.asset?.file.sha256, digest)) return mediaChanged();
  return null;
}

function animaticReason(job: WireRun, project: StudioProject, shotId: unknown, end: unknown) {
  if (typeof shotId !== "string") return null;
  const shot = project.shots.find(s => s.shot_id === shotId);
  if (!shot) return shotChanged();
  if (typeof end === "number" && end > shot.frames) return clipChanged();
  for (const value of Object.values(job.outputs)) {
    const out = asTypedValue(value);
    const asset = out?.type_id === "media.asset.v1" && "value" in out ? asAsset(out.value) : null;
    const facts = asset?.actual_settings["animatic"];
    if (!asset || !isRecord(facts) || facts["project_id"] !== project.project_id || facts["shot_id"] !== shotId) continue;
    if (asset.width !== project.format.width || asset.height !== project.format.height ||
        (asset.fps !== null && asset.fps.num * project.format.fps.den !== project.format.fps.num * asset.fps.den) ||
        (typeof facts["projection"] === "string" && facts["projection"] !== (shot.previs ?? DEFAULT_SCENE).projection)) return t("預演畫面設定已變更");
    const layers = facts["layer_sources"];
    const images: unknown[] = Array.isArray(layers) ? layers : [];
    const sources = [...images, facts["audio"]];
    if (sources.some(s => isRecord(s) && typeof s["item_id"] === "string" && digestChanged(project.library?.find(i => i.item_id === s["item_id"])?.file.sha256, s["sha256"]))) return mediaChanged();
  }
  return null;
}

// Compare only fields consumed by the rendered sequence. UI labels, project revisions and proxy locations have no bearing on playback.
function renderedTimeline(timeline: StudioTimeline) {
  const used = new Set(timeline.clips.map(clip => clip.track_id));
  const tracks = timeline.tracks.filter(track => used.has(track.track_id));
  return {
    fps: timeline.fps, master: timeline.master_gain_db, captions: timeline.captions,
    tracks: tracks.map(t => [t.track_id, t.kind, t.muted, t.solo, t.gain_db, t.pan]),
    soloKinds: [...new Set(timeline.tracks.filter(t => t.solo && tracks.some(usedTrack => usedTrack.kind === t.kind)).map(t => t.kind))].sort(),
    clips: timeline.clips.map(c => [c.track_id, c.source_id, c.start_frame, c.in_frame, c.out_frame, c.output_window, c.motion, c.effects, c.effect_stack, c.mask, c.blend_mode]),
    sources: timeline.sources.map(s => [s.source_id, s.kind, s.file?.sha256, s.has_audio, s.width, s.height]),
  };
}

export function workDependencies(project: StudioProject, timeline: StudioTimeline, definitions: Record<string, unknown>) {
  const snapshot = exportSnapshot(timeline);
  const rendered = renderedTimeline(snapshot);
  const geometry = exportGeometry(project);
  return (job: WireRun): string | null => {
    const request = job.request;
    const kind = workKind(job);
    const work = job.studio_work ?? request.origin?.studio_work;
    const note = noteOf(request.origin);
    if (kind === "animatic") return animaticReason(job, project, work?.shot_id ?? note["shot_id"], note["end"]);
    if (kind === "seam") {
      const sequence = request.inputs["sequence"];
      const value = sequence && "value" in sequence ? sequence.value : null;
      const saved = isRecord(value) ? value["timeline"] : null;
      return seamReason(note["command"], timeline, project, matchesReply(saved, "StudioTimeline", definitions) ? saved : null, snapshot);
    }
    if (kind === "retake" && typeof note["clip_id"] === "string") {
      const clip = timeline.clips.find(c => c.clip_id === note["clip_id"]);
      if (!clip || clip.track_id !== note["track_id"] || clip.source_id !== note["source_id"]) return clipChanged();
      const range = note["sequence_range"];
      if (Array.isArray(range) && typeof range[0] === "number" && typeof range[1] === "number" &&
          (clip.start_frame > range[0] || clipEnd(clip) < range[1])) return clipChanged();
      if (digestChanged(timeline.sources.find(s => s.source_id === clip.source_id)?.file?.sha256, work?.source_digest ?? note["source_sha256"])) return mediaChanged();
    }
    if (work?.shot_id !== undefined && !project.shots.some(s => s.shot_id === work.shot_id) && !(project.image_shots ?? []).some(s => s.image_shot_id === work.shot_id)) return shotChanged();
    if (kind !== "audio_mix" && kind !== "export") return null;
    const typed = request.inputs["sequence"];
    if (typed?.type_id !== "media.sequence.v1" || !("value" in typed) || !isRecord(typed.value)) return null;
    const sequence = typed.value, saved = sequence["timeline"];
    if (!matchesReply(saved, "StudioTimeline", definitions)) return null;
    const range = sequence["render_range"];
    if (isRecord(range) && !valuesEqual(range, timeline.work_area)) return t("匯出區間已變更");
    if (kind === "audio_mix") {
      const current = { ...request, inputs: { ...request.inputs, sequence: { ...typed, value: { ...sequence, timeline: snapshot } } } };
      const was = audioMixSignature(request, definitions), now = audioMixSignature(current, definitions);
      return was !== null && now !== null && was !== now ? t("混音內容已變更") : null;
    }
    if (sequence["width"] !== geometry.width || sequence["height"] !== geometry.height ||
      (sequence["fit"] ?? "contain") !== (geometry.fit ?? "contain") || !valuesEqual(renderedTimeline(saved), rendered)) return t("匯出的剪輯內容已變更");
    return null;
  };
}
