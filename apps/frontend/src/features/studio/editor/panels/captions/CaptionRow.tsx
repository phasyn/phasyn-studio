// One caption in the list of the Captions panel: its text on the first line, its In and Out timecodes on the second.
// A click selects it (the panel then moves the playhead to it and the detail area under the list edits it); a right
// click opens its menu. The timecodes turn cyan while the playhead is on the caption.
import { Trash2 } from "lucide-react";
import type { FocusEvent, MouseEvent } from "react";
import type { TimelineCaption } from "@/api/generated/contracts";
import { LIST_ROW, LIST_ROW_IDLE, LIST_ROW_SELECTED, TOOL_BUTTON } from "@/components/ui/look";
import type { MenuAnchor } from "@/components/ui/menuModel";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatTimecode } from "../../../model/frames";
import { captionLine } from "./captionEdits";

export interface CaptionRowProps {
  caption: TimelineCaption;
  /** Place in the list (the entrance stagger). */
  index: number;
  fps: number;
  selected: boolean;
  /** The row the Tab key lands on (the selected one, else the first). */
  tabbable: boolean;
  /** The playhead is on this caption. */
  current: boolean;
  /** Selects the caption and moves the playhead to it. */
  onSelect: () => void;
  onRemove: () => void;
  onMenu: (anchor: MenuAnchor, row: HTMLElement) => void;
}

export function CaptionRow({ caption, index, fps, selected, tabbable, current, onSelect, onRemove, onMenu }: CaptionRowProps) {
  const line = captionLine(caption.text);
  // The pointer selects on the finished click, not on the press: selecting opens the detail area, and the list must
  // not change under a press that is still to become a click (on this row, or on its delete button)
  const press = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    onSelect();
  };
  // The keyboard selects by moving the focus
  const focus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.currentTarget.matches(":focus-visible")) onSelect();
  };
  return (
    <div /* eslint-disable-line jsx-a11y-x/click-events-have-key-events -- The focused row delegates its keyboard actions to the parent grid or tree. */
      ref={reveal(index)}
      role="row"
      tabIndex={tabbable ? 0 : -1}
      data-caption-row={caption.caption_id}
      aria-selected={selected}
      aria-current={current ? "true" : undefined}
      onClick={press}
      onFocus={focus}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect();
        onMenu({ kind: "point", x: event.clientX, y: event.clientY }, event.currentTarget);
      }}
      className={cn(
        LIST_ROW,
        "flex h-11 min-w-0 cursor-default items-center gap-1 pr-1 pl-3 outline-none select-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
        selected ? LIST_ROW_SELECTED : LIST_ROW_IDLE,
      )}
    >
      <span role="gridcell" className="grid min-w-0 flex-1">
        <span className="truncate text-data text-fg" title={caption.text}>
          {line}
        </span>
        <span className={cn("machine truncate text-caption leading-4", current ? "text-brand-cyan" : "text-fg-tertiary")}>
          {`${formatTimecode(caption.start_frame, fps)} – ${formatTimecode(caption.end_frame, fps)}`}
        </span>
      </span>
      <span role="gridcell" className="flex shrink-0">
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("刪除字幕「{text}」", { text: line })}
          title={t("刪除字幕（Delete）")}
          onClick={onRemove}
          className={cn(TOOL_BUTTON, "text-fg-tertiary hover:text-danger")}
        >
          <Trash2 aria-hidden />
        </button>
      </span>
    </div>
  );
}
