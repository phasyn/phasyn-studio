// The top of the keyframe lanes: a time ruler for the selected clip's own range (a press or a drag moves the
// playhead), the head and the line of the sequence playhead while it is on the clip, and the playhead's position
// inside the clip as a timecode. Each part subscribes to the playhead by itself and moves linearly, so playback
// re-renders nothing else of the panel.
import type { PointerEvent } from "react";
import { t } from "@/i18n";
import { formatTimecode } from "../../../../model/frames";
import { clipDuration } from "../../../model";
import { useClipPanel } from "../panelContext";
import { usePlayheadValue } from "../usePlayheadValue";
import { laneFraction, laneFrameAt, laneLeft, rulerTicks, shortTimecode } from "./laneGeometry";

const TICK = "pointer-events-none absolute inset-y-0 border-l border-line-strong pl-1 font-mono text-[11px] leading-4 text-fg-tertiary";

/** Where the playhead is on the lanes (0 … 1); -1 while it is not on the clip. */
function usePlayheadFraction(): number {
  const panel = useClipPanel();
  return usePlayheadValue(panel.playhead, (frame) => laneFraction(panel.clip, frame) ?? -1);
}

function RulerHead() {
  const fraction = usePlayheadFraction();
  if (fraction < 0) return null;
  const left = laneLeft(fraction);
  return <span aria-hidden className="pointer-events-none absolute top-0 h-2.5 w-[9px] -translate-x-1/2 rounded-b-[3px] bg-playhead" style={{ left }} />;
}

export interface LaneRulerProps {
  /** Width of the lane column in px (how many labels have room). */
  width: number;
}

export function LaneRuler({ width }: LaneRulerProps) {
  const panel = useClipPanel();
  const { clip, fps } = panel;
  const duration = clipDuration(clip);
  const seek = (event: PointerEvent<HTMLDivElement>) => { panel.seek(laneFrameAt(clip, event.currentTarget.getBoundingClientRect(), event.clientX)); };
  return (
    <div
      title={t("按一下或拖曳：把播放頭移到片段的這個位置")}
      className="relative h-full cursor-crosshair touch-none overflow-hidden select-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        seek(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) seek(event);
      }}
    >
      {rulerTicks(duration, width, fps).map((tick) => (
        <span key={tick} aria-hidden className={TICK} style={{ left: laneLeft(tick / Math.max(1, duration)) }}>
          {shortTimecode(tick, fps)}
        </span>
      ))}
      <RulerHead />
    </div>
  );
}

/**
 * The ground of the lane column, from the ruler to the bottom of the panel body. It comes first in the body, so the
 * rows (which are positioned) are drawn over it, and it is what a press below the last row lands on: the playhead
 * moves there, as on a lane.
 */
export function LaneBackdrop() {
  const panel = useClipPanel();
  return (
    <div
      aria-hidden
      className="absolute inset-y-0 right-0 left-(--ec-props) border-l border-line-subtle bg-sunken/60"
      onPointerDown={(event) => {
        if (event.button === 0) panel.seek(laneFrameAt(panel.clip, event.currentTarget.getBoundingClientRect(), event.clientX));
      }}
    />
  );
}

/** The playhead line through every lane: drawn over the rows of the panel body, whose property column is --ec-props wide. */
export function LanePlayhead() {
  const fraction = usePlayheadFraction();
  if (fraction < 0) return null;
  const left = laneLeft(fraction, "var(--ec-props)");
  return <div aria-hidden className="pointer-events-none absolute inset-y-0 z-10 w-px bg-playhead" style={{ left }} />;
}

/** The playhead's position inside the clip, beside the ruler. */
export function ClipTime() {
  const { clip, fps, playhead } = useClipPanel();
  const time = usePlayheadValue(playhead, (frame) => (laneFraction(clip, frame) === null ? "" : formatTimecode(frame - clip.start_frame, fps)));
  const title = time ? t("播放頭在片段內的位置") : t("播放頭不在這個片段上");
  return (
    <span className="machine truncate text-caption text-fg-tertiary" title={title}>
      {time || "—"}
    </span>
  );
}
