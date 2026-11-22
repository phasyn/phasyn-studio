// Open state of one popover and the trigger it is anchored to (Popover.tsx): the trigger toggles it; closing after a
// choice, Esc or Tab gives focus back to the trigger, closing after a press elsewhere leaves focus where it went.
import { useCallback, useState, type MouseEvent } from "react";

export interface PopoverState {
  anchor: HTMLElement | null;
  open: boolean;
  toggle: (event: MouseEvent<HTMLElement>) => void;
  close: (restoreFocus: boolean) => void;
}

export function usePopover(): PopoverState {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = useCallback((event: MouseEvent<HTMLElement>) => {
    setAnchor(event.currentTarget);
    setOpen((value) => !value);
  }, []);
  const close = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false);
      if (restoreFocus && (anchor?.isConnected === true)) anchor.focus({ preventScroll: true });
    },
    [anchor],
  );
  return { anchor, open, toggle, close };
}
