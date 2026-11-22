// The parts both monitors share under their viewer: the full-width scrub bar, the row with the timecode, the
// fit / zoom menu and the duration, and the 36 px transport buttons whose tooltips carry the shortcut.
import { ChevronDown } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { PLAY_BUTTON, TOOL_BUTTON, TOOL_BUTTON_ON } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatTimecode } from "../../model/frames";
import type { ViewerZoom } from "./ViewerFrame";

export interface ScrubRange {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * The scrub bar: the whole duration as one track, the marked range shaded, the playhead as a thumb. Linear, never eased.
 * It takes only the unmodified keys; a chord (Shift+→ moves five frames) goes on to the key map (`data-scrub-bar`).
 * `end` is where End and the arrows may go: the last frame, or the sequence end (one past it) where an edit appends.
 */
export function ScrubBar({ frame, total, fps, range, label, end, onSeek }: { frame: number; total: number; fps: number; range?: ScrubRange | null; label: string; end?: number; onSeek: (frame: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const last = Math.max(0, total - 1);
  const limit = Math.max(0, end ?? last);
  const position = (value: number) => (total > 0 ? Math.max(0, Math.min(1, value / total)) * 100 : 0);
  const frameAt = (clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    return box && box.width > 0 ? Math.max(0, Math.min(last, Math.round(((clientX - box.left) / box.width) * total))) : 0;
  };
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1 || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onSeek(frameAt(event.clientX));
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowLeft: frame - 1, ArrowRight: frame + 1, PageUp: frame - Math.round(fps), PageDown: frame + Math.round(fps), Home: 0, End: limit };
    const next = moves[event.key];
    if (next === undefined || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    onSeek(Math.max(0, Math.min(limit, next)));
  };
  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      data-scrub-bar=""
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={Math.min(frame, limit)}
      aria-valuetext={formatTimecode(frame, fps)}
      aria-disabled={total === 0 || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0 || total === 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onSeek(frameAt(event.clientX));
      }}
      onPointerMove={drag}
      onKeyDown={keys}
      className="group/scrub relative h-5 shrink-0 cursor-pointer touch-none outline-none"
    >
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-line-subtle transition-[height] duration-(--duration-fast) group-hover/scrub:h-2" />
      {range && total > 0 ? (
        <span aria-hidden className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-trim/55 group-hover/scrub:h-2" style={{ left: `${String(position(range.start))}%`, width: `${String(position(range.end) - position(range.start))}%` }} />
      ) : null}
      <span aria-hidden className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-l-full bg-playhead/35 group-hover/scrub:h-2" style={{ left: 0, width: `${String(position(frame))}%` }} />
      <span
        aria-hidden
        className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-playhead shadow-glow-sm group-focus-visible/scrub:ring-2 group-focus-visible/scrub:ring-focus"
        style={{ left: `${String(position(frame))}%` }}
      />
    </div>
  );
}

const ZOOM_CHOICES: readonly ViewerZoom[] = ["fit", 25, 50, 100, 200];

function zoomLabel(zoom: ViewerZoom): string {
  return zoom === "fit" ? t("符合") : `${String(zoom)}%`;
}

/** The viewer's magnification: fit to the panel, or a fixed percentage of the output size. */
export function ZoomMenu({ zoom, onZoom }: { zoom: ViewerZoom; onZoom: (zoom: ViewerZoom) => void }) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? id : undefined}
        title={t("畫面縮放")}
        onClick={(event) => { setAnchor(anchor ? null : event.currentTarget); }}
        className="pressable inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-caption text-fg-secondary hover:bg-raised hover:text-fg"
      >
        <span className="machine">{zoomLabel(zoom)}</span>
        <ChevronDown aria-hidden className="size-3" />
      </button>
      {anchor ? (
        <ActionMenu
          id={id}
          label={t("畫面縮放")}
          anchor={{ kind: "element", element: anchor }}
          returnFocus={anchor}
          onClose={() => { setAnchor(null); }}
          items={ZOOM_CHOICES.map((choice) => ({ id: String(choice), label: zoomLabel(choice), disabledReason: choice === zoom ? t("目前的縮放") : null, onSelect: () => { onZoom(choice); } }))}
        />
      ) : null}
    </>
  );
}

/** Timecode (cyan, mono) at the left, the caller's controls in the middle, the duration at the right. */
export function TimecodeRow({ frame, total, fps, children }: { frame: number; total: number; fps: number; children?: ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2">
      <span className="machine shrink-0 text-body text-brand-cyan" title={t("目前位置")}>
        {formatTimecode(frame, fps)}
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1">{children}</div>
      <span className="machine shrink-0 text-caption text-fg-tertiary" title={t("長度")}>
        {formatTimecode(total, fps)}
      </span>
    </div>
  );
}

export interface MonitorButtonProps {
  label: string;
  /** Shown in the tooltip, as "名稱（鍵）". */
  shortcut?: string;
  onClick: () => void;
  disabledReason?: string | null;
  pressed?: boolean;
  /** Play / stop: the one brand-gradient round button of the monitor. */
  primary?: boolean;
  /** A labelled action (insert, overwrite, lift, extract) instead of an icon-only control. */
  text?: string;
  children: ReactNode;
}

/** The editors' sign for Mark In and Mark Out: an opening and a closing brace. */
export function MarkGlyph({ edge }: { edge: "in" | "out" }) {
  return (
    <span aria-hidden className="font-mono text-[17px] leading-none font-semibold">
      {edge === "in" ? "{" : "}"}
    </span>
  );
}

/** One transport control: 36 px, tooltip with the shortcut; an unavailable one stays focusable and says why. */
export function MonitorButton({ label, shortcut, onClick, disabledReason, pressed, primary = false, text, children }: MonitorButtonProps) {
  const title = disabledReason ?? ((shortcut != null && shortcut !== "") ? t("{label}（{shortcut}）", { label, shortcut }) : label);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={(disabledReason != null && disabledReason !== "") ? true : undefined}
      title={title}
      onClick={() => {
        if (!(disabledReason != null && disabledReason !== "")) onClick();
      }}
      className={cn(
        primary ? cn(PLAY_BUTTON, "mx-1") : cn(TOOL_BUTTON, "h-9 [&_svg]:size-4", (text != null && text !== "") ? "w-auto gap-1.5 px-2.5 text-caption" : "w-9", ((pressed === true) ? TOOL_BUTTON_ON : pressed)),
        ((disabledReason != null && disabledReason !== "") ? "cursor-not-allowed text-fg-disabled hover:bg-transparent hover:text-fg-disabled" : disabledReason),
      )}
    >
      {children}
      {(text != null && text !== "") ? <span>{text}</span> : null}
    </button>
  );
}

/** The centred transport row; `data-keep-focus` keeps the focus where it was, so Space still plays after a click. */
export function TransportRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} data-keep-focus="" className="flex shrink-0 flex-wrap items-center justify-center gap-0.5">
      {children}
    </div>
  );
}
