// Captions at the same position never overlap (the same cases as the Controller's test_caption_fit.py).
import { describe, expect, it } from "vitest";
import type { TimelineCaption } from "@/api/generated/contracts";
import { fileRef } from "@/test/fixtures/pipeline";
import { fitCaptions } from "./captionFit";

const cap = (id: string, start: number, end: number, position: TimelineCaption["position"] = "bottom", extra: Partial<TimelineCaption> = {}): TimelineCaption => ({
  caption_id: id, start_frame: start, end_frame: end, text: id, position, size: "medium", ...extra,
});
const spans = (captions: readonly TimelineCaption[]) => captions.map((caption) => [caption.caption_id, caption.start_frame, caption.end_frame]);

describe("fitCaptions", () => {
  it("ends a caption that runs into the next one where the next one starts", () => {
    const before = [cap("a", 0, 50), cap("b", 40, 80), cap("c", 70, 90)];
    expect(spans(fitCaptions(before))).toEqual([["a", 0, 40], ["b", 40, 70], ["c", 70, 90]]);
    expect(spans(before)).toEqual([["a", 0, 50], ["b", 40, 80], ["c", 70, 90]]);
  });

  it("lets captions at other positions overlap", () => {
    expect(spans(fitCaptions([cap("a", 0, 50), cap("b", 10, 60, "top")]))).toEqual([["a", 0, 50], ["b", 10, 60]]);
  });

  it("plays two captions that start together one after the other", () => {
    expect(spans(fitCaptions([cap("a", 10, 40), cap("b", 10, 30)]))).toEqual([["a", 10, 40], ["b", 40, 60]]);
  });

  it("keeps a generated caption's transcription record in step", () => {
    const record = { clip_id: "clip", run_id: "00000000-0000-4000-8000-000000000001", output_key: "transcript", source_sha256: "a".repeat(64), start_ms: 0, end_ms: 2000, start_frame: 0, end_frame: 50, text: "a", size: "medium" as const, position: "bottom" as const, needs_review: false, file: fileRef("f-transcript", { sha256: "a".repeat(64), size_bytes: 1, media_type: "application/json" }) };
    const [first] = fitCaptions([cap("a", 0, 50, "bottom", { transcription: record }), cap("b", 40, 80)]);
    expect(first?.end_frame).toBe(40);
    expect(first?.transcription?.end_frame).toBe(40);
  });

  it("returns the same array when nothing overlaps", () => {
    const before = [cap("a", 0, 40), cap("b", 40, 80)];
    expect(fitCaptions(before)).toBe(before);
  });
});
