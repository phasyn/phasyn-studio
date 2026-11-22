// Drives a pair of LevelMeter bars (left, right) from the Program monitor's output. The levels are sampled once per
// animation frame while the sequence plays; when it stops, the loop keeps running only until the bars have fallen
// back, so nothing runs while the editor is idle. The bars are moved through their handles, not through React state;
// state changes only when a clipping lamp latches or a new loudest peak is reached.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { LevelMeterHandle } from "@/components/workbench/LevelMeter";
import { usePlaying } from "../../../hooks/playhead";
import { useEditor } from "../../editorContext";
import { METER_AT_REST, meterAtRest, SILENCE, stepMeter } from "./meterBallistics";

export interface ClipLamps {
  left: boolean;
  right: boolean;
}

export interface LevelMeters {
  leftRef: RefObject<LevelMeterHandle | null>;
  rightRef: RefObject<LevelMeterHandle | null>;
  /** The channels that reached full scale since the last reset. */
  clipped: ClipLamps;
  /** The loudest level since the last reset in dBFS, in steps of 0.1 dB (-Infinity before any sound). */
  loudest: number;
  /** Clear the clipping lamps and the loudest level. */
  reset: () => void;
}

const NO_CLIP: ClipLamps = { left: false, right: false };
/** Full scale: a level at or above it latches the clipping lamp. */
const FULL_SCALE_DB = 0;

export function useLevelMeters(): LevelMeters {
  const { playhead, transport } = useEditor();
  const { audio } = transport;
  const playing = usePlaying(playhead);
  const leftRef = useRef<LevelMeterHandle>(null);
  const rightRef = useRef<LevelMeterHandle>(null);
  const meterRef = useRef(METER_AT_REST);
  const [clipped, setClipped] = useState(NO_CLIP);
  const [loudest, setLoudest] = useState(-Infinity);

  useEffect(() => {
    if (!playing && meterAtRest(meterRef.current)) return;
    let handle = 0;
    let previous: number | null = null;
    const frame = (now: number) => {
      const input = playing ? audio.levels() : SILENCE;
      const next = stepMeter(meterRef.current, input, now, previous === null ? 0 : Math.max(0, now - previous), playing);
      previous = now;
      meterRef.current = next;
      leftRef.current?.set(next.left.level, next.left.peak);
      rightRef.current?.set(next.right.level, next.right.peak);
      const over: ClipLamps = { left: input.left >= FULL_SCALE_DB, right: input.right >= FULL_SCALE_DB };
      if (over.left || over.right) {
        // Returning the same object when nothing new latched keeps React from rendering
        setClipped((lamps) => ((lamps.left || !over.left) && (lamps.right || !over.right) ? lamps : { left: lamps.left || over.left, right: lamps.right || over.right }));
      }
      const peak = Math.round(Math.max(input.left, input.right) * 10) / 10;
      if (peak > -Infinity) setLoudest((current) => Math.max(current, peak));
      if (playing || !meterAtRest(next)) handle = requestAnimationFrame(frame);
    };
    handle = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(handle); };
  }, [audio, playing]);

  const reset = () => {
    setClipped(NO_CLIP);
    setLoudest(-Infinity);
  };
  return { leftRef, rightRef, clipped, loudest, reset };
}
