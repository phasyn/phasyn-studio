// The three generation rules of 修正與建議: one-take shots
// without timestamps or Shot numbers, scenery-only style plates, wings that stay spread instead of flapping.
// Positive and negative samples for each; synthetic prompts.
import { describe, expect, it } from "vitest";
import { analyzePrompt } from "./analyze";
import { GUIDE_EXAMPLES } from "./examples";
import { promptTemplates } from "./templates";
import { testItem, testRef } from "./testSamples";

const references = [testRef("Image1", "image", "i1"), testRef("Image2", "image", "i2")];
const library = [testItem("i1", "image"), testItem("i2", "image")];

function ids(text: string, mode: "t2va" | "ref2va" = "t2va"): string[] {
  return analyzePrompt({ text, mode, frames: 209, references: mode === "ref2va" ? references : [], library: mode === "ref2va" ? library : [] }).map((item) => item.id);
}

function one(text: string, id: string, mode: "t2va" | "ref2va" = "t2va") {
  return analyzePrompt({ text, mode, frames: 209, references: mode === "ref2va" ? references : [], library: mode === "ref2va" ? library : [] }).find((item) => item.id === id);
}

describe("one take: no timestamps or Shot numbers", () => {
  const TIMED = [
    "integrated_multimodal_description:\nThe whole sequence is a single continuous camera move. [Shot 1] The camera starts low on the street. [Shot 2] At 00:03.000, it rises over the roofs.",
    "integrated_multimodal_description:\nOne take, no cuts: the camera follows her along the pier. At 00:04.000, she turns toward the lighthouse.",
    "integrated_multimodal_description:\n一鏡到底：[Shot 1] 鏡頭從巷口推進，跟著她走到廣場。",
  ];
  const CLEAN = [
    "integrated_multimodal_description:\nThe whole sequence is a single continuous camera move from start to end: the camera starts low on the street, and as the camera keeps moving, it rises over the roofs, and, without stopping, it settles on the harbor.",
    "integrated_multimodal_description:\n[Shot 1] A wide view of the harbor at dusk.\n[Shot 2] At 00:03.000, a close-up of the lantern on the pier.",
  ];

  it.each(TIMED)("warns with a fix when a one-take shot has markers: %s", (text) => {
    const item = one(text, "timeline.one-take-markers");
    expect(item?.severity).toBe("warning");
    expect(item?.detail).toContain("single continuous camera move");
    const fixed = item?.fix?.apply(text) ?? text;
    expect(fixed).not.toMatch(/\[Shot \d|\d{2}:\d{2}/);
    expect(item?.fix?.apply(fixed)).toBe(fixed); // applying it again changes nothing
    expect(ids(fixed)).not.toContain("timeline.one-take-markers");
  });

  it.each(CLEAN)("stays quiet on %s", (text) => {
    expect(ids(text)).not.toContain("timeline.one-take-markers");
  });
});

describe("style plate: scenery only", () => {
  it("warns when the style reference line shows a character", () => {
    const text = "subject_definitions:\n@Image1 is the art style reference: it shows <Subject 1>, the girl with the bell, on the temple steps.\n\ndetailed_description:\nA quiet temple at dawn.";
    const item = one(text, "ref.style-plate-character", "ref2va");
    expect(item?.severity).toBe("warning");
    expect(item?.title).toContain("@Image1");
    expect(item?.detail).toContain("@Image1 is the art style reference");
  });

  it("warns when the style image also defines a subject", () => {
    const text = "subject_definitions:\n<Subject 1> is the knight in @Image2.\n@Image2 is also the style reference for the whole clip.\n\ndetailed_description:\nThe knight walks.";
    expect(ids(text, "ref2va")).toContain("ref.style-plate-character");
  });

  it("stays quiet on a scenery-only plate and on a character reference", () => {
    const text = "subject_definitions:\n<Subject 1> is the knight in @Image2, providing the face and armor.\n@Image1 is the art style reference: the whole clip follows its art style, palette and brushwork.\n\ndetailed_description:\nThe knight crosses the bridge.";
    expect(ids(text, "ref2va")).not.toContain("ref.style-plate-character");
  });
});

describe("wings: spread and steady, not flapping", () => {
  it.each([
    "integrated_multimodal_description:\nShe flies over the canyon, flapping her wings hard.",
    "integrated_multimodal_description:\nShe glides over the canyon.\n\noverall_soundscape:\nWind and loud wings beating.",
    "integrated_multimodal_description:\n她振翅飛過峽谷。",
  ])("warns on %s", (text) => {
    const item = one(text, "wording.wing-flapping");
    expect(item?.severity).toBe("warning");
    expect(item?.detail).toContain("fully spread and steady");
  });

  it("stays quiet on spread, gliding wings", () => {
    expect(ids("integrated_multimodal_description:\nHer white wings stay fully spread and steady the whole time as she glides; both wings clearly visible.")).not.toContain("wording.wing-flapping");
  });
});

describe("built-in prompts follow the measured rules", () => {
  it("no template or guide example triggers them", () => {
    const texts = [...promptTemplates({ mode: "t2va", frames: 209, references: [], library: [] }), ...promptTemplates({ mode: "ref2va", frames: 209, references, library })].map((item) => item.text).concat(GUIDE_EXAMPLES.map((item) => item.text));
    for (const text of texts) {
      const found = ids(text, "ref2va").filter((id) => ["timeline.one-take-markers", "ref.style-plate-character", "wording.wing-flapping"].includes(id));
      expect(found).toEqual([]);
    }
  });
});
