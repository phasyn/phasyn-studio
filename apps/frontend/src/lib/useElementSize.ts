// Content-box size of an element (ResizeObserver), in whole pixels. The first measurement happens synchronously in a
// layout effect when the element attaches, so the first paint never renders with a 0 × 0 size.
import { useLayoutEffect, useState, type RefObject } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

const ZERO: ElementSize = { width: 0, height: 0 };

function contentSize(element: HTMLElement): ElementSize {
  const style = getComputedStyle(element);
  const horizontal = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) || 0;
  const vertical = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) || 0;
  return { width: Math.max(0, Math.floor(element.clientWidth - horizontal)), height: Math.max(0, Math.floor(element.clientHeight - vertical)) };
}

/** Observes `element`; `update` receives every size change (equal sizes are not reported twice). */
function observeSize(element: HTMLElement, update: (size: ElementSize) => void): () => void {
  let last = contentSize(element);
  update(last);
  const observer = new ResizeObserver((entries) => {
    const rect = entries.at(-1)?.contentRect;
    if (!rect) return;
    const next = { width: Math.floor(rect.width), height: Math.floor(rect.height) };
    if (next.width === last.width && next.height === last.height) return;
    last = next;
    update(next);
  });
  observer.observe(element);
  return () => observer.disconnect();
}

/** Size of the element behind a stable ref (the element itself is not expected to be swapped). */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>(ZERO);
  useLayoutEffect(() => {
    const element = ref.current;
    return element ? observeSize(element, setSize) : undefined;
  }, [ref]);
  return size;
}

/**
 * Callback-ref variant for elements that may be replaced or unmounted: returns the ref to attach, the current element
 * (for native listeners such as wheel) and its size; observation follows the element.
 */
export function useMeasuredElement<T extends HTMLElement>(): [(node: T | null) => void, T | null, ElementSize] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize>(ZERO);
  useLayoutEffect(() => (element ? observeSize(element, setSize) : undefined), [element]);
  return [setElement, element, size];
}
