// A panel that opens under a prompt-toolbar button (templates, fixed prompts, the shot's plugin check). It is placed
// with position: absolute against its offset parent (the editor column), so it lands under its button whatever the
// panel around it does with fixed positioning and overflow: clamped to the column's width and only as tall as the column
// below the button allows (its own list scrolls). Pressing outside or the button again closes it; Escape closes it and
// returns focus to the button. A dialog to assistive technology (the global editor shortcuts stand down inside it).
// Motion: the shared pop-in (snappy spring) when it opens; it closes at once, like the action menus.
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const GAP = 4;
/** The panel never gets shorter than this, even when the column has less room below the button. */
const MIN_HEIGHT = 160;

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ToolPopover({
  id,
  anchor,
  label,
  width = 320,
  onClose,
  className,
  children,
}: {
  id: string;
  /** The button that opened the panel (it stays the toggle). */
  anchor: HTMLElement;
  /** Accessible name of the panel. */
  label: string;
  /** Preferred width in px (never wider than the column). */
  width?: number;
  /** restoreFocus: the panel was closed from the keyboard, so focus goes back to the button. */
  onClose: (restoreFocus: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // After every render (the content can change height): under the button, inside the offset parent
  useLayoutEffect(() => {
    const panel = ref.current;
    const parent = panel?.offsetParent;
    if (!panel || !(parent instanceof HTMLElement)) return;
    const box = parent.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    const top = at.bottom - box.top - parent.clientTop + GAP;
    const left = Math.min(Math.max(0, at.left - box.left - parent.clientLeft), Math.max(0, parent.clientWidth - panel.offsetWidth));
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.floor(parent.clientHeight - top - GAP))}px`;
  });

  // Focus moves in when it opens: to the content's own autofocus element, else the first control, else the panel
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel || panel.contains(document.activeElement)) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus({ preventScroll: true });
  }, []);

  const onOutsidePointer = useEffectEvent((event: PointerEvent) => {
    const target = event.target;
    // The button toggles the panel itself (its click closes it); everything else outside closes it here
    if (!(target instanceof Node) || ref.current?.contains(target) || anchor.contains(target)) return;
    onClose(false);
  });
  useEffect(() => {
    const pointer = (event: PointerEvent) => onOutsidePointer(event);
    document.addEventListener("pointerdown", pointer, true);
    return () => document.removeEventListener("pointerdown", pointer, true);
  }, []);

  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(event) => {
        // The input method's Escape cancels its composition, not the panel
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }}
      onBlur={(event) => {
        // Tab out of the panel closes it (focus moving inside, or back to its button, does not)
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next) && !anchor.contains(next)) onClose(false);
      }}
      style={{ width: `min(${width}px, 100%)` }}
      className={cn(
        "material-popover absolute top-0 left-0 z-30 flex min-h-0 flex-col overflow-y-auto rounded-xl p-1.5 text-fg outline-none animate-pop-in forced-colors:border forced-colors:border-[CanvasText]",
        className,
      )}
    >
      {children}
    </div>
  );
}
