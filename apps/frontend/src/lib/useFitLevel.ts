// How far a strip (tab list, toolbar, header) collapses to fit: measured, never per-language widths. The element is
// measured in a layout effect whenever its level or content changes, so a level that overflows is never painted; a
// ResizeObserver on the element and its children measures again when a width changes (window, splitter, a child's own
// text). Rule and hysteresis: fitLevel.ts.
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FIT_START, nextFitState, type FitMeasure, type FitState } from "./fitLevel";

export type FitMeasurer = (element: HTMLElement) => FitMeasure;

/** Left edge of `child` in the padding box of `element`, in layout pixels (offset*: no transforms, no scrolling). */
function offsetIn(child: HTMLElement, element: HTMLElement): number | null {
  if (child.offsetParent === element) return child.offsetLeft;
  if (child.offsetParent !== null && child.offsetParent === element.offsetParent) return child.offsetLeft - element.offsetLeft - element.clientLeft;
  return null;
}

/**
 * Room the element's content needs (required) and has (available = its clientWidth): the far edge of its in-flow
 * children plus the end padding, in layout pixels. That is the element's scrollWidth once nothing moves, except that it
 * holds for any overflow value (scrollWidth leaves the end padding out unless the element scrolls) and it ignores what
 * cannot be measured mid-animation: an absolutely positioned decoration (a tab strip's sliding underline still at its
 * old place while it slides) and transforms (a panel scaling in). Without element children it is the scrollWidth.
 * The element must take its width from its container (a block, a stretched or growing flex item), not from its content,
 * or a collapsed level would never get the room to come back.
 */
export function measureOverflow(element: HTMLElement): FitMeasure {
  let end: number | null = null;
  for (const child of Array.from(element.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const style = getComputedStyle(child);
    if (style.position === "absolute" || style.position === "fixed" || style.display === "none") continue;
    const left = offsetIn(child, element);
    if (left === null) continue;
    end = Math.max(end ?? 0, left + child.offsetWidth + (parseFloat(style.marginRight) || 0));
  }
  const required = end === null ? element.scrollWidth : end + (parseFloat(getComputedStyle(element).paddingRight) || 0);
  return { required, available: element.clientWidth };
}

interface FitStore {
  content: unknown;
  levels: number;
  state: FitState;
}

interface Observation {
  observer: ResizeObserver | null;
  element: HTMLElement | null;
  observed: WeakSet<Element>;
}

/**
 * The current fit level (0 = everything shown … `levels`) of the element behind `ref`. `content` is a key for what is
 * shown (labels, counts): when it changes the level starts again from 0 and is measured from there, still before paint.
 * `measure` replaces measureOverflow (for example to measure several rows at once); it must be stable (a module-level
 * function).
 */
export function useFitLevel(ref: RefObject<HTMLElement | null>, levels: number, content: unknown, measure: FitMeasurer = measureOverflow): number {
  const [store, setStore] = useState<FitStore>(() => ({ content, levels, state: FIT_START }));
  let current = store;
  if (!Object.is(store.content, content) || store.levels !== levels) {
    // A fresh object even when the level already was 0, so the layout effect below measures the new content
    current = { content, levels, state: { ...FIT_START } };
    setStore(current);
  }
  const state = current.state;
  const latestRef = useRef({ state, levels, measure });
  const observationRef = useRef<Observation>({ observer: null, element: null, observed: new WeakSet() });

  // Each new state is measured before paint and may step again (the steps end: see nextFitState)
  useLayoutEffect(() => {
    latestRef.current = { state, levels, measure };
    const element = ref.current;
    if (!element) return;
    const next = nextFitState(state, measure(element), levels);
    if (next !== state) setStore((previous) => (previous.state === state ? { ...previous, state: next } : previous));
  }, [ref, state, levels, measure]);

  // Width changes without a render of this component: step from the committed level; the layout effect above keeps
  // stepping after that render
  useLayoutEffect(() => {
    const element = ref.current;
    const watch = observationRef.current;
    if (typeof ResizeObserver === "undefined") return;
    if (element !== watch.element) {
      watch.observer?.disconnect();
      watch.observed = new WeakSet();
      watch.element = element;
      watch.observer = element
        ? new ResizeObserver(() => {
            const target = watch.element;
            if (!target) return;
            const { state: committed, levels: max, measure: measureNow } = latestRef.current;
            const next = nextFitState(committed, measureNow(target), max);
            if (next !== committed) setStore((previous) => (previous.state === committed ? { ...previous, state: next } : previous));
          })
        : null;
    }
    if (!element || !watch.observer) return;
    // Also deeper boxes marked data-fit-watch: content that sizes itself inside a fixed track (a grid column) changes
    // its own width without changing any direct child's
    for (const node of [element, ...Array.from(element.children), ...Array.from(element.querySelectorAll("[data-fit-watch]"))]) {
      if (watch.observed.has(node)) continue;
      watch.observed.add(node);
      watch.observer.observe(node);
    }
  });

  useLayoutEffect(() => {
    const watch = observationRef.current;
    return () => {
      watch.observer?.disconnect();
      watch.observer = null;
      watch.element = null;
    };
  }, []);

  return state.level;
}
