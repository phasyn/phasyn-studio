// A finished transcription's detail reads its transcript: the lines, their start in the clip, nothing for other documents.
import { describe, expect, it } from "vitest";
import { chipName } from "@/app/layout/shell/runChip";
import { lineTime, transcriptLines } from "./transcript";

describe("transcriptLines", () => {
  it("reads the non-empty lines of a speech.transcript.v1 document", () => {
    const document = { schema_version: "1.1", segments: [{ start_ms: 0, end_ms: 900, text: " 你好 " }, { start_ms: 1500, end_ms: 2000, text: "" }, { start_ms: 65_000, end_ms: 66_000, text: "再見" }] };
    expect(transcriptLines(document)).toEqual([{ startMs: 0, text: "你好" }, { startMs: 65_000, text: "再見" }]);
  });

  it("is null for anything else", () => {
    expect(transcriptLines(null)).toBeNull();
    expect(transcriptLines({ segments: "x" })).toBeNull();
  });

  it("shows a line's start as m:ss", () => {
    expect(lineTime(65_400)).toBe("1:05");
    expect(lineTime(-5)).toBe("0:00");
  });
});

describe("chipName", () => {
  it("shows a Studio render by its shot", () => {
    expect(chipName("Studio：測試｜N1-N5 GPU 功能・鏡頭 3")).toBe("鏡頭 3");
    expect(chipName("Studio: Demo · Shot 1")).toBe("Shot 1");
  });

  it("keeps any other name", () => {
    expect(chipName("測試｜N1-N5・台詞配音")).toBe("測試｜N1-N5・台詞配音");
    expect(chipName("夜景")).toBe("夜景");
  });
});
