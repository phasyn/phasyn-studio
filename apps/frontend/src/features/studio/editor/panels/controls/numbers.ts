// Number helpers of the property fields: rounding to shown decimals and the text of a number in a field.

/** Rounded to `decimals` places; never −0. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** A number as field text: up to `decimals` places, without trailing zeros. */
export function formatNumber(value: number, decimals: number): string {
  return String(roundTo(value, decimals));
}

/** Typed text as a number (a typographic minus counts as a minus); NaN when it is not one. */
export function parseNumber(text: string): number {
  const raw = text.trim().replace(/−/g, "-");
  return raw === "" ? Number.NaN : Number(raw);
}
