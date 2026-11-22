// Popovers of the generation row and the references tab (方式, 時長, Seed, 數量, 從素材庫加入). Placed next to their
// trigger like the action menus (below, or above when there is no room) and drawn in the top layer (floating.ts), so no
// panel's overflow clips them and, inside the professional prompt editor, focus and the pointer stay in its dialog.
// Motion: they pop in from the trigger's side (snappy spring, the design system's pop-in) and fade out on the exit
// timing, inert from the moment they start leaving. Focus moves in when they open; Esc and Tab out return it to the
// trigger, a press outside, scrolling another area or resizing the window close them where focus is. Keys stay inside
// (no monitor or timeline shortcut, no Ctrl+Enter render), and in a dialog Esc closes only the popover.
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeMenu } from "@/components/ui/menuModel";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { floatingFrame, floatingHost, focusablesIn } from "./floating";

export interface PopoverProps {
  id: string;
  open: boolean;
  /** The trigger; null until the popover was first opened. */
  anchor: HTMLElement | null;
  label: string;
  /** restoreFocus: give focus back to the trigger (Esc, Tab out). */
  onClose: (restoreFocus: boolean) => void;
  /** Width and inner layout of the panel. */
  className?: string;
  children: ReactNode;
}

/** Places the panel next to the anchor inside the host's frame and sets the side it pops in from. */
function place(panel: HTMLElement, anchor: HTMLElement, host: HTMLElement): void {
  const frame = floatingFrame(host);
  const seen = anchor.getBoundingClientRect();
  const rect = { left: seen.left - frame.left, top: seen.top - frame.top, right: seen.right - frame.left, bottom: seen.bottom - frame.top };
  panel.style.maxHeight = `${String(Math.max(160, frame.height - 16))}px`;
  const position = placeMenu(rect, { width: panel.offsetWidth, height: panel.offsetHeight }, { width: frame.width, height: frame.height }, 6);
  panel.style.left = `${String(position.left)}px`;
  panel.style.top = `${String(position.top)}px`;
  panel.style.setProperty("--motion-pop-y", position.top + 1 < rect.top ? "var(--motion-shift)" : "calc(var(--motion-shift) * -1)");
}

function Panel({ id, anchor, host, label, onClose, className, children }: Omit<PopoverProps, "open" | "anchor"> & { anchor: HTMLElement; host: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();

  // Every render: content (a picker step, a note) can change the height
  useLayoutEffect(() => {
    if (present && ref.current) place(ref.current, anchor, host);
  });
  // Content that changes inside a child (a list that grows) does not render the panel again: follow the size instead
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!present || !panel) return;
    const observer = new ResizeObserver(() => { place(panel, anchor, host); });
    for (const child of panel.children) observer.observe(child);
    return () => { observer.disconnect(); };
  }, [present, anchor, host]);

  useLayoutEffect(() => {
    const panel = ref.current;
    (panel?.querySelector<HTMLElement>("[data-autofocus]") ?? focusablesIn(panel)[0] ?? panel)?.focus({ preventScroll: true });
  }, []);

  const onPointer = useEffectEvent((event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node) || Boolean(ref.current?.contains(target)) || anchor.contains(target)) return;
    onClose(false);
  });
  const onScroll = useEffectEvent((event: Event) => {
    if (event.target instanceof Node && Boolean(ref.current?.contains(event.target))) return;
    onClose(false);
  });
  const onResize = useEffectEvent(() => { onClose(false); });
  useEffect(() => {
    if (!present) return;
    const pointer = (event: PointerEvent) => { onPointer(event); };
    const scroll = (event: Event) => { onScroll(event); };
    const resize = () => { onResize(); };
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [present]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (event.key !== "Tab") return;
    // Leaving the popover with Tab: focus goes back to the trigger first, then the browser moves on from there
    const items = focusablesIn(ref.current);
    const edge = event.shiftKey ? items[0] : items.at(-1);
    if (items.length === 0 || document.activeElement === edge || document.activeElement === ref.current) onClose(true);
  };

  return (
    <motion.div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-escape-local="true"
      inert={!present}
      onKeyDown={onKeyDown}
      exit={{ opacity: 0, transition: motionTransition("exit", "exit") }}
      className={cn(
        "material-popover fixed top-0 left-0 z-50 flex flex-col overflow-hidden rounded-xl text-fg outline-none animate-pop-in forced-colors:border forced-colors:border-[CanvasText]",
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

export function Popover({ open, anchor, ...rest }: PopoverProps) {
  if (!anchor) return null;
  const host = floatingHost(anchor);
  return createPortal(<AnimatePresence>{open ? <Panel key="panel" anchor={anchor} host={host} {...rest} /> : null}</AnimatePresence>, host);
}
