// How the Program monitor mixes one clip's layer at a frame through the transitions into and out of it: the layer's
// opacity, its sound's gain, the wash of a dip and, for a moving transition, where the picture is drawn and what hides
// part of it. The monitor's DOM layers (ProgramViewer) and the composite an adjustment layer reads (layerStack) both
// use it, so they draw the same thing. Pure.
import type { TimelineClip } from "@/api/generated/contracts";
import { activeTransition, isMoving } from "../../model/clipEffects";
import { clipEnd } from "../model";
import { movingLook, smoothStep, type MovingLook } from "../transitionLook";

export interface TransitionMix {
  /** Opacity of the layer. */
  alpha: number;
  /** Gain of its sound. */
  gain: number;
  /** How far the picture is washed to black (or white). */
  wash: number;
  white: boolean;
  /** A moving transition (push, slide, whip, wipe, zoom): where the picture is drawn and what hides part of it. */
  look: MovingLook | null;
}

/**
 * How a clip's incoming and outgoing transitions mix it at a frame (an approximation of the exported curves). The sound
 * of every transition but a dip cross-fades.
 */
export function transitionAt(clip: TimelineClip, clips: readonly TimelineClip[], frame: number, width: number, height: number): TransitionMix {
  const ordered = clips.filter((item) => item.track_id === clip.track_id).sort((a, b) => a.start_frame - b.start_frame);
  const previous = ordered[ordered.findIndex((item) => item.clip_id === clip.clip_id) - 1];
  const incoming = activeTransition(previous?.effects);
  const outgoing = activeTransition(clip.effects);
  const mix: TransitionMix = { alpha: 1, gain: 1, wash: 0, white: false, look: null };
  if (incoming && frame < clip.start_frame + incoming.frames) {
    const progress = (frame - clip.start_frame) / incoming.frames;
    if (isMoving(incoming)) {
      mix.gain = progress;
      mix.look = movingLook(incoming, "in", progress, width, height);
    } else {
      mix.alpha = progress;
      mix.gain = incoming.kind === "crossfade" ? progress : Math.max(0, progress * 2 - 1);
      if (incoming.kind !== "crossfade") {
        mix.wash = smoothStep((1 - progress) / 0.2);
        mix.white = incoming.kind === "dip_to_white";
      }
    }
  }
  if (outgoing) {
    const at = clipEnd(clip) - outgoing.frames;
    if (frame >= at) {
      const progress = (frame - at) / outgoing.frames;
      if (isMoving(outgoing)) {
        mix.gain *= 1 - progress;
        mix.look = movingLook(outgoing, "out", progress, width, height);
      } else {
        mix.alpha *= 1 - progress;
        mix.gain *= outgoing.kind === "crossfade" ? 1 - progress : Math.max(0, 1 - progress * 2);
        if (outgoing.kind !== "crossfade") {
          mix.wash = 1 - smoothStep((0.2 - progress) / 0.2);
          mix.white = outgoing.kind === "dip_to_white";
        }
      }
    }
  }
  return mix;
}

/** The filter of a layer's dip: a wash to black, or to white by inverting around it (CSS and canvas filter syntax). */
export function washFilter(mix: Pick<TransitionMix, "wash" | "white">): string {
  const invert = mix.white ? "invert(1) " : "";
  return `${invert}brightness(${1 - mix.wash})${mix.white ? " invert(1)" : ""}`;
}
