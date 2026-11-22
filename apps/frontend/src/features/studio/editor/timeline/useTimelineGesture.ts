// Pointer gestures on timeline clips: move, trim (plain, ripple, roll), slip, slide and razor in the full timeline;
// rearrange in the compact one. A gesture only previews (the same command run on a copy); the document is written
// once, on release. Escape or a lost pointer capture cancels without a trace.
import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { executeEdit } from "../commands";
import type { Editor } from "../editorContext";
import { clipDuration, selectClips } from "../model";
import { editCommand, gestureBox, rearrangeCommand, snappedDelta, type GestureMode, type PreviewCommand } from "../timelineGeometry";

interface Gesture {
  pointerId: number;
  originX: number;
  originY: number;
  originScroll: number;
  timeline: StudioTimeline;
  clip: TimelineClip;
  clipIds: string[];
  toggleOnClick: boolean;
  /** A plain click on one clip of a larger selection: on release without a drag, only that clip stays selected. */
  collapseOnClick: boolean;
  mode: GestureMode;
  linked: boolean;
}

export interface TimelinePreview {
  mode: GestureMode;
  /** The document as it would be after the gesture; null while the gesture is not valid. */
  timeline: StudioTimeline | null;
  command: PreviewCommand | null;
  error: string | null;
  /** Frame of the snap guide. */
  guide: number | null;
  trackId: string;
  clipId: string;
  start: number;
  length: number;
  delta: number;
}

export interface GestureOptions {
  /** Pixels per frame. */
  zoom: number;
  /** Width of the sticky track-header column left of the clips. */
  headerWidth: number;
  /** rearrange: dragging a clip reorders it (compact timeline); edit: the tool decides (full timeline). */
  behaviour: "edit" | "rearrange";
}

export function useTimelineGesture(editor: Editor, scroller: RefObject<HTMLDivElement | null>, options: GestureOptions) {
  const [preview, setPreview] = useState<TimelinePreview | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const liveRef = useRef({ editor, options });
  useLayoutEffect(() => {
    liveRef.current = { editor, options };
  });
  const cancel = (): boolean => {
    const active = gestureRef.current !== null;
    gestureRef.current = null;
    setPreview(null);
    return active;
  };

  const frameAt = (clientX: number): number => {
    const node = scroller.current;
    if (!node) return 0;
    const { zoom, headerWidth } = liveRef.current.options;
    return Math.max(0, Math.round((clientX - node.getBoundingClientRect().left - headerWidth + node.scrollLeft) / zoom));
  };
  const trackAt = (clientY: number, fallback: string): string => {
    const rows = scroller.current?.querySelectorAll<HTMLElement>("[data-timeline-track]") ?? [];
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY >= rect.top && clientY < rect.bottom) return row.dataset["timelineTrack"] ?? fallback;
    }
    return fallback;
  };

  const calculate = (event: PointerEvent<HTMLElement>, session: Gesture): TimelinePreview => {
    const state = liveRef.current;
    const { zoom } = state.options;
    const scroll = scroller.current?.scrollLeft ?? session.originScroll;
    const raw = Math.round((event.clientX - session.originX + scroll - session.originScroll) / zoom);
    const snapping = state.editor.snapping && !event.altKey;
    const snap = snapping
      ? snappedDelta(session.timeline, session.clip, session.mode, raw, state.editor.playhead.getFrame(), zoom, session.linked, session.clipIds)
      : { delta: raw, guide: null };
    const delta = snap.delta;
    const trackId = session.mode === "move" ? trackAt(event.clientY, session.clip.track_id) : session.clip.track_id;
    const base = { mode: session.mode, guide: snap.guide, trackId, clipId: session.clip.clip_id, ...gestureBox(session.clip, session.mode, delta), delta };
    if (state.editor.timeline !== session.timeline) return { ...base, timeline: null, command: null, error: t("時間軸已變更，請重新拖曳") };
    if (session.mode === "razor") return { ...base, timeline: null, command: null, error: null };
    if (session.mode === "rearrange") {
      const command = rearrangeCommand(session.timeline, session.clipIds, frameAt(event.clientX), session.linked);
      if (!command) return { ...base, timeline: session.timeline, command: null, error: null };
      const result = executeEdit(session.timeline, command);
      return { ...base, timeline: result.ok ? result.value : null, command, error: result.ok ? null : result.error };
    }
    const command = editCommand(session.timeline, session.clip, session.mode, delta, trackId, session.linked, session.clipIds);
    if (!command.ok) return { ...base, timeline: null, command: null, error: command.error };
    const result = executeEdit(session.timeline, command.value);
    return { ...base, timeline: result.ok ? result.value : null, command: command.value, error: result.ok ? null : result.error };
  };

  const modeFor = (clip: TimelineClip, clientX: number, edge?: "in" | "out"): GestureMode => {
    const state = liveRef.current;
    if (state.options.behaviour === "rearrange") return "rearrange";
    const tool = state.editor.tool;
    const side = edge ?? (frameAt(clientX) - clip.start_frame < clipDuration(clip) / 2 ? "in" : "out");
    if (tool === "razor" && !edge) return "razor";
    if (tool === "roll") return side === "in" ? "rollIn" : "rollOut";
    if (tool === "ripple") return side === "in" ? "rippleIn" : "rippleOut";
    if (edge) return edge === "in" ? "trimIn" : "trimOut";
    if (tool === "slip") return "slip";
    if (tool === "slide") return "slide";
    return "move";
  };

  const begin = (event: PointerEvent<HTMLElement>, clip: TimelineClip, edge?: "in" | "out") => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const state = liveRef.current;
    if (state.editor.trackOf(clip)?.locked === true) {
      state.editor.select(clip.clip_id, event.shiftKey);
      return;
    }
    state.editor.playhead.setPlaying(false);
    const mode = modeFor(clip, event.clientX, edge);
    const whole = mode === "move" || mode === "rearrange";
    const alreadySelected = selectClips(state.editor.timeline, state.editor.selected, state.editor.linked).some((item) => item.clip_id === clip.clip_id);
    const keepSelection = whole && alreadySelected;
    // A rearrange moves clips of one track: the selected ones on the dragged clip's track travel together
    const picked = keepSelection ? [...state.editor.selected] : event.shiftKey ? [...state.editor.selected, clip.clip_id] : [clip.clip_id];
    const sameTrack = picked.filter((id) => state.editor.timeline.clips.find((item) => item.clip_id === id)?.track_id === clip.track_id);
    const clipIds = mode === "rearrange" ? (sameTrack.includes(clip.clip_id) ? sameTrack : [clip.clip_id]) : picked;
    if (!keepSelection) state.editor.select(clip.clip_id, event.shiftKey);
    gestureRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      originScroll: scroller.current?.scrollLeft ?? 0,
      timeline: state.editor.timeline,
      clip,
      clipIds,
      toggleOnClick: keepSelection && event.shiftKey,
      collapseOnClick: keepSelection && !event.shiftKey && picked.length > 1,
      mode,
      linked: state.editor.linked,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    const session = gestureRef.current;
    if (session?.pointerId !== event.pointerId || session.mode === "razor") return;
    if (Math.hypot(event.clientX - session.originX, event.clientY - session.originY) < 3 && preview === null) return;
    const node = scroller.current;
    if (node) {
      const rect = node.getBoundingClientRect();
      if (event.clientX > rect.right - 24) node.scrollBy({ left: 18 });
      else if (event.clientX < rect.left + liveRef.current.options.headerWidth + 24) node.scrollBy({ left: -18 });
    }
    setPreview(calculate(event, session));
  };

  const finish = (event: PointerEvent<HTMLElement>) => {
    const session = gestureRef.current;
    if (session?.pointerId !== event.pointerId) return;
    const state = liveRef.current;
    const moved = Math.hypot(event.clientX - session.originX, event.clientY - session.originY) >= 3 || preview !== null;
    const next = calculate(event, session);
    cancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (session.mode === "razor") {
      if (state.editor.timeline !== session.timeline) state.editor.warn(t("時間軸已變更，請重新拖曳"));
      else state.editor.command({ type: "split", clipIds: [session.clip.clip_id], frame: frameAt(event.clientX), linked: session.linked });
      return;
    }
    if (!moved) {
      if (session.toggleOnClick) state.editor.select(session.clip.clip_id, true);
      // As in Premiere Pro: the group stays selected while it could be dragged, the click itself picks the one clip
      else if (session.collapseOnClick) state.editor.select(session.clip.clip_id, false);
      // In the Shots workspace a click on a clip is a click on its shot: the monitor shows that shot's take
      if (session.mode === "rearrange") state.editor.setMonitorMode("source");
      return;
    }
    if (next.error != null && next.error !== "") state.editor.warn(next.error);
    else if (next.command && (next.mode === "rearrange" || next.delta !== 0 || next.trackId !== session.clip.track_id)) state.editor.command(next.command);
  };

  return { preview, begin, cancel, handlers: { onPointerMove: move, onPointerUp: finish, onPointerCancel: cancel, onLostPointerCapture: cancel } };
}

export type TimelineGestures = ReturnType<typeof useTimelineGesture>;
