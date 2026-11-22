// Domain kernel of h3.materials.v1 (MiniMax H3 ref2va reference materials), shared by Video Studio, the inference
// page and run views. Rules follow the H3 adapter (phasyn_h3.recipe.adapter TASK_POLICIES["ref2va"] and its material
// diagnostics); the server and the component stay authoritative and reject invalid requests. Pure.
import type { FileRef } from "@/api/generated/contracts";
import { t } from "@/i18n";

export type MaterialKind = "image" | "video" | "audio";
export type MaterialRole = "reference_image" | "reference_video" | "reference_audio";

/** One item of the h3.materials.v1 value as sent in a run request. */
export interface MaterialEntry {
  file: FileRef;
  role: MaterialRole;
  start_seconds?: number;
  end_seconds?: number;
  use_embedded_audio?: boolean;
  /**
   * Reference videos only, sent only when true: after end_seconds the runtime repeats the last frame (and pads the sound
   * with silence) up to the generated length, so the model never draws what comes after the window early.
   */
  hold_last_frame?: boolean;
}

export const MATERIAL_ROLES: readonly MaterialRole[] = ["reference_image", "reference_video", "reference_audio"];
export const ROLE_KIND: Readonly<Record<MaterialRole, MaterialKind>> = { reference_image: "image", reference_video: "video", reference_audio: "audio" };
export const KIND_ROLE: Readonly<Record<MaterialKind, MaterialRole>> = { image: "reference_image", video: "reference_video", audio: "reference_audio" };
export const ROLE_LABEL: Readonly<Record<MaterialRole, string>> = {
  reference_image: t("參考圖片"),
  reference_video: t("參考影片"),
  reference_audio: t("參考聲音"),
};

/** Official ref2va limits: at most 9 images, 3 videos, 3 audio clips; 1–12 materials in total. */
export const REF2VA_LIMITS = { image: 9, video: 3, audio: 3, minTotal: 1, maxTotal: 12 } as const;
/** Official guidance for reference video / audio: each clip 2–15 s, at most 15 s per kind in total. */
export const CLIP_GUIDANCE = { min: 2, max: 15, total: 15 } as const;

/** A held window (hold_last_frame) needs at least one frame at the H3 rate of 24 fps: the frame that is repeated. */
export const HELD_WINDOW_MIN_SECONDS = 1 / 24;

/**
 * The length a reference video or audio clip counts as for CLIP_GUIDANCE (each clip and the total per kind): its window,
 * or for a held video the generated length, since the runtime holds its last frame up to it (a window shorter than 2 s
 * is fine then). null = unknown.
 */
export function guidanceSeconds(windowSeconds: number | null, held: boolean, generatedSeconds: number | null): number | null {
  return held ? generatedSeconds : windowSeconds;
}

/** The H3 TE tag of each kind (<Picture n>, <Video n>, <Audio n>). */
export const H3_TAG: Readonly<Record<MaterialKind, string>> = { image: "Picture", video: "Video", audio: "Audio" };

/**
 * Send order (Studio and inference page alike): images, then audio, then videos. H3 numbers each kind by its
 * order in the request, and a reference video with sound takes an extra <Audio n> before its own <Video n>, so audio
 * goes before video to keep @Audio1… bound to <Audio 1>… whatever the videos' soundtracks turn out to be.
 */
export const SEND_ORDER: Readonly<Record<MaterialKind, number>> = { image: 0, audio: 1, video: 2 };

/** Order of two roles when sending (negative: a first; 0 within a kind, where callers keep their own order). */
export function compareRoles(a: MaterialRole, b: MaterialRole): number {
  return SEND_ORDER[ROLE_KIND[a]] - SEND_ORDER[ROLE_KIND[b]];
}

/** Media category of a MIME type; null for anything else (e.g. application/octet-stream). */
export function kindOfMediaType(mediaType: string): MaterialKind | null {
  const major = (mediaType.split(";")[0] ?? "").trim().toLowerCase().split("/")[0];
  return major === "image" || major === "video" || major === "audio" ? major : null;
}

export type SoundtrackState = "used" | "off" | "none" | "unknown";
/** What is known about a video's soundtrack before sending. */
export type SoundtrackInput = "off" | "none" | "present" | "unknown";

export interface LabelInput {
  kind: MaterialKind;
  /** Videos only; omitted = unknown. */
  soundtrack?: SoundtrackInput;
}

export interface OrderedLabel {
  /** The material's own tag; null for audio after a video whose soundtrack is unknown (its number is not certain). */
  label: string | null;
  /** A video's soundtrack: used (sent as <Audio n>), off, none (no track) or unknown (probed by the runtime). */
  soundtrack: { state: SoundtrackState; label: string | null } | null;
}

/** H3 TE tags for materials in request order (a video with sound also takes the next <Audio n>). */
export function labelsInOrder(items: readonly LabelInput[]): OrderedLabel[] {
  const counters: Record<MaterialKind, number> = { image: 0, video: 0, audio: 0 };
  let audioUncertain = false;
  return items.map((item) => {
    let soundtrack: OrderedLabel["soundtrack"] = null;
    if (item.kind === "video") {
      const input = item.soundtrack ?? "unknown";
      if (input === "off") soundtrack = { state: "off", label: null };
      else if (input === "none") soundtrack = { state: "none", label: null };
      else if (input === "present") {
        counters.audio += 1;
        soundtrack = { state: "used", label: audioUncertain ? null : `<Audio ${String(counters.audio)}>` };
      } else {
        audioUncertain = true;
        soundtrack = { state: "unknown", label: null };
      }
    }
    counters[item.kind] += 1;
    const label = item.kind === "audio" && audioUncertain ? null : `<${H3_TAG[item.kind]} ${String(counters[item.kind])}>`;
    return { label, soundtrack };
  });
}
