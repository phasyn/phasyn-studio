// The timing fields of the Clip group: a clip's source In and Out as typed frame numbers, and the trim, ripple or
// rolling edit that brings an edge to a typed frame. Pure; the edits are the timeline's own commands.
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { EditCommand } from "../../commands";
import { processedDuration, sourceBoundary, windowBounds, type TimelineResult } from "../../model";
import { editCommand, type GestureMode } from "../../timelineGeometry";

/** How typing a new In or Out trims: only this clip, with the following clips closing up, or together with its neighbour. */
export type TrimMode = "normal" | "ripple" | "roll";
export const TRIM_MODES: readonly TrimMode[] = ["normal", "ripple", "roll"];

export interface SourceEdge {
  /** The source frame the clip starts (In) or ends (Out, exclusive) on. */
  frame: number;
  /** Why the edge cannot be typed; null when it can. */
  reason: string | null;
}

/** A clip's source In or Out. An edge inside a hold, or between two source frames of a retimed clip, has no frame to type. */
export function sourceEdge(clip: TimelineClip, edge: "in" | "out"): SourceEdge {
  const complete = processedDuration(clip);
  const window = windowBounds(clip);
  const sourceIn = sourceBoundary(clip, "in");
  const sourceOut = sourceBoundary(clip, "out");
  const frame = edge === "in" ? sourceIn : sourceOut;
  const at = edge === "in" ? window.start_frame : window.end_frame;
  const inHold = (at > 0 && at < (clip.effects?.hold?.start ?? 0)) || (at < complete && at > complete - (clip.effects?.hold?.end ?? 0));
  const untypable = !Number.isInteger(frame) || inHold || sourceIn >= sourceOut;
  return { frame, reason: untypable ? t("這個邊界位於停格或兩個素材影格之間；請在時間軸上修剪") : null };
}

const GESTURES: Record<TrimMode, Record<"in" | "out", Exclude<GestureMode, "razor" | "rearrange">>> = {
  normal: { in: "trimIn", out: "trimOut" },
  ripple: { in: "rippleIn", out: "rippleOut" },
  roll: { in: "rollIn", out: "rollOut" },
};

/** The edit that moves a clip's source In or Out to `sourceFrame` in the chosen trim mode. */
export function trimEdit(
  timeline: StudioTimeline,
  clip: TimelineClip,
  edge: "in" | "out",
  mode: TrimMode,
  sourceFrame: number,
  linked: boolean,
): TimelineResult<EditCommand> {
  const speed = clip.effects?.speed_percent ?? 100;
  const delta = ((sourceFrame - sourceEdge(clip, edge).frame) * 100) / speed;
  if (!Number.isInteger(delta)) return { ok: false, error: t("這個素材影格在目前的速度下不落在完整的序列影格上") };
  return editCommand(timeline, clip, GESTURES[mode][edge], delta, clip.track_id, linked);
}
