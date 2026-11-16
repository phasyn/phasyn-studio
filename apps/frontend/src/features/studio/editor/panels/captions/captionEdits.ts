// The caption edits of the Captions panel as new timeline documents (add at the playhead, change, remove), the
// choices of a caption's position and size, and the checks of its text. Pure: the panel commits each result as one
// edit, and the editor's own validation has the last word on a range.
import type { StudioTimeline, TimelineCaption } from "@/api/generated/contracts";
import { MAX_CAPTIONS, MAX_TEXT_CHARS } from "@/api/generated/timelineLimits";
import { t } from "@/i18n";
import { MAX_TIMELINE_FRAMES } from "../../model";

export type CaptionPosition = TimelineCaption["position"];
export type CaptionSize = TimelineCaption["size"];

export const CAPTION_POSITIONS: readonly { value: CaptionPosition; label: string }[] = [
  { value: "top", label: t("上方") },
  { value: "center", label: t("中央") },
  { value: "bottom", label: t("下方") },
  { value: "lower_third", label: t("下三分之一") },
];

export const CAPTION_SIZES: readonly { value: CaptionSize; label: string }[] = [
  { value: "small", label: t("小") },
  { value: "medium", label: t("中") },
  { value: "large", label: t("大") },
];

/** Seconds a new caption stays on screen. */
const NEW_CAPTION_SECONDS = 3;

/** The captions in the order they appear. */
export function sortedCaptions(captions: readonly TimelineCaption[]): TimelineCaption[] {
  return [...captions].sort((a, b) => a.start_frame - b.start_frame || a.end_frame - b.end_frame);
}

/** A caption that starts on a frame (the playhead) with the default text, at the bottom, in the medium size. */
export function newCaption(captionId: string, frame: number, fps: number): TimelineCaption {
  const start = Math.max(0, Math.min(MAX_TIMELINE_FRAMES - 1, Math.round(frame)));
  const end = Math.min(MAX_TIMELINE_FRAMES, start + Math.max(1, Math.round(fps * NEW_CAPTION_SECONDS)));
  return { caption_id: captionId, start_frame: start, end_frame: end, text: t("新字幕"), position: "bottom", size: "medium" };
}

export function withCaption(timeline: StudioTimeline, captionId: string, change: Partial<TimelineCaption>): StudioTimeline {
  return { ...timeline, captions: timeline.captions.map((caption) => (caption.caption_id === captionId ? { ...caption, ...change } : caption)) };
}

export function withoutCaption(timeline: StudioTimeline, captionId: string): StudioTimeline {
  return { ...timeline, captions: timeline.captions.filter((caption) => caption.caption_id !== captionId) };
}

/** Why a caption's text cannot be kept; null when it can. */
export function captionTextProblem(text: string): string | null {
  if (!text.trim()) return t("字幕內容不能是空白");
  return text.length > MAX_TEXT_CHARS ? t("字幕最多 {max} 個字元", { max: MAX_TEXT_CHARS }) : null;
}

/** Why no caption can be added; null when one can. */
export function captionLimit(timeline: StudioTimeline): string | null {
  return timeline.captions.length >= MAX_CAPTIONS ? t("字幕最多 {max} 段", { max: MAX_CAPTIONS }) : null;
}

/** A caption's text on one line (a list row). */
export function captionLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}
