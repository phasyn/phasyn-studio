// Reordering a shot's references by dragging a row's handle. Only among references of the same kind: the send order is
// per kind (images, audio and videos are numbered separately), so a row cannot leave its kind. While dragging, the row
// lifts and a line shows where it will land; releasing there moves it (ReferencesPanel re-sorts, the rows glide into
// place and the prompt's @ names follow). Esc, a cancelled pointer or a release where it started change nothing.
// Pointer only: the keyboard has ↑／↓ on the handle and the row's menu.
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { ReferenceKind } from "./materials";

export interface ReferenceDragState {
  refId: string;
  /** Position among its kind when the drag started, and where it would land now. */
  from: number;
  target: number;
  /** The landing line's distance from the top of the list (px). */
  lineTop: number;
}

/** Half the gap between two rows (the list's gap-1.5). */
const HALF_GAP = 3;

export function useReferenceDrag(list: RefObject<HTMLElement | null>, onDrop: (refId: string, toIndex: number) => void) {
  const [state, setState] = useState<ReferenceDragState | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const drop = useRef(onDrop);
  useEffect(() => {
    drop.current = onDrop;
  });
  // A drag in progress ends with the list
  useEffect(() => () => stop.current?.(), []);

  const begin = (refId: string, kind: ReferenceKind) => (event: PointerEvent<HTMLButtonElement>) => {
    const root = list.current;
    if (event.button !== 0 || !root) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const rows = () => [...root.querySelectorAll<HTMLElement>(`[data-ref-kind="${kind}"]`)];
    const from = rows().findIndex((row) => row.dataset.refId === refId);
    let latest: ReferenceDragState = { refId, from, target: from, lineTop: 0 };
    const measure = (y: number) => {
      const others = rows().filter((row) => row.dataset.refId !== refId);
      const target = others.filter((row) => {
        const box = row.getBoundingClientRect();
        return box.top + box.height / 2 < y;
      }).length;
      const top = root.getBoundingClientRect().top;
      const after = others[target]?.getBoundingClientRect();
      const before = others[target - 1]?.getBoundingClientRect();
      const lineTop = after ? after.top - top - HALF_GAP : before ? before.bottom - top + HALF_GAP : 0;
      if (target === latest.target && lineTop === latest.lineTop) return;
      latest = { refId, from, target, lineTop };
      setState(latest);
    };
    const onMove = (next: globalThis.PointerEvent) => measure(next.clientY);
    const finish = (commit: boolean) => {
      stop.current?.();
      if (commit && latest.target !== latest.from) drop.current(refId, latest.target);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      finish(false);
    };
    stop.current = () => {
      stop.current = null;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      setState(null);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    setState(latest);
  };

  return { state, begin };
}
