// A finished transcription's lines, read from its speech.transcript.v1 document (pure; shown by WorkResults).
import { isRecord } from "@/lib/json";

export interface TranscriptLine {
  startMs: number;
  text: string;
}

/** The lines of a speech.transcript.v1 document; null when it is not one. */
export function transcriptLines(document: unknown): TranscriptLine[] | null {
  if (!isRecord(document) || !Array.isArray(document["segments"])) return null;
  return document["segments"].flatMap((segment) => {
    if (!isRecord(segment) || typeof segment["text"] !== "string" || typeof segment["start_ms"] !== "number") return [];
    const text = segment["text"].trim();
    return text ? [{ startMs: segment["start_ms"], text }] : [];
  });
}

/** 「m:ss」 of a line's start in the clip. */
export function lineTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}
