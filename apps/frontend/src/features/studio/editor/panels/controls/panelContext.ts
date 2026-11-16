// What the rows of a property panel share without passing it through every group. RowLayout: the slots a row keeps
// (Effect Controls keeps one for the stopwatch and shows a keyframe lane beside every row; the docks keep neither).
// ClipPanel: what the animated rows, the lanes and the key strip of Effect Controls act on: the selected clip, the
// playhead, the way to apply an edit, and the selected key.
import { createContext, useContext } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import type { PlayheadStore } from "../../../hooks/playhead";
import type { ClipEdits } from "./clipEdits";

export interface RowLayout {
  /** Rows keep a slot for the stopwatch, so the labels of animated and fixed properties line up. */
  lead: boolean;
  /** The keyframe lanes are on screen: every row carries its lane beside it. */
  lanes: boolean;
}

export const RowLayoutContext = createContext<RowLayout>({ lead: false, lanes: false });

/** A key of a property: the property's channel key and the key's frame in the keyframe timebase of its clip. */
export interface KeySelection {
  property: string;
  frame: number;
}

export interface ClipPanel extends ClipEdits {
  /** The selected clip: the lanes show its range. */
  clip: TimelineClip;
  fps: number;
  playhead: PlayheadStore;
  /** Moves the playhead to a sequence frame. */
  seek: (frame: number) => void;
  /** Reports why something a button or a drag asked for was not done. */
  warn: (reason: string) => void;
  selection: KeySelection | null;
  select: (selection: KeySelection | null) => void;
  /**
   * Puts the keyboard focus on the panel itself. For a control that removes itself (a deleted key): the focus must
   * not fall out of the panel, where the next Delete would remove the selected clip.
   */
  rest: () => void;
}

export const ClipPanelContext = createContext<ClipPanel | null>(null);

export function useClipPanel(): ClipPanel {
  const panel = useContext(ClipPanelContext);
  if (!panel) throw new Error("useClipPanel must be used inside Effect Controls");
  return panel;
}
