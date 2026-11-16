// The time ruler (frame-accurate ticks, the sequence In/Out range, coloured markers) and the playhead. The playhead
// subscribes to the playhead store on its own, so moving it never re-renders the tracks; it moves linearly and its
// head is the one element of the timeline that glows.
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import type { StudioTimeline, TimelineMarker } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { usePlayheadFrame, usePlaying, type PlayheadStore } from "../../hooks/playhead";
import { formatTimecode } from "../../model/frames";
import { rulerStep, RULER_HEIGHT } from "../timelineGeometry";
import { MARKER_COLOR } from "./markerColors";

export interface RulerProps {
  timeline: StudioTimeline;
  playhead: PlayheadStore;
  fps: number;
  zoom: number;
  width: number;
  /** Visible span in px (scroll position and viewport width of the graph area). */
  scrollLeft: number;
  viewport: number;
  /** Move the playhead to a frame (click, drag or keys on the ruler). */
  onSeek: (frame: number) => void;
  /** Frames a step key moves by (Shift = five). */
  onStep: (frames: number) => void;
  onMarkerMove?: (marker: TimelineMarker, frame: number) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}

export function TimelineRuler({ timeline, playhead, fps, zoom, width, scrollLeft, viewport, onSeek, onStep, onMarkerMove, onContextMenu }: RulerProps) {
  const step = rulerStep(zoom, fps);
  const first = Math.max(0, Math.floor(scrollLeft / zoom / step) * step);
  const last = Math.ceil((scrollLeft + viewport) / zoom / step) * step;
  const ticks: number[] = [];
  for (let tick = first; tick <= last; tick += step) ticks.push(tick);
  // Frame ticks between the labels once a frame is wide enough to tell apart
  const minor = zoom >= 6 ? 1 : step >= fps && zoom * fps >= 24 ? Math.round(fps) : 0;
  const frameAt = (event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>) => Math.max(0, Math.round((event.clientX - event.currentTarget.getBoundingClientRect().left) / zoom));
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    onStep((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 5 : 1));
  };
  const dragMarker = (event: PointerEvent<HTMLElement>, marker: TimelineMarker) => {
    if (event.button !== 0 || !onMarkerMove) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = event.clientX;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const up = (done: globalThis.PointerEvent) => {
      target.removeEventListener("pointerup", up);
      const frames = Math.round((done.clientX - origin) / zoom);
      if (frames === 0) onSeek(marker.frame);
      else onMarkerMove(marker, Math.max(0, marker.frame + frames));
    };
    target.addEventListener("pointerup", up);
  };
  const area = timeline.work_area;
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={t("時間尺")}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.round(width / zoom))}
      aria-valuenow={0}
      onKeyDown={keys}
      onContextMenu={onContextMenu}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        onSeek(frameAt(event));
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onSeek(frameAt(event));
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      className="relative shrink-0 cursor-crosshair touch-none overflow-hidden outline-none select-none focus-visible:bg-raised/40"
      style={{ width, height: RULER_HEIGHT }}
    >
      {area ? (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 border-x-2 border-trim bg-trim/15" style={{ left: area.start_frame * zoom, width: (area.end_frame - area.start_frame) * zoom }} />
      ) : null}
      {ticks.map((tick) => (
        <span key={tick} aria-hidden className="pointer-events-none absolute inset-y-0 border-l border-line-strong pl-1 font-mono text-[11px] leading-4 text-fg-tertiary" style={{ left: tick * zoom }}>
          {formatTimecode(tick, fps)}
        </span>
      ))}
      {minor > 0 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1.5 opacity-70"
          style={{ backgroundImage: "linear-gradient(to right, var(--color-line-strong) 1px, transparent 1px)", backgroundSize: `${minor * zoom}px 100%` }}
        />
      ) : null}
      {timeline.markers.map((marker) => (
        <span
          key={marker.marker_id}
          role="img"
          aria-label={t("標記 {name}，{time}", { name: marker.name, time: formatTimecode(marker.frame, fps) })}
          title={t("標記 {name}，{time}", { name: marker.name, time: formatTimecode(marker.frame, fps) })}
          onPointerDown={(event) => dragMarker(event, marker)}
          className={cn("absolute bottom-0 h-3 w-2.5 -translate-x-1/2 rounded-t-[3px]", onMarkerMove ? "cursor-ew-resize" : "pointer-events-none", MARKER_COLOR[marker.color])}
          style={{ left: marker.frame * zoom }}
        />
      ))}
      <PlayheadHead playhead={playhead} zoom={zoom} />
    </div>
  );
}

/** The head of the playhead in the ruler (the line through the rows is Playhead). */
function PlayheadHead({ playhead, zoom }: { playhead: PlayheadStore; zoom: number }) {
  const frame = usePlayheadFrame(playhead);
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-playhead" style={{ left: frame * zoom }}>
      <span className="absolute top-0 left-1/2 h-3 w-3 -translate-x-1/2 rounded-b-[3px] bg-playhead shadow-glow-sm" />
    </span>
  );
}

/** The playhead line through every row. While the sequence plays it turns the page when it leaves the visible span. */
export function Playhead({ playhead, zoom, offset, scrollerRef }: { playhead: PlayheadStore; zoom: number; offset: number; scrollerRef: RefObject<HTMLDivElement | null> }) {
  const frame = usePlayheadFrame(playhead);
  const playing = usePlaying(playhead);
  const x = offset + frame * zoom;
  const latest = useRef({ offset });
  useEffect(() => {
    latest.current = { offset };
  });
  useEffect(() => {
    const node = scrollerRef.current;
    if (!playing || !node) return;
    const right = node.scrollLeft + node.clientWidth;
    if (x > right - 24 || x < node.scrollLeft + latest.current.offset) node.scrollTo({ left: Math.max(0, x - latest.current.offset - 48) });
  }, [playing, scrollerRef, x]);
  return <div aria-hidden className="pointer-events-none absolute bottom-0 z-[15] w-px bg-playhead" style={{ left: x, top: RULER_HEIGHT }} />;
}
