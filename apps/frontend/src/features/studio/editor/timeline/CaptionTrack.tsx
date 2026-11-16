// The caption track above the video tracks (when 字幕軌顯示 is on): one segment per caption. A segment shares its
// selection with the Captions panel, as in Premiere: choosing it selects that caption (the panel's row scrolls into
// view) and moves the playhead to it, and Delete then removes it wherever the keyboard is outside a list or a field.
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatTimecode } from "../../model/frames";
import type { Editor } from "../editorContext";
import { CAPTION_TRACK_HEIGHT } from "../timelineGeometry";

export interface CaptionTrackProps {
  editor: Editor;
  /** Pixels per frame. */
  zoom: number;
  /** Width of the drawn sequence, in px. */
  width: number;
  /** Width of the sticky header column. */
  headerWidth: number;
}

export function CaptionTrack({ editor, zoom, width, headerWidth }: CaptionTrackProps) {
  const { timeline, fps, transport } = editor;
  return (
    <div className="relative flex border-b border-line-subtle" style={{ height: CAPTION_TRACK_HEIGHT }}>
      <div className="sticky left-0 z-20 flex shrink-0 items-center border-r border-line-strong bg-surface px-2 text-caption text-fg-tertiary" style={{ width: headerWidth }}>
        {t("字幕")}
      </div>
      <div className="relative shrink-0" style={{ width }}>
        {timeline.captions.map((caption) => {
          const selected = editor.selectedCaption === caption.caption_id;
          const range = t("{start} – {end}", { start: formatTimecode(caption.start_frame, fps), end: formatTimecode(caption.end_frame, fps) });
          return (
            <button
              key={caption.caption_id}
              type="button"
              data-caption-segment={caption.caption_id}
              aria-pressed={selected}
              aria-label={t("字幕「{text}」，{range}", { text: caption.text, range })}
              title={caption.text}
              onClick={() => {
                editor.selectCaption(caption.caption_id);
                transport.seek(caption.start_frame);
              }}
              className={cn(
                "absolute inset-y-1 truncate rounded-[4px] border px-1.5 text-left text-[11px] leading-4 text-fg outline-none transition-[border-color,background-color,box-shadow] duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-focus",
                selected ? "border-brand-cyan bg-warning/25 ring-2 ring-brand-cyan" : "border-warning/45 bg-warning/15 hover:border-warning/80",
              )}
              style={{ left: caption.start_frame * zoom, width: Math.max(4, (caption.end_frame - caption.start_frame) * zoom) }}
            >
              {caption.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}
