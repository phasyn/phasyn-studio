// The header row of the timeline (40 px). Full timeline: the sequence timecode (click to type), snapping, linked
// selection, add marker, caption track, then zoom, fit and the track-height menu. Compact timeline (Shots workspace):
// transport, timecode and zoom, with the caller's actions (open in Edit, collapse) at the right end.
import { Captions, Flag, Link2, Magnet, Maximize2, Pause, Play, Rows3, SkipBack, ZoomIn, ZoomOut } from "lucide-react";
import { useState, type ReactNode } from "react";
import { TOOL_BUTTON, TOOL_BUTTON_ON } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { usePlayheadFrame, usePlaying } from "../../hooks/playhead";
import { formatDuration, formatTimecode, parseTimecode } from "../../model/frames";
import type { Editor } from "../editorContext";
import { MAX_ZOOM, MIN_ZOOM, TRACK_SIZES, type TrackSize } from "../timelineGeometry";

/** The playhead position; click (or Enter) to type a frame, a timecode or a relative move. */
export function TimecodeField({ editor, className }: { editor: Editor; className?: string }) {
  const frame = usePlayheadFrame(editor.playhead);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const next = draft === null ? null : parseTimecode(draft, editor.fps, frame);
    if (next !== null) editor.transport.seek(next);
    setDraft(null);
  };
  if (draft !== null) {
    return (
      <input
        autoFocus
        value={draft}
        aria-label={t("播放頭位置（影格或時間碼）")}
        // The whole value is selected when the field opens, so what is typed replaces it
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(null);
        }}
        className={cn("machine h-7 w-28 rounded-md border border-focus bg-sunken px-1.5 text-body text-brand-cyan outline-none", className)}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setDraft(formatTimecode(frame, editor.fps))}
      title={t("播放頭位置：按一下輸入影格、時間碼或 +／− 位移")}
      aria-label={t("播放頭位置 {time}", { time: formatTimecode(frame, editor.fps) })}
      className={cn("machine h-7 rounded-md px-1.5 text-body text-brand-cyan transition-colors duration-(--duration-fast) hover:bg-raised", className)}
    >
      {formatTimecode(frame, editor.fps)}
    </button>
  );
}

function ZoomControls({ zoom, onZoom, onFit }: { zoom: number; onZoom: (zoom: number) => void; onFit: () => void }) {
  const position = Math.round((Math.log(zoom / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 100);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button type="button" className={TOOL_BUTTON} aria-label={t("縮小時間軸")} title={t("縮小時間軸（-）")} disabled={zoom <= MIN_ZOOM} onClick={() => onZoom(zoom / 1.5)}>
        <ZoomOut aria-hidden />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={position}
        onChange={(event) => onZoom(MIN_ZOOM * (MAX_ZOOM / MIN_ZOOM) ** (Number(event.target.value) / 100))}
        className="w-24 accent-playhead"
        aria-label={t("時間軸縮放")}
        aria-valuetext={t("每影格 {px} px", { px: zoom.toFixed(2) })}
      />
      <button type="button" className={TOOL_BUTTON} aria-label={t("放大時間軸")} title={t("放大時間軸（=）")} disabled={zoom >= MAX_ZOOM} onClick={() => onZoom(zoom * 1.5)}>
        <ZoomIn aria-hidden />
      </button>
      <button type="button" className={TOOL_BUTTON} aria-label={t("適合寬度")} title={t("適合寬度（\\）")} onClick={onFit}>
        <Maximize2 aria-hidden />
      </button>
    </div>
  );
}

const SIZE_LABEL: Record<TrackSize, string> = { s: "S", m: "M", l: "L" };

export interface TimelineHeaderProps {
  editor: Editor;
  zoom: number;
  onZoom: (zoom: number) => void;
  onFit: () => void;
  captionsShown: boolean;
  onToggleCaptions: () => void;
  trackSize: TrackSize;
  onTrackSize: (size: TrackSize) => void;
}

export function TimelineHeader({ editor, zoom, onZoom, onFit, captionsShown, onToggleCaptions, trackSize, onTrackSize }: TimelineHeaderProps) {
  const toggle = (on: boolean) => cn(TOOL_BUTTON, "size-8 [&_svg]:size-4", on && TOOL_BUTTON_ON);
  return (
    <div data-keep-focus="" className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line-subtle px-2">
      <TimecodeField editor={editor} />
      <span aria-hidden className="mx-1 h-5 w-px bg-line-subtle" />
      <button type="button" className={toggle(editor.snapping)} aria-pressed={editor.snapping} aria-label={t("靠齊")} title={t("靠齊（S）")} onClick={() => editor.setSnapping(!editor.snapping)}>
        <Magnet aria-hidden />
      </button>
      <button type="button" className={toggle(editor.linked)} aria-pressed={editor.linked} aria-label={t("連結的選取範圍")} title={t("連結的選取範圍")} onClick={() => editor.setLinked(!editor.linked)}>
        <Link2 aria-hidden />
      </button>
      <button type="button" className={toggle(false)} aria-label={t("新增標記")} title={t("新增標記（M）")} onClick={() => editor.addMarker()}>
        <Flag aria-hidden />
      </button>
      <button type="button" className={toggle(captionsShown)} aria-pressed={captionsShown} aria-label={t("字幕軌顯示")} title={t("字幕軌顯示")} onClick={onToggleCaptions}>
        <Captions aria-hidden />
      </button>
      <div className="ml-auto flex items-center gap-2">
        <ZoomControls zoom={zoom} onZoom={onZoom} onFit={onFit} />
        <span aria-hidden className="h-5 w-px bg-line-subtle" />
        <div role="radiogroup" aria-label={t("軌道高度")} className="flex items-center gap-0.5" title={t("軌道高度")}>
          <Rows3 aria-hidden className="mr-0.5 size-4 text-fg-tertiary" />
          {TRACK_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              role="radio"
              aria-checked={trackSize === size}
              aria-label={t("軌道高度 {size}", { size: SIZE_LABEL[size] })}
              onClick={() => onTrackSize(size)}
              className={cn("pressable grid size-7 place-items-center rounded-md font-mono text-caption", trackSize === size ? "bg-brand-gradient-soft text-fg ring-1 ring-brand-blue/50 ring-inset" : "text-fg-tertiary hover:bg-raised hover:text-fg")}
            >
              {SIZE_LABEL[size]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CompactTimelineHeader({ editor, zoom, onZoom, onFit, actions }: { editor: Editor; zoom: number; onZoom: (zoom: number) => void; onFit: () => void; actions?: ReactNode }) {
  const playing = usePlaying(editor.playhead);
  const { transport, timeline, totalFrames, fps } = editor;
  return (
    <div data-keep-focus="" className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line-subtle px-2">
      <button type="button" className={cn(TOOL_BUTTON, "size-8 [&_svg]:size-4")} aria-label={t("回到序列開頭")} title={t("回到序列開頭（Home）")} onClick={() => transport.seek(0)}>
        <SkipBack aria-hidden />
      </button>
      <button
        type="button"
        className={cn(TOOL_BUTTON, "size-8 [&_svg]:size-4", playing && TOOL_BUTTON_ON)}
        aria-pressed={playing}
        aria-label={playing ? t("暫停") : t("播放序列")}
        title={playing ? t("暫停（空白鍵）") : t("播放序列（空白鍵）")}
        disabled={totalFrames === 0}
        onClick={() => transport.toggle()}
      >
        {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
      </button>
      <TimecodeField editor={editor} />
      <span className="machine min-w-0 truncate text-caption text-fg-tertiary">
        {t("{clips} 個片段・{duration}", { clips: timeline.clips.length, duration: formatDuration(totalFrames, fps) })}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ZoomControls zoom={zoom} onZoom={onZoom} onFit={onFit} />
        {actions}
      </div>
    </div>
  );
}
