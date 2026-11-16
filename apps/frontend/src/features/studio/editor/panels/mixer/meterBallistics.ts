// How a level meter moves, as pure steps. The bar jumps to a louder level at once and falls back at a fixed rate; the
// peak line stays on the loudest level for a moment and then falls at the same rate. Everything is linear in dB, so
// the meter reads the same at any frame rate.
import type { StereoLevels } from "../../audio";

/** Below this the meter shows nothing. */
export const METER_FLOOR_DB = -60;
/** dB per second the bar and a released peak line fall. */
const FALL_DB_PER_SECOND = 36;
const PEAK_HOLD_MS = 1500;

export interface ChannelMeter {
  /** What the bar shows, in dBFS (-Infinity = nothing). */
  level: number;
  /** What the peak line shows. */
  peak: number;
  /** Time (as passed to the steps) until which the peak line stays where it is. */
  heldUntil: number;
}

export interface StereoMeter {
  left: ChannelMeter;
  right: ChannelMeter;
}

const REST: ChannelMeter = { level: -Infinity, peak: -Infinity, heldUntil: 0 };

export const METER_AT_REST: StereoMeter = { left: REST, right: REST };
export const SILENCE: StereoLevels = { left: -Infinity, right: -Infinity };

const shown = (level: number) => (level > METER_FLOOR_DB ? level : -Infinity);

function stepChannel(meter: ChannelMeter, input: number, now: number, elapsedMs: number, hold: boolean): ChannelMeter {
  const fall = (FALL_DB_PER_SECOND * elapsedMs) / 1000;
  const level = shown(Math.max(input, meter.level - fall));
  if (input >= meter.peak) return { level, peak: shown(input), heldUntil: now + PEAK_HOLD_MS };
  if (hold && now < meter.heldUntil) return { level, peak: meter.peak, heldUntil: meter.heldUntil };
  return { level, peak: shown(meter.peak - fall), heldUntil: 0 };
}

/**
 * The meter one animation frame later. `input` is the level measured now, `elapsedMs` the time since the last step.
 * hold = false lets the peak lines fall at once (the transport stopped), so the meter comes to rest quickly.
 */
export function stepMeter(meter: StereoMeter, input: StereoLevels, now: number, elapsedMs: number, hold: boolean): StereoMeter {
  return {
    left: stepChannel(meter.left, input.left, now, elapsedMs, hold),
    right: stepChannel(meter.right, input.right, now, elapsedMs, hold),
  };
}

/** Whether nothing is shown any more (the frame loop may stop). */
export function meterAtRest(meter: StereoMeter): boolean {
  return [meter.left, meter.right].every((channel) => channel.level === -Infinity && channel.peak === -Infinity);
}
