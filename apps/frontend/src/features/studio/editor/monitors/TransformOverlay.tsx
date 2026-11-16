// Direct manipulation of the selected clip in the Program viewer. The frame of the clip is the move handle itself
// (drag anywhere inside it), the corners scale and the round knob on the top edge rotates, so nothing sits on top of
// the picture or its text. A gesture previews locally and commits one undoable edit on release.
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { upsertCurveKey } from "../curves";
import { clipDuration, motionAt, MOTION_LIMITS, toProcessingFrame, type MotionChannel } from "../model";

type TransformMode = "move" | "scale" | "rotate";

interface Gesture {
  id: number;
  mode: TransformMode;
  clip: TimelineClip;
  x: number;
  y: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

/** Writes motion values at a frame: into the property's keyframes when it is animated, else into its fixed value. */
function applyMotion(clip: TimelineClip, frame: number, patch: Partial<Record<MotionChannel, number>>): TimelineClip {
  const motion = { ...clip.motion, keyframes: { ...clip.motion.keyframes } };
  for (const [property, raw] of Object.entries(patch)) {
    const key = property as MotionChannel;
    const [low, high] = MOTION_LIMITS[key];
    const value = Math.max(low, Math.min(high, raw));
    const keys = motion.keyframes[key];
    if (keys?.length) motion.keyframes[key] = upsertCurveKey(keys, toProcessingFrame(clip, Math.round(frame - clip.start_frame)), value);
    else motion[key] = value;
  }
  return { ...clip, motion };
}

const CORNERS = [
  { id: "nw", className: "-top-1.5 -left-1.5 cursor-nwse-resize" },
  { id: "ne", className: "-top-1.5 -right-1.5 cursor-nesw-resize" },
  { id: "sw", className: "-bottom-1.5 -left-1.5 cursor-nesw-resize" },
  { id: "se", className: "-right-1.5 -bottom-1.5 cursor-nwse-resize" },
] as const;

const HANDLE = "pointer-events-auto absolute size-3 touch-none rounded-[3px] border border-brand-cyan bg-surface focus-visible:outline-2 focus-visible:outline-focus";

export function TransformOverlay({
  clip,
  original,
  frame,
  locked,
  onPreview,
  onCommit,
  onCancel,
  onStart,
}: {
  /** The clip as drawn (the local preview while a gesture runs). */
  clip: TimelineClip;
  /** The committed clip the gesture starts from. */
  original: TimelineClip;
  frame: number;
  locked: boolean;
  onPreview: (clip: TimelineClip) => void;
  onCommit: (clip: TimelineClip) => void;
  onCancel: () => void;
  onStart: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const motion = motionAt(clip, frame);
  if (locked || frame < clip.start_frame || frame >= clip.start_frame + clipDuration(clip)) return null;

  const begin = (event: PointerEvent<HTMLElement>, mode: TransformMode) => {
    const rect = root.current?.getBoundingClientRect();
    if (event.button !== 0 || !rect) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    onStart();
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = motionAt(original, frame);
    gesture.current = {
      id: event.pointerId,
      mode,
      clip: original,
      x: event.clientX,
      y: event.clientY,
      centerX: rect.left + rect.width * (0.5 + at.x),
      centerY: rect.top + rect.height * (0.5 + at.y),
      width: rect.width,
      height: rect.height,
    };
  };
  const changed = (event: PointerEvent<HTMLElement>, state: Gesture): TimelineClip => {
    const at = motionAt(state.clip, frame);
    let dx = event.clientX - state.x;
    let dy = event.clientY - state.y;
    if (state.mode === "move") {
      // Shift keeps the move on one axis
      if (event.shiftKey && Math.abs(dx) > Math.abs(dy)) dy = 0;
      else if (event.shiftKey) dx = 0;
      return applyMotion(state.clip, frame, { x: at.x + dx / state.width, y: at.y + dy / state.height });
    }
    if (state.mode === "scale") {
      const from = Math.max(1, Math.hypot(state.x - state.centerX, state.y - state.centerY));
      return applyMotion(state.clip, frame, { scale: (at.scale * Math.hypot(event.clientX - state.centerX, event.clientY - state.centerY)) / from });
    }
    const turned = Math.atan2(event.clientY - state.centerY, event.clientX - state.centerX) - Math.atan2(state.y - state.centerY, state.x - state.centerX);
    const angle = at.rotation + (turned * 180) / Math.PI;
    return applyMotion(state.clip, frame, { rotation: event.shiftKey ? Math.round(angle / 15) * 15 : angle });
  };
  const handlers = {
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const state = gesture.current;
      if (state?.id === event.pointerId) onPreview(changed(event, state));
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const state = gesture.current;
      if (state?.id !== event.pointerId) return;
      const next = changed(event, state);
      gesture.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      onCommit(next);
    },
    onPointerCancel: () => {
      gesture.current = null;
      onCancel();
    },
  };
  const nudge = (event: KeyboardEvent<HTMLElement>) => {
    const amount = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
    const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
    const rect = root.current?.getBoundingClientRect();
    if (!rect || (!dx && !dy)) return;
    event.preventDefault();
    event.stopPropagation();
    onCommit(applyMotion(original, frame, { x: motion.x + dx / rect.width, y: motion.y + dy / rect.height }));
  };
  const resize = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "+" && event.key !== "=" && event.key !== "-") return;
    event.preventDefault();
    event.stopPropagation();
    onCommit(applyMotion(original, frame, { scale: motion.scale + (event.key === "-" ? -0.01 : 0.01) }));
  };
  const turn = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    onCommit(applyMotion(original, frame, { rotation: motion.rotation + (event.key === "ArrowLeft" ? -1 : 1) }));
  };
  // The frame is scaled with the clip; handles keep their size on screen
  const steady = { transform: `scale(${1 / Math.max(0.05, motion.scale)})` };
  return (
    <div ref={root} className="pointer-events-none absolute inset-0 z-20" role="group" aria-label={t("節目監看器變形控制")}>
      <div
        className="absolute inset-0 origin-center"
        style={{ transform: `translate(${motion.x * 100}%, ${motion.y * 100}%) rotate(${motion.rotation}deg) scale(${motion.scale})` }}
      >
        <div
          role="button"
          tabIndex={0}
          aria-label={t("拖曳移動片段")}
          title={t("拖曳移動；Shift 限制方向，方向鍵微調")}
          className="pointer-events-auto absolute inset-0 touch-none cursor-move border border-brand-cyan/80 outline-none focus-visible:border-2 focus-visible:border-focus"
          onPointerDown={(event) => begin(event, "move")}
          onKeyDown={nudge}
          {...handlers}
        />
        {CORNERS.map((corner) => (
          <button
            key={corner.id}
            type="button"
            aria-label={t("拖曳縮放片段")}
            title={t("拖曳縮放；加減鍵微調")}
            className={cn(HANDLE, corner.className)}
            style={steady}
            onPointerDown={(event) => begin(event, "scale")}
            onKeyDown={resize}
            {...handlers}
          />
        ))}
        <button
          type="button"
          aria-label={t("拖曳旋轉片段")}
          title={t("拖曳旋轉；Shift 每 15 度，左右鍵微調")}
          className={cn(HANDLE, "-top-1.5 left-1/2 -ml-1.5 cursor-grab rounded-full active:cursor-grabbing")}
          style={steady}
          onPointerDown={(event) => begin(event, "rotate")}
          onKeyDown={turn}
          {...handlers}
        />
      </div>
    </div>
  );
}
