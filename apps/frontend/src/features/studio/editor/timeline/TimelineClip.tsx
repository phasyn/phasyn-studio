// A clip on a timeline track, and the transition object on a cut. A clip shows its name, what is applied to it (fx,
// speed), its waveform when it is sound or its head thumbnail when it is a picture on a medium or large track, and its
// state: selected (cyan frame, linked partners together), placeholder of an unrendered shot (hatched, planned length),
// a newer take that is too short, switched off. A text layer is violet; an adjustment layer is rose with an 「調整」
// badge (it has no picture of its own: its effects change everything below it). A shot's clip on the full timeline
// hosts the 修正 menu its context menu opens (修正…) and keeps finished fix runs coming back while the Edit page is open.
import { Hourglass, Music2, SlidersHorizontal, Sparkles, TriangleAlert, Type } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import type { TimelineClip as Clip, TimelineSource, TimelineTrack } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { SHIMMER } from "@/components/ui/look";
import { Waveform } from "../../components/MediaWaveform";
import { ClipFixHost, FixRunWatcher } from "../../fix";
import { TRANSITION_LABELS, type Transition } from "../../model/clipEffects";
import { formatDuration, formatTimecode } from "../../model/frames";
import { clipDuration, clipEnabled, windowBounds } from "../model";
import { TRACK_HEIGHTS } from "../timelineGeometry";
import { cutOf } from "../transitionCut";
import { ClipThumbnail } from "./ClipThumbnail";
import type { TimelineGestures } from "./useTimelineGesture";

/** Whether anything beyond a plain cut is applied to the clip (the "fx" badge). */
function hasEffects(clip: Clip): boolean {
  const fx = clip.effects;
  const legacy = fx !== undefined && (fx.color !== undefined || fx.camera !== undefined || fx.impact !== undefined || fx.fade !== undefined || fx.hold !== undefined || (fx.frame_step ?? 1) !== 1);
  const motion = clip.motion;
  const moved = motion.x !== 0 || motion.y !== 0 || motion.scale !== 1 || motion.rotation !== 0 || motion.opacity !== 1 || Object.values(motion.keyframes).some((keys) => keys.length > 0);
  return legacy || moved || (clip.effect_stack?.length ?? 0) > 0 || clip.mask !== undefined || (clip.blend_mode ?? "normal") !== "normal";
}

const HATCH = "bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.07)_0_6px,transparent_6px_12px)]";

export interface ClipBarProps {
  clip: Clip;
  track: TimelineTrack;
  source: TimelineSource | undefined;
  fps: number;
  zoom: number;
  /** Row height in px. */
  height: number;
  /**
   * Frames of the clip before the cut of the transition into it and after the cut of its own transition: the bar is
   * drawn from cut to cut, what the clip lends beyond the cuts lies under the transitions.
   */
  headCut: number;
  tailCut: number;
  /** Length of the transition into the clip (0 without one): its object covers the start of the bar. */
  incomingFrames: number;
  selected: boolean;
  /** Dimmed while a gesture previews this clip somewhere else. */
  dimmed: boolean;
  /** Slides to its new place (while a rearrange is previewed). */
  sliding: boolean;
  /** The shot's active take is shorter than this clip uses. */
  shorterTake: boolean;
  /** The clip's shot is being rendered right now. */
  rendering: boolean;
  /** Trim handles, the context menu and head thumbnails (full timeline); the compact timeline only selects and rearranges. */
  editable: boolean;
  /** A gesture or a drop is under way: thumbnails that are not captured yet wait. */
  busy: boolean;
  cursor: string;
  /** The track lane's x (px) at the visible left edge (the timeline's scroll): a clip that starts left of it keeps its name in view. */
  viewStart: number;
  gestures: TimelineGestures;
  onSelect: (extend: boolean) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}

export function ClipBar(props: ClipBarProps) {
  const { clip, track, source, fps, zoom, height, headCut, tailCut, incomingFrames, selected, dimmed, sliding, shorterTake, rendering, editable, busy, cursor, viewStart, gestures, onSelect, onContextMenu } = props;
  const duration = clipDuration(clip);
  const left = (clip.start_frame + headCut) * zoom;
  const width = Math.max(2, (duration - headCut - tailCut) * zoom);
  const audio = track.kind === "audio";
  const text = source?.kind === "text";
  const adjustment = source?.kind === "adjustment";
  const pending = !text && !adjustment && !source?.file;
  const speed = clip.effects?.speed_percent ?? 100;
  const audioZoom = (zoom * 100) / speed;
  const roomy = height >= 56;
  const place = { name: clip.name, start: formatTimecode(clip.start_frame, fps), duration: formatTimecode(duration, fps) };
  const label = adjustment ? t("調整圖層「{name}」，起點 {start}，長度 {duration}", place) : t("{name}，起點 {start}，長度 {duration}", place);
  const begin = (event: PointerEvent<HTMLElement>, edge?: "in" | "out") => { gestures.begin(event, clip, edge); };
  const waveformHeight = Math.max(0, height - (roomy ? 30 : 12));
  // From the medium height up a picture shows the frame it starts with under its name (the bar's border and the name row take 32 px)
  const picture = !audio && (source?.kind === "video" || source?.kind === "image") && source.file !== null;
  const thumbnail = editable && picture && height >= TRACK_HEIGHTS.m ? source : null;
  // The transition object into the clip is centred on its overlap and at least 10 px wide: the name starts after it
  const nameInset = incomingFrames > 0 ? Math.max(0, (clip.start_frame + incomingFrames / 2) * zoom + Math.max(10, incomingFrames * zoom) / 2 - left) : 0;
  // A clip that starts left of the visible area keeps its name at the visible left edge (as long as 48 px of it show)
  const nameShift = Math.max(nameInset, Math.min(viewStart - left, width - 48));
  return (
    <div className={cn("absolute inset-y-[3px]", sliding && "transition-[left] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)")} style={{ left, width }}>
      <div
        role="button"
        tabIndex={0}
        data-editor-clip={clip.clip_id}
        aria-label={label}
        aria-pressed={selected}
        title={pending ? t("{name}：等待素材，先以計畫長度 {duration} 佔位", { name: clip.name, duration: formatDuration(duration, fps) }) : label}
        onPointerDown={(event) => { begin(event); }}
        {...gestures.handlers}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onSelect(event.shiftKey);
        }}
        onContextMenu={onContextMenu}
        className={cn(
          "relative size-full touch-none overflow-hidden rounded-[5px] border text-caption text-fg outline-none transition-[border-color,opacity,box-shadow] duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-focus",
          cursor,
          adjustment
            ? "border-clip-adjust-edge/55 bg-clip-adjust"
            : text
              ? "border-brand-violet/60 bg-brand-violet/25"
              : audio
                ? "border-clip-audio-edge/55 bg-clip-audio"
                : "border-clip-video-edge/55 bg-clip-video",
          pending && cn(HATCH, "border-dashed"),
          selected && "border-brand-cyan ring-2 ring-brand-cyan",
          (track.muted || dimmed || !clipEnabled(clip)) && "opacity-45",
        )}
      >
        {audio && source?.file && waveformHeight > 0 ? (
          <div className="pointer-events-none absolute bottom-0.5 overflow-hidden opacity-80" style={{ left: ((clip.effects?.hold?.start ?? 0) - windowBounds(clip).start_frame - headCut) * zoom, width: (clip.out_frame - clip.in_frame) * audioZoom, height: waveformHeight }}>
            <Waveform url={mediaUrl(source.file.node_id, source.file.file_id)} fullWidth={source.duration_frames * audioZoom} offset={clip.in_frame * audioZoom} height={waveformHeight} />
          </div>
        ) : null}
        {thumbnail ? <ClipThumbnail clip={clip} source={thumbnail} fps={fps} height={height - 32} left={nameInset + 2} paused={busy} /> : null}
        <span className="pointer-events-none relative flex min-w-0 items-center gap-1 px-1.5 pt-0.5 leading-5" style={nameShift > 0 ? { paddingLeft: nameShift + 6 } : undefined}>
          {adjustment ? (
            <SlidersHorizontal aria-hidden className="size-3 shrink-0 text-clip-adjust-edge" />
          ) : text ? (
            <Type aria-hidden className="size-3 shrink-0 text-brand-violet" />
          ) : audio ? (
            <Music2 aria-hidden className="size-3 shrink-0 text-clip-audio-edge" />
          ) : null}
          <span className="truncate font-medium">{clip.name}</span>
          {adjustment ? (
            <span className="shrink-0 rounded-sm bg-clip-adjust-edge/20 px-1 text-[11px] leading-4 font-medium text-clip-adjust-edge">{t("調整")}</span>
          ) : null}
          {shorterTake ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-warning/20 px-1 text-[11px] leading-4 text-warning">
              <TriangleAlert aria-hidden className="size-3" />
              {t("新 take 較短")}
            </span>
          ) : null}
          {speed !== 100 ? <span className="machine shrink-0 rounded-sm bg-white/10 px-1 text-[11px] leading-4 text-fg-secondary">{speed}%</span> : null}
          {!audio && hasEffects(clip) ? (
            <span className="inline-flex shrink-0 items-center rounded-sm bg-white/10 px-1 text-[11px] leading-4 text-fg-secondary" title={t("已套用效果")}>
              <Sparkles aria-hidden className="mr-0.5 size-2.5" />
              fx
            </span>
          ) : null}
        </span>
        {roomy && pending ? (
          <span className="pointer-events-none relative block truncate px-1.5 text-[11px] leading-4 text-fg-secondary">
            {rendering ? t("渲染中・{duration}", { duration: formatDuration(duration, fps) }) : t("尚未渲染・{duration}", { duration: formatDuration(duration, fps) })}
          </span>
        ) : null}
        {rendering ? <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-brand-gradient", SHIMMER)} /> : null}
      </div>
      {editable && selected && !track.locked
        ? (["in", "out"] as const).map((edge) => (
            <button
              key={edge}
              type="button"
              tabIndex={-1}
              aria-label={edge === "in" ? t("修剪 {name} 的入點", { name: clip.name }) : t("修剪 {name} 的出點", { name: clip.name })}
              className={cn(
                "absolute inset-y-0 z-10 w-1.5 touch-none cursor-ew-resize rounded-[3px] bg-brand-cyan/70 transition-colors duration-(--duration-fast) hover:bg-brand-cyan",
                edge === "in" ? "left-0" : "right-0",
              )}
              onPointerDown={(event) => { begin(event, edge); }}
              {...gestures.handlers}
            />
          ))
        : null}
      {editable && (source?.shot_id != null || source?.candidate_origin?.shot_id != null) ? (
        <>
          <ClipFixHost clipId={clip.clip_id} />
          <FixRunWatcher />
        </>
      ) : null}
    </div>
  );
}

/** Diagonal warning stripes: the transition repeats frames because a clip ran out of media (Premiere marks it so). */
const LACKING = "bg-raised bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,var(--color-warning)_45%,transparent)_0_3px,transparent_3px_7px)]";

/**
 * The transition on a cut: a bar across the overlap of the two clips with a mark where the cut is, selectable; its
 * edges change the duration (a centred transition grows on both sides of the cut). Striped while it repeats frames.
 */
export function TransitionObject({
  clip,
  transition,
  zoom,
  height,
  selected,
  editable,
  lacking,
  onSelect,
  onResize,
  onContextMenu,
}: {
  /** The outgoing clip (it carries the transition). */
  clip: Clip;
  transition: Transition;
  zoom: number;
  height: number;
  selected: boolean;
  editable: boolean;
  /** A clip repeats its edge frame inside the transition (insufficient media). */
  lacking: boolean;
  onSelect: () => void;
  /** Dragging an edge by `frames` (positive = longer); committed on release. */
  onResize: (frames: number) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const end = clip.start_frame + clipDuration(clip);
  const width = Math.max(10, transition.frames * zoom);
  const left = (end - transition.frames / 2) * zoom - width / 2;
  const cut = cutOf(transition);
  // Where the cut lies in the bar (the bar may be wider than the overlap at a small zoom)
  const cutAt = Math.max(0, Math.min(width, (cut.incoming.frames - transition.frames / 2) * zoom + width / 2));
  const name = TRANSITION_LABELS[transition.kind];
  const label = lacking ? t("{name}，{frames} 影格，素材不足（重複影格）", { name, frames: transition.frames }) : t("{name}，{frames} 影格", { name, frames: transition.frames });
  const band = Math.min(22, height - 14);
  const drag = (event: PointerEvent<HTMLElement>, direction: -1 | 1) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = event.clientX;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const up = (done: globalThis.PointerEvent) => {
      target.removeEventListener("pointerup", up);
      const frames = Math.round(((done.clientX - origin) * direction * (cut.alignment === "center" ? 2 : 1)) / zoom);
      if (frames !== 0) onResize(frames);
    };
    target.addEventListener("pointerup", up);
  };
  return (
    <div className="absolute z-[12]" style={{ left, width, top: (height - band) / 2, height: band }}>
      <button
        type="button"
        data-editor-transition={clip.clip_id}
        aria-pressed={selected}
        aria-label={label}
        title={label}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        className={cn(
          "relative flex size-full items-center justify-center gap-1 overflow-hidden rounded-md border px-1 text-[11px] leading-4 text-fg transition-[border-color,box-shadow] duration-(--duration-fast)",
          lacking ? LACKING : "bg-raised",
          selected ? "border-brand-cyan ring-2 ring-brand-cyan" : lacking ? "border-warning hover:border-brand-cyan/70" : "border-line-control hover:border-brand-cyan/70",
        )}
      >
        <span aria-hidden className="pointer-events-none absolute inset-y-0.5 w-px bg-fg/60" style={{ left: cutAt }} />
        {lacking ? <TriangleAlert aria-hidden className="relative size-3 shrink-0 text-warning" /> : <Hourglass aria-hidden className="relative size-3 shrink-0 text-brand-cyan" />}
        {width >= 84 ? <span className="relative truncate">{name}</span> : null}
      </button>
      {editable && selected
        ? ([-1, 1] as const).map((direction) => (
            <span
              key={direction}
              aria-hidden
              onPointerDown={(event) => { drag(event, direction); }}
              className={cn("absolute inset-y-0 w-1.5 touch-none cursor-ew-resize rounded-sm bg-brand-cyan/70 hover:bg-brand-cyan", direction < 0 ? "-left-0.5" : "-right-0.5")}
            />
          ))
        : null}
    </div>
  );
}
