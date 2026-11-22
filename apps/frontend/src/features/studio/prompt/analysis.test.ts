// The note about references the prompt never names: H3 routes still send them, so it is worth a word; the 表演影片 and
// 音訊驅動 routes use the shot's references as their driving media without any @ name, so it would be wrong there.
import { describe, expect, it } from "vitest";
import type { StudioReference } from "@/api/generated/contracts";
import { analyzePrompt } from "./analysis";
import { parsePrompt } from "./blocks";

const REFERENCES: StudioReference[] = [
  { ref_id: "r1", kind: "image", alias: "Image1", item_id: "i1", start_seconds: null, end_seconds: null },
  { ref_id: "r2", kind: "audio", alias: "Audio1", item_id: "i2", start_seconds: null, end_seconds: null },
];
const TEXT = "The girl from @Image1 talks to a friend on a café terrace.";

function unusedNotes(drivenByReferences?: boolean): string[] {
  return analyzePrompt(parsePrompt(TEXT), TEXT, {
    references: REFERENCES,
    usedAliases: ["Image1"],
    ...(drivenByReferences === undefined ? {} : { drivenByReferences }),
  })
    .map((note) => note.text)
    .filter((text) => text.includes("Audio1"));
}

describe("analyzePrompt unused references", () => {
  it("notes a reference an H3 prompt never names", () => {
    expect(unusedNotes()).toHaveLength(1);
  });

  it("says nothing about driving media of a driven route", () => {
    expect(unusedNotes(true)).toEqual([]);
  });
});
