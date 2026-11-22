// The timeline. One component for both workspaces: "full" in Edit (track headers with patching and targeting, every
// tool, trim handles, transitions, context menus, drops from the Project panel, the Source monitor and the Effects
// browser) and "compact" in Shots (low tracks, select, play and rearrange only). Both read the same document,
// selection, playhead and view from the editor, so switching workspace changes nothing.
import { TriangleAlert } from "lucide-react";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import type { TimelineTrack } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { ActionMenu } from "@/components/ui/action-menu";
import { PANEL } from "@/components/ui/look";
import type { MenuAnchor, MenuItem } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useElementSize } from "@/lib/useElementSize";
import { usePersistentFlag } from "@/lib/usePersistentSize";
import { activeTransition } from "../../model/clipEffects";
import { useEditor } from "../editorContext";
import { clipDuration, MAX_TIMELINE_FRAMES, selectClips, trackClips } from "../model";
import { COMPACT_HEADER_WIDTH, MAX_ZOOM, MIN_ZOOM, orderedTracks, RULER_HEIGHT, TRACK_HEADER_WIDTH, TRACK_HEIGHTS, trackLabel } from "../timelineGeometry";
import { TIMELINE_ZOOM_EVENT, useTimelineZoom } from "../timelineView";
import { cutOf, repeatedFrames } from "../transitionCut";
import { CaptionTrack } from "./CaptionTrack";
import { EffectDropMarks } from "./EffectDropMarks";
import { clipMenu, gapMenu, rulerMenu, trackMenu, transitionMenu } from "./menus";
import { ClipBar, TransitionObject } from "./TimelineClip";
import { CompactTimelineHeader, TimelineHeader } from "./TimelineHeader";
import { Playhead, TimelineRuler } from "./TimelineRuler";
import { TimelineStatus } from "./TimelineStatus";
import { CompactTrackHeader, TrackHeader } from "./TrackHeader";
import { useTrackSizes } from "./trackSizes";
import { useEffectDrop } from "./useEffectDrop";
import { useSourceDrop } from "./useSourceDrop";
import { useTimelineGesture } from "./useTimelineGesture";
import { ZoomScrollBar } from "./ZoomScrollBar";

interface OpenMenu {
  label: string;
  items: MenuItem[];
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
}

const TOOL_CURSOR = { select: "cursor-grab active:cursor-grabbing", razor: "cursor-crosshair", ripple: "cursor-ew-resize", roll: "cursor-col-resize", slip: "cursor-ew-resize", slide: "cursor-ew-resize" } as const;

type DropHandlers = ReturnType<typeof useSourceDrop>["handlers"];

/** The tracks take both kinds of drop: each handler acts only on its own kind of drag. */
function bothDrops(first: DropHandlers, second: DropHandlers): DropHandlers {
  const both = (a: (event: DragEvent<HTMLElement>) => void, b: (event: DragEvent<HTMLElement>) => void) => (event: DragEvent<HTMLElement>) => {
    a(event);
    b(event);
  };
  return {
    onDragEnter: both(first.onDragEnter, second.onDragEnter),
    onDragOver: both(first.onDragOver, second.onDragOver),
    onDragLeave: both(first.onDragLeave, second.onDragLeave),
    onDrop: both(first.onDrop, second.onDrop),
  };
}

export interface TimelinePanelProps {
  density: "full" | "compact";
  /** Only the header row shows (the Shots workspace collapses its timeline this way). */
  collapsed?: boolean;
  /** Extra controls at the right end of the compact header. */
  actions?: ReactNode;
  className?: string;
}

export function TimelinePanel({ density, collapsed = false, actions, className }: TimelinePanelProps) {
  const editor = useEditor();
  const { timeline, fps, totalFrames, problem, playhead, transport, view } = editor;
  const compact = density === "compact";
  const headerWidth = compact ? COMPACT_HEADER_WIDTH : TRACK_HEADER_WIDTH;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { width: scrollerWidth } = useElementSize(scrollerRef);
  const viewport = Math.max(0, scrollerWidth - headerWidth);
  const zoom = useTimelineZoom(view);
  const [scrollLeft, setScrollLeft] = useState(() => view.getScroll());
  const anchorRef = useRef<{ frame: number; x: number } | null>(null);
  const [captionsShown, setCaptionsShown] = usePersistentFlag("studio.nle.captions.track", true);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const menuId = useId();
  const sizes = useTrackSizes(editor.project.project_id);
  const gestures = useTimelineGesture(editor, scrollerRef, { zoom, headerWidth, behaviour: compact ? "rearrange" : "edit" });
  // Sources and effects are dropped on the full timeline only: the compact one rearranges what is already there
  const sourceDrop = useSourceDrop(editor, scrollerRef, { zoom, headerWidth });
  const effectDrop = useEffectDrop(editor, scrollerRef, { zoom, headerWidth });
  const drop = compact ? null : sourceDrop.preview;
  const effect = compact ? null : effectDrop.preview;
  const guide = gestures.preview?.guide ?? drop?.guide ?? null;
  // Thumbnails that are not captured yet wait while a gesture or a drop needs the frames
  const busy = gestures.preview !== null || drop !== null || effect !== null;

  const tracks = orderedTracks(timeline);
  const selected = new Set(selectClips(timeline, editor.selected, editor.linked).map((clip) => clip.clip_id));
  const shorter = new Set(editor.shorterTakes.map((item) => item.sourceId));
  const rendering = new Set(editor.project.shots.filter((shot) => shot.takes.some((take) => take.state === "rendering")).map((shot) => shot.shot_id));
  const graphWidth = Math.max(1, viewport, Math.min(MAX_TIMELINE_FRAMES, totalFrames + Math.round(fps * 10)) * zoom);
  const rearranging = gestures.preview?.mode === "rearrange" && gestures.preview.timeline !== null;
  // While a rearrange is previewed the clips are drawn where they would land and slide there
  const shown = rearranging && gestures.preview?.timeline ? gestures.preview.timeline : timeline;
  const ghosts = rearranging
    ? []
    : (gestures.preview?.timeline?.clips.filter((clip) => {
        const original = timeline.clips.find((item) => item.clip_id === clip.clip_id);
        return original !== undefined && (clip.track_id !== original.track_id || clip.start_frame !== original.start_frame || clip.in_frame !== original.in_frame || clip.out_frame !== original.out_frame || clipDuration(clip) !== clipDuration(original));
      }) ?? []);
  const dimmed = new Set(ghosts.map((clip) => clip.clip_id));

  // The view is shared with the other workspace's timeline: start where it was left
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (node) node.scrollLeft = view.getScroll();
  }, [view]);
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node || !anchorRef.current) return;
    node.scrollLeft = Math.max(0, anchorRef.current.frame * zoom - anchorRef.current.x);
    anchorRef.current = null;
  }, [zoom]);

  /** Zoom keeping the frame under `x` (px from the left edge of the clips; default: the middle of the view) in place. */
  const setZoom = (next: number, x = viewport / 2) => {
    gestures.cancel();
    const current = scrollerRef.current?.scrollLeft ?? scrollLeft;
    anchorRef.current = { frame: (current + x) / zoom, x };
    view.setZoom(next);
  };
  const fit = () => {
    gestures.cancel();
    anchorRef.current = { frame: 0, x: 0 };
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.max(1, viewport - 32) / Math.max(Math.round(fps * 5), totalFrames)));
    if (next === zoom && scrollerRef.current) scrollerRef.current.scrollLeft = 0;
    view.setZoom(next);
  };
  const wheel = useEffectEvent((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault();
    const node = scrollerRef.current;
    if (node) setZoom(zoom * Math.exp(-event.deltaY * 0.005), Math.max(0, event.clientX - node.getBoundingClientRect().left - headerWidth));
  });
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const listener = (event: WheelEvent) => { wheel(event); };
    node.addEventListener("wheel", listener, { passive: false });
    return () => { node.removeEventListener("wheel", listener); };
  }, []);
  // The key map's fit and zoom commands reach whichever timeline is mounted
  const zoomRequest = useEffectEvent((event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
    const kind: string = event.detail;
    if (kind === "fit") fit();
    else setZoom(kind === "in" ? zoom * 1.5 : zoom / 1.5);
  });
  useEffect(() => {
    const listener = (event: Event) => { zoomRequest(event); };
    window.addEventListener(TIMELINE_ZOOM_EVENT, listener);
    return () => { window.removeEventListener(TIMELINE_ZOOM_EVENT, listener); };
  }, []);

  const openMenu = (event: MouseEvent<HTMLElement>, label: string, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const point = event.type === "contextmenu" && event.clientX + event.clientY > 0;
    setMenu({ label, items, anchor: point ? { kind: "point", x: event.clientX, y: event.clientY } : { kind: "element", element: event.currentTarget }, returnFocus: event.currentTarget });
  };
  const frameAtX = (clientX: number) => Math.max(0, Math.round((clientX - (scrollerRef.current?.getBoundingClientRect().left ?? 0) - headerWidth + (scrollerRef.current?.scrollLeft ?? 0)) / zoom));

  const rowHeight = (track: TimelineTrack) => (compact ? TRACK_HEIGHTS.s : TRACK_HEIGHTS[sizes.of(track.track_id)]);
  const cursor = compact ? "cursor-grab active:cursor-grabbing" : TOOL_CURSOR[editor.tool];
  const showCaptions = !compact && captionsShown && timeline.captions.length > 0;

  return (
    <section /* eslint-disable-line jsx-a11y-x/no-noninteractive-element-interactions -- The timeline container observes its child controls to track the active editing panel. */
      data-editor-panel="timeline"
      data-keep-focus=""
      aria-label={t("時間軸")}
      className={cn(PANEL, !collapsed && "h-full", editor.focus.panel === "timeline" && !compact && "border-brand-cyan/70", className)}
      onPointerDownCapture={() => { editor.focus.setPanel("timeline"); }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || !gestures.cancel()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {compact ? (
        <CompactTimelineHeader editor={editor} zoom={zoom} onZoom={setZoom} onFit={fit} actions={actions} />
      ) : (
        <TimelineHeader editor={editor} zoom={zoom} onZoom={setZoom} onFit={fit} captionsShown={captionsShown} onToggleCaptions={() => { setCaptionsShown(!captionsShown); }} trackSize={sizes.base} onTrackSize={sizes.setBase} />
      )}
      <div
        ref={scrollerRef}
        hidden={collapsed}
        className={cn("relative min-h-0 flex-1 overflow-auto overscroll-contain bg-sunken [scrollbar-width:thin]", collapsed && "hidden")}
        {...(compact ? {} : bothDrops(sourceDrop.handlers, effectDrop.handlers))}
        onScroll={(event) => {
          setScrollLeft(event.currentTarget.scrollLeft);
          view.setScroll(event.currentTarget.scrollLeft);
        }}
      >
        <div className="relative" style={{ width: headerWidth + graphWidth, minHeight: "100%" }}>
          <div className="sticky top-0 z-30 flex border-b border-line-strong bg-surface" style={{ height: RULER_HEIGHT }}>
            <div className="sticky left-0 z-40 shrink-0 border-r border-line-strong bg-surface" style={{ width: headerWidth }} />
            <TimelineRuler
              timeline={timeline}
              playhead={playhead}
              fps={fps}
              zoom={zoom}
              width={graphWidth}
              scrollLeft={scrollLeft}
              viewport={viewport}
              onSeek={(frame) => { transport.seek(frame); }}
              onStep={(frames) => { transport.step(frames); }}
              {...(compact ? {} : { onMarkerMove: (marker, frame) => void editor.commit({ ...timeline, markers: timeline.markers.map((item) => (item.marker_id === marker.marker_id ? { ...item, frame } : item)) }) })}
              {...(compact ? {} : { onContextMenu: (event) => { openMenu(event, t("時間尺的動作"), rulerMenu(editor)); } })}
            />
          </div>
          {showCaptions ? <CaptionTrack editor={editor} zoom={zoom} width={graphWidth} headerWidth={headerWidth} /> : null}
          {tracks.map((track) => {
            const height = rowHeight(track);
            const label = trackLabel(track, timeline.tracks);
            const ordered = trackClips(shown, track.track_id);
            return (
              <div key={track.track_id} data-timeline-track={track.track_id} className={cn("relative flex border-b border-line-subtle", track.kind === "audio" && "bg-brand-cyan/[0.03]")} style={{ height }}>
                {compact ? (
                  <CompactTrackHeader track={track} label={label} width={headerWidth} height={height} />
                ) : (
                  <TrackHeader
                    key={renaming === track.track_id ? "rename" : "idle"}
                    track={track}
                    label={label}
                    editor={editor}
                    width={headerWidth}
                    size={sizes.of(track.track_id)}
                    startRenaming={renaming === track.track_id}
                    onRenamed={() => { setRenaming(null); }}
                    onResize={(size) => { sizes.setTrack(track.track_id, size); }}
                    onMenu={(event) => { openMenu(event, t("{name} 的軌道選單", { name: track.name }), trackMenu(editor, track, () => { setRenaming(track.track_id); })); }}
                  />
                )}
                <div
                  className="relative shrink-0"
                  style={{ width: graphWidth }}
                  onPointerDown={(event) => {
                    if (event.button === 0 && event.target === event.currentTarget) editor.setSelected([]);
                  }}
                  onContextMenu={compact ? undefined : (event) => { if (event.target === event.currentTarget) { openMenu(event, t("時間軸的動作"), gapMenu(editor, frameAtX(event.clientX))); } }}
                >
                  {ordered.map((clip, index) => {
                    const previous = ordered[index - 1];
                    const next = ordered[index + 1];
                    // The bar runs from cut to cut: what the clip lends a transition beyond its cut lies under it
                    const into = previous ? activeTransition(previous.effects) : null;
                    const own = next ? activeTransition(clip.effects) : null;
                    const source = timeline.sources.find((item) => item.source_id === clip.source_id);
                    return (
                      <ClipBar
                        key={clip.clip_id}
                        clip={clip}
                        track={track}
                        source={source}
                        fps={fps}
                        zoom={zoom}
                        height={height}
                        headCut={into ? cutOf(into).incoming.frames : 0}
                        tailCut={own ? cutOf(own).outgoing.frames : 0}
                        incomingFrames={into?.frames ?? 0}
                        selected={selected.has(clip.clip_id)}
                        dimmed={dimmed.has(clip.clip_id)}
                        sliding={rearranging}
                        shorterTake={shorter.has(clip.source_id)}
                        rendering={source?.shot_id !== undefined && rendering.has(source.shot_id)}
                        editable={!compact}
                        busy={busy}
                        cursor={track.locked ? "cursor-not-allowed" : cursor}
                        viewStart={scrollLeft}
                        gestures={gestures}
                        onSelect={(extend) => { editor.select(clip.clip_id, extend); }}
                        {...(compact ? {} : { onContextMenu: (event) => {
                          if (!selected.has(clip.clip_id)) editor.select(clip.clip_id);
                          openMenu(event, t("「{name}」的動作", { name: clip.name }), clipMenu(editor, clip));
                        } })}
                      />
                    );
                  })}
                  {ordered.map((clip, index) => {
                    const next = ordered[index + 1];
                    const transition = next ? activeTransition(clip.effects) : null;
                    if (!transition || !next) return null;
                    const repeated = repeatedFrames(clip, next, transition);
                    return (
                      <TransitionObject
                        key={`transition-${clip.clip_id}`}
                        clip={clip}
                        transition={transition}
                        zoom={zoom}
                        height={height}
                        selected={editor.selectedTransition === clip.clip_id}
                        editable={!compact && !track.locked}
                        lacking={repeated.outgoing + repeated.incoming > 0}
                        onSelect={() => { editor.selectTransition(clip.clip_id); }}
                        onResize={(frames) => void editor.command({ type: "transition", clipId: clip.clip_id, kind: transition.kind, frames: Math.max(1, transition.frames + frames), linked: editor.linked })}
                        {...(compact ? {} : { onContextMenu: (event) => { openMenu(event, t("轉場的動作"), transitionMenu(editor, clip)); } })}
                      />
                    );
                  })}
                  {ghosts
                    .filter((clip) => clip.track_id === track.track_id)
                    .map((clip) => (
                      <span
                        key={`preview-${clip.clip_id}`}
                        className="pointer-events-none absolute inset-y-[3px] z-20 overflow-hidden rounded-[5px] border-2 border-brand-cyan bg-raised/90 px-1.5 text-caption leading-5 text-fg"
                        style={{ left: clip.start_frame * zoom, width: Math.max(2, clipDuration(clip) * zoom) }}
                      >
                        {clip.name}
                      </span>
                    ))}
                  {(gestures.preview?.error != null && gestures.preview.error !== "") && gestures.preview.trackId === track.track_id ? (
                    <span className="pointer-events-none absolute inset-y-[3px] z-20 rounded-[5px] border-2 border-danger bg-danger/15" style={{ left: Math.max(0, gestures.preview.start * zoom), width: Math.max(2, gestures.preview.length * zoom) }} />
                  ) : null}
                  {drop && drop.length > 0 && drop.trackIds.includes(track.track_id) ? (
                    <span
                      className={cn(
                        "pointer-events-none absolute inset-y-[3px] z-20 overflow-hidden rounded-[5px] border-2 px-1.5 text-caption leading-5 text-fg",
                        (drop.error != null && drop.error !== "") ? "border-danger bg-danger/15" : "border-brand-cyan bg-raised/90",
                      )}
                      style={{ left: drop.start * zoom, width: Math.max(2, drop.length * zoom) }}
                    >
                      {drop.name}
                    </span>
                  ) : null}
                  {drop?.mode === "insert" && !(drop.error != null && drop.error !== "") ? (
                    <span className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-px bg-brand-cyan" style={{ left: drop.start * zoom }} />
                  ) : null}
                  <EffectDropMarks effect={effect} trackId={track.track_id} zoom={zoom} />
                  {guide !== null ? <span className="pointer-events-none absolute inset-y-0 z-20 border-l border-dashed border-warning" style={{ left: guide * zoom }} /> : null}
                </div>
              </div>
            );
          })}
          <Playhead playhead={playhead} zoom={zoom} offset={headerWidth} scrollerRef={scrollerRef} />
        </div>
        {timeline.clips.length === 0 && !(problem != null && problem !== "") ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 grid place-items-center overflow-hidden" style={{ top: RULER_HEIGHT, left: headerWidth }}>
            <EmptyState
              size="compact"
              scene={!compact}
              mark
              title={t("時間軸是空的")}
              description={compact ? t("新增鏡頭後，它會排在這裡。") : t("到「鏡頭」新增鏡頭，或從「專案」面板把素材插入時間軸。")}
              className="pointer-events-auto"
            />
          </div>
        ) : null}
        {(problem != null && problem !== "") ? (
          <p role="alert" className="pointer-events-none absolute inset-x-0 top-10 mx-auto flex w-fit max-w-[80%] items-start gap-2 rounded-lg border border-warning/40 bg-surface px-3 py-2 text-data text-warning">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {problem}
          </p>
        ) : null}
      </div>
      <div className={cn("flex shrink-0 items-center border-t border-line-subtle", collapsed && "hidden")}>
        <div className="min-w-0 flex-1" style={{ paddingLeft: headerWidth - 8 }}>
          <ZoomScrollBar
            content={graphWidth}
            viewport={viewport}
            scrollLeft={scrollLeft}
            zoom={zoom}
            onScroll={(left) => {
              if (scrollerRef.current) scrollerRef.current.scrollLeft = Math.max(0, left);
            }}
            onZoom={(next, firstFrame) => {
              gestures.cancel();
              anchorRef.current = { frame: firstFrame, x: 0 };
              view.setZoom(next);
            }}
          />
        </div>
        <TimelineStatus gestureError={gestures.preview?.error ?? null} drop={drop} effect={effect} totalFrames={totalFrames} fps={fps} />
      </div>
      {menu ? <ActionMenu id={menuId} label={menu.label} items={menu.items} anchor={menu.anchor} returnFocus={menu.returnFocus} onClose={() => { setMenu(null); }} /> : null}
    </section>
  );
}
