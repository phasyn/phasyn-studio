// The keys of one animated property on the lane of its row: one diamond per key, known by its frame (a removed key
// takes its diamond with it, and no other diamond changes into it). A click moves the playhead to the key and selects
// it; a drag moves the key in whole frames inside the part of the clip that plays and is committed once, on release.
// With the keyboard: the left and right arrows move the focused key by a frame (Shift: ten), Delete removes it. A key
// that moved keeps the keyboard focus at its new frame.
import { useContext, useState } from "react";
import type { TimelineClip, TimelineKeyframe } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { toClipLocalFrame } from "../../../model";
import { FieldLockContext } from "../controlsContext";
import { useClipPanel } from "../panelContext";
import { KEY_COLLISION, keyFrameRange, propertyName, sequenceFrame, shownKeys, withKeyChanged, withoutKey, type ClipProperty } from "../properties";
import { laneFraction, laneFramesPerPixel, laneLeft, shortTimecode } from "./laneGeometry";

/** A key's press area: 20 px wide over the height of the lane, centred on the key's frame. */
const KEY = "group/key absolute inset-y-0 flex w-5 -translate-x-1/2 touch-none items-center justify-center outline-none";
/** The diamond itself; the focus ring is drawn around it, not around the press area. */
const DIAMOND =
  "size-2 rotate-45 rounded-[1px] transition-colors duration-(--duration-fast) group-focus-visible/key:outline-2 group-focus-visible/key:outline-offset-2 group-focus-visible/key:outline-focus";

/** Gives the focus to a key that has just moved: its diamond is a new element at the new frame. */
const takeFocus = (node: HTMLElement | null) => {
  node?.focus({ preventScroll: true });
};

interface LaneDrag {
  /** The key's frame in the document. */
  from: number;
  /** The frame it is shown on while it is dragged. */
  to: number;
  /** Where the pointer went down, and the frames a px stands for. */
  x: number;
  framesPerPixel: number;
}

export interface KeyLaneProps {
  property: ClipProperty;
  /** The clip the property belongs to (the selected clip, or its linked sound). */
  owner: TimelineClip;
}

export function KeyLane({ property, owner }: KeyLaneProps) {
  const panel = useClipPanel();
  const locked = useContext(FieldLockContext);
  const [drag, setDrag] = useState<LaneDrag | null>(null);
  // The frame a key was just moved to: its new diamond takes the focus the old one had
  const [moved, setMoved] = useState<number | null>(null);
  const name = propertyName(property);
  const range = keyFrameRange(owner);
  const inRange = (frame: number) => Math.max(range.min, Math.min(range.max, frame));

  const activate = (key: TimelineKeyframe) => {
    panel.seek(sequenceFrame(owner, key));
    panel.select({ property: property.key, frame: key.frame });
  };
  const move = (from: number, to: number) => {
    if (to === from) return;
    const next = withKeyChanged(property, from, { frame: to });
    if (!next) panel.warn(KEY_COLLISION);
    else if (panel.perform(next)) {
      panel.select({ property: property.key, frame: to });
      setMoved(to);
    }
  };
  const remove = (key: TimelineKeyframe) => {
    if (!panel.perform(withoutKey(property, key.frame))) return;
    if (panel.selection?.property === property.key && panel.selection.frame === key.frame) panel.select(null);
    // The removed key's diamond is gone: the focus goes to the panel, where Delete removes no clip
    panel.rest();
  };

  return (
    <>
      {shownKeys(owner, property).map((key) => {
        const frame = drag?.from === key.frame ? drag.to : key.frame;
        const local = toClipLocalFrame(owner, frame);
        const fraction = laneFraction(panel.clip, owner.start_frame + local);
        if (fraction === null) return null;
        const selected = panel.selection?.property === property.key && panel.selection.frame === key.frame;
        const label = t("{name} 的關鍵影格，{time}", { name, time: shortTimecode(local, panel.fps) });
        return (
          <button
            key={key.frame}
            ref={key.frame === moved ? takeFocus : undefined}
            type="button"
            data-arrow-keys=""
            data-delete-keys=""
            aria-label={label}
            aria-pressed={selected}
            title={label}
            style={{ left: laneLeft(fraction) }}
            className={cn(KEY, selected ? "z-[2]" : "z-[1]", !locked && "cursor-ew-resize")}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const cell = event.currentTarget.parentElement?.getBoundingClientRect();
              // The pressed key has the keyboard: Delete removes it and the arrows move it (not the selected clip)
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag({ from: key.frame, to: key.frame, x: event.clientX, framesPerPixel: cell ? laneFramesPerPixel(panel.clip, cell) : 0 });
            }}
            onPointerMove={(event) => {
              if (!drag || drag.from !== key.frame || locked || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const to = inRange(drag.from + Math.round((event.clientX - drag.x) * drag.framesPerPixel));
              if (to !== drag.to) setDrag({ ...drag, to });
            }}
            onPointerUp={(event) => {
              if (!drag || drag.from !== key.frame) return;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              setDrag(null);
              if (drag.to === drag.from) activate(key);
              else move(drag.from, drag.to);
            }}
            onPointerCancel={() => setDrag(null)}
            onFocus={() => {
              if (moved !== null) setMoved(null);
            }}
            onClick={(event) => {
              // A pointer press is taken on release above; this is Enter or Space on the focused key
              if (event.detail === 0) activate(key);
            }}
            onKeyDown={(event) => {
              // One press, one step: a held key would fill the history with a step per repeat
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                if (!locked && !event.repeat) move(key.frame, inRange(key.frame + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1)));
              } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                if (!locked && !event.repeat) remove(key);
              }
            }}
          >
            <span aria-hidden className={cn(DIAMOND, selected ? "bg-brand-cyan" : "bg-fg-tertiary group-hover/key:bg-fg")} />
          </button>
        );
      })}
    </>
  );
}
