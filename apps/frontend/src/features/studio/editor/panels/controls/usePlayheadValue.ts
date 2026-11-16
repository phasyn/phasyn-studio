// Something derived from the playhead frame. The component re-renders only when the derived value changes, so a row
// that asks "is the playhead on this clip?" stays still during playback while a row that shows an animated value
// follows every frame.
import { useSyncExternalStore } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import type { PlayheadStore } from "../../../hooks/playhead";
import { keyAt, neighbourKey, playheadIn, type ClipProperty } from "./properties";

export function usePlayheadValue<T extends number | string | boolean>(playhead: PlayheadStore, select: (frame: number) => T): T {
  return useSyncExternalStore(playhead.subscribe, () => select(playhead.getFrame()));
}

/** Where the playhead stands among the keys of a property. */
export interface PlayheadKeys {
  /** The playhead is on the clip. */
  inside: boolean;
  /** A key of the property is under the playhead. */
  onKey: boolean;
  /** The property has a key before the playhead (among the keys of the part of the clip that plays). */
  before: boolean;
  after: boolean;
}

const INSIDE = 1;
const ON_KEY = 2;
const BEFORE = 4;
const AFTER = 8;

/** Follows the playhead, but renders only when one of the answers changes (they are packed into one number for the store). */
export function usePlayheadKeys(playhead: PlayheadStore, clip: TimelineClip, property: ClipProperty): PlayheadKeys {
  const state = usePlayheadValue(playhead, (frame) => {
    const at = playheadIn(clip, frame);
    const onKey = at.inside && keyAt(property, at.processing) !== undefined;
    const before = neighbourKey(clip, property, at.processing, -1) !== undefined;
    const after = neighbourKey(clip, property, at.processing, 1) !== undefined;
    return (at.inside ? INSIDE : 0) | (onKey ? ON_KEY : 0) | (before ? BEFORE : 0) | (after ? AFTER : 0);
  });
  return { inside: (state & INSIDE) !== 0, onKey: (state & ON_KEY) !== 0, before: (state & BEFORE) !== 0, after: (state & AFTER) !== 0 };
}
