import { useEffect, useEffectEvent, useRef, useState, type FocusEvent } from "react";

export interface HoverFocusPause {
  /** The pointer is over the element or focus is inside it. */
  paused: boolean;
  /** Spread onto the element. */
  pauseHandlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
}

/**
 * Whether a timed notice should hold still: while the pointer is over it or focus is inside it. The two are tracked
 * apart, so moving the pointer away does not restart the timer of a notice that still holds the keyboard focus (which
 * would then close under it), and focus leaving does not restart it while the pointer is still on it.
 */
export function useHoverFocusPause(): HoverFocusPause {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return {
    paused: hovered || focused,
    pauseHandlers: {
      onPointerEnter: () => setHovered(true),
      onPointerLeave: () => setHovered(false),
      onFocus: () => setFocused(true),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      },
    },
  };
}

/**
 * A timed notice's countdown, shared by every notice that closes on its own: `onTimeout` runs once `ms` have passed
 * while the notice is `running` (not leaving) and not paused by the pointer or the focus (useHoverFocusPause); a pause
 * keeps the time left, so leaving resumes the countdown instead of restarting it. `ms` null = no countdown (the notice
 * stays until it is closed). A new `onTimeout` (a parent's inline callback) never restarts the timer.
 */
export function useHoverFocusTimeout(ms: number | null, running: boolean, onTimeout: () => void): HoverFocusPause {
  const pause = useHoverFocusPause();
  const remaining = useRef(ms);
  const timeout = useEffectEvent(onTimeout);
  const { paused } = pause;
  useEffect(() => {
    const left = remaining.current;
    if (left === null || paused || !running) return;
    const started = performance.now();
    const timer = window.setTimeout(() => timeout(), left);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, left - (performance.now() - started));
    };
  }, [paused, running]);
  return pause;
}
