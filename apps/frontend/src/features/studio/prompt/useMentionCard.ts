// Which resolved @ name the reference card describes: the one under the pointer (hit-tested against the boxes of the
// highlight layer's marks, at most once per frame) or, without one, the one the caret stands in. Leaving the field,
// scrolling it or moving off the name hides the card.
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { markAtCaret, mentionMarks } from "./mentionMarks";

/** A pointer this close to a name (px) counts as on it: the capsule paints a little outside the glyphs. */
const SLOP = 2;

/** The start of the resolved mark under a viewport point; none → null. */
function markUnder(layer: HTMLElement | null, x: number, y: number): number | null {
  if (!layer) return null;
  for (const element of layer.querySelectorAll<HTMLElement>("[data-resolved]")) {
    for (const rect of element.getClientRects()) {
      if (x >= rect.left - SLOP && x <= rect.right + SLOP && y >= rect.top - SLOP && y <= rect.bottom + SLOP) return Number(element.dataset.markStart);
    }
  }
  return null;
}

export interface MentionCardTracker {
  /** Start offset of the name the card describes, and whether the caret (not the pointer) put it there. */
  target: { start: number; fromCaret: boolean } | null;
  onPointerMove: (event: PointerEvent<HTMLTextAreaElement>) => void;
  onPointerLeave: () => void;
  /** After typing or moving the caret: reads the field's new text and caret. */
  onCaret: (node: HTMLTextAreaElement) => void;
  hide: () => void;
}

export function useMentionCard(layer: RefObject<HTMLElement | null>, aliases: ReadonlySet<string>): MentionCardTracker {
  const [pointer, setPointer] = useState<number | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const frame = useRef(0);
  const point = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const hidePointer = () => {
    point.current = null;
    setPointer(null);
  };
  return {
    target: pointer !== null ? { start: pointer, fromCaret: false } : caret !== null ? { start: caret, fromCaret: true } : null,
    onPointerMove: (event) => {
      point.current = { x: event.clientX, y: event.clientY };
      if (frame.current !== 0) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const at = point.current;
        setPointer(at ? markUnder(layer.current, at.x, at.y) : null);
      });
    },
    onPointerLeave: hidePointer,
    onCaret: (node) => {
      const marks = mentionMarks(node.value, aliases);
      const index = node.selectionStart === node.selectionEnd ? markAtCaret(marks, node.selectionStart) : -1;
      setCaret(marks[index]?.start ?? null);
    },
    hide: () => {
      hidePointer();
      setCaret(null);
    },
  };
}
