// Time values in prompt headings: seconds and mm:ss.sss clocks (format and parse), range labels and seconds fields.
import type { TimeRange } from "./types";
import { t } from "@/i18n";

/** Seconds → text: at least `decimals` decimals, more (up to 3) when needed (typed milliseconds are never rounded away). */
export function formatSeconds(value: number, decimals = 1): string {
  let digits = Math.max(0, Math.min(3, decimals));
  while (digits < 3 && Math.abs(value * 10 ** digits - Math.round(value * 10 ** digits)) > 1e-6) digits += 1;
  return value.toFixed(digits);
}

/** mm:ss.sss of an H3 timeline marker. */
export function formatClock(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(totalMs / 60000);
  const rest = (totalMs - minutes * 60000) / 1000;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

export function parseClock(text: string): number | null {
  const match = /^(\d{1,3}):(\d{2}(?:\.\d{1,3})?)$/.exec(text.trim());
  if (!match) return null;
  const seconds = Number(match[2]);
  return seconds >= 60 ? null : Number(match[1]) * 60 + seconds;
}

export function rangeLabel(range: TimeRange, decimals = 1): string {
  return t("{start}–{end} 秒", { start: formatSeconds(range.start, decimals), end: formatSeconds(range.end, decimals) });
}

/** Parses a seconds field: empty → null (the caller decides whether that is allowed); not a number → error. */
export function parseSecondsInput(text: string): { value: number | null; error: string | null } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null, error: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { value: null, error: t("請輸入秒數（例如 1.5）") };
  return { value, error: null };
}
