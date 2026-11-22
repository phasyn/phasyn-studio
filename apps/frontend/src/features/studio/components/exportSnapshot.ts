import { matchesReply } from "@/api/http";
import { timelineDuration } from "../editor/model";
import type { RunRequestBody } from "@/api/types";
import { isRecord, stableStringify } from "@/lib/json";

const SNAPSHOT_TYPE = "studio.timeline-export.v1";

/** Identify the actual export inputs and native options, independent of translated labels and object key order. */
export function exportSignature(body: RunRequestBody | null): string | null {
  if (body?.pipeline.pipeline_id !== "studio-export" || body.pipeline.steps.length !== 1) return null;
  const sequence = body.inputs["sequence"];
  const step = body.pipeline.steps[0];
  if (!step || !sequence || !("value" in sequence) || !isRecord(sequence.value)) return null;
  // The Controller may send v2 while Studio down-converts to v1. The media exporter
  // uses the same composition model once validated. Compare every actual media field.
  const timeline = sequence.value["timeline"];
  if (!isRecord(timeline) || (timeline["version"] !== 1 && timeline["version"] !== 2)) return null;
  const content = { ...sequence.value, timeline: { ...timeline, version: 1 } };
  return stableStringify({ sequence: content, node: step.node_id, component: step.component_id, options: step.parameters });
}

export async function exportDigest(signature: string | null): Promise<string | null> {
  if (signature === null) return null;
  try {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export function exportNote(projectId: string, revision: number, fingerprint: string | null): string {
  return JSON.stringify({ type: SNAPSHOT_TYPE, project_id: projectId, revision, snapshot_sha256: fingerprint });
}

export function readExportNote(note: string | undefined, projectId: string): { revision: number; digest: string | null } | null {
  if (note === undefined || note === "") return null;
  try {
    const parsed: unknown = JSON.parse(note);
    if (!isRecord(parsed) || parsed["type"] !== SNAPSHOT_TYPE || parsed["project_id"] !== projectId || typeof parsed["revision"] !== "number") return null;
    const digest = parsed["snapshot_sha256"];
    return { revision: parsed["revision"], digest: typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) ? digest : null };
  } catch {
    return null;
  }
}

/** Fingerprint the inputs read by the final AAC mixer, including silence up to the visual tail. */
export function audioMixSignature(body: RunRequestBody | null, definitions: Record<string, unknown>): string | null {
  const input = body?.inputs["sequence"];
  const step = body?.pipeline.steps[0];
  if (!step || !input || !("value" in input) || !isRecord(input.value)) return null;
  const sequence = input.value;
  const timeline = sequence["timeline"];
  if (!matchesReply(timeline, "StudioTimeline", definitions)) return null;
  const tracks = timeline.tracks.filter(track => track.kind === "audio");
  const audioTracks = new Set(tracks.map(track => track.track_id));
  const clips = timeline.clips.filter(clip => audioTracks.has(clip.track_id));
  const sources = new Map(timeline.sources.map(source => [source.source_id, source]));
  return stableStringify({
    version: 1, renderer: [step.node_id, step.component_id], fps: timeline.fps,
    total: timelineDuration(timeline), range: sequence["render_range"], master: timeline.master_gain_db,
    bitrate: step.parameters["audio_bitrate"], loudness: step.parameters["loudness_lufs"],
    tracks: tracks.map(({ track_id, muted, solo, gain_db, pan }) => [track_id, muted, solo, gain_db, pan]),
    clips: clips.map(clip => {
      const source = sources.get(clip.source_id);
      const fx = clip.effects;
      const { gain_db, pan, keyframes } = clip.motion;
      return {
        track: clip.track_id, start: clip.start_frame, first: clip.in_frame, last: clip.out_frame,
        window: clip.output_window, enabled: clip.enabled !== false, file: source?.file?.sha256, hasAudio: source?.has_audio,
        gain_db, pan, gainKeys: keyframes.gain_db, panKeys: keyframes.pan,
        volume: fx?.volume_db, mute: fx?.mute, speed: fx?.speed_percent, hold: fx?.hold,
        fadeIn: fx?.fade?.audio_in, fadeOut: fx?.fade?.audio_out, transition: fx?.transition_out,
      };
    }),
  });
}
