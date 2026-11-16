// dB values as the mixer and the audio meters print and read them, and where a gain sits on a fader.

/** The gain range of an audio track and of the master (contract: TimelineTrack.gain_db, StudioTimeline.master_gain_db). */
export const GAIN_MIN_DB = -60;
export const GAIN_MAX_DB = 12;

const roundTenth = (value: number) => Math.round(value * 10) / 10;

/** A gain inside the range, in steps of 0.1 dB. */
export function clampGain(db: number): number {
  return roundTenth(Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, db)));
}

/** "+3.0", "0.0", "−12.5" (a real minus sign, as wide as the plus); "−∞" for silence. */
export function formatDb(value: number): string {
  if (value === -Infinity) return "−∞";
  const rounded = roundTenth(value);
  if (rounded === 0) return "0.0";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(1)}`;
}

/** A typed gain: a number with an optional sign and an optional "dB"; null when it is not one. */
export function parseDb(text: string): number | null {
  const raw = text
    .trim()
    .replace(/\s*db$/i, "")
    .replace(/^[−–]/, "-")
    .replace(/^\+/, "");
  return /^-?\d+(\.\d+)?$/.test(raw) ? roundTenth(Number(raw)) : null;
}

// The travel of a gain fader. Three quarters of it cover the 36 dB from -24 dB up, where mixing happens; the lowest
// quarter covers everything below. Positions run from 0 (bottom, -60 dB) to 1 (top, +12 dB); unity sits at 0.75.
const KNEE_DB = -24;
const KNEE_AT = 0.25;

/** dB values marked on the fader's scale. */
export const FADER_TICKS: readonly number[] = [12, 6, 0, -6, -12, -24, -36, -48, -60];

export function faderPosition(db: number): number {
  const value = Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, db));
  if (value >= KNEE_DB) return KNEE_AT + ((value - KNEE_DB) / (GAIN_MAX_DB - KNEE_DB)) * (1 - KNEE_AT);
  return ((value - GAIN_MIN_DB) / (KNEE_DB - GAIN_MIN_DB)) * KNEE_AT;
}

/** The gain at a fader position, in steps of 0.1 dB. */
export function faderGain(position: number): number {
  const at = Math.min(1, Math.max(0, position));
  if (at >= KNEE_AT) return roundTenth(KNEE_DB + ((at - KNEE_AT) / (1 - KNEE_AT)) * (GAIN_MAX_DB - KNEE_DB));
  return roundTenth(GAIN_MIN_DB + (at / KNEE_AT) * (KNEE_DB - GAIN_MIN_DB));
}
