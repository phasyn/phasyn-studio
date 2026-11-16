// The detail strings below are what phasyn_components.contracts produces for these settings (jsonschema's messages).
import { describe, expect, it } from "vitest";
import { descriptor } from "@/test/fixtures";
import { NODE_A_ID } from "@/test/ids";
import { withoutFields } from "./definitionCheck";

describe("withoutFields", () => {
  it("drops the keys (nested and inside part overrides) and leaves the original alone", () => {
    const stored = descriptor(NODE_A_ID, "dit-a", "h3.dit").settings.stored;
    const settings = {
      ...stored,
      invoke: { ...stored.invoke, bogus: 1, steps: 8 },
      load: { ...stored.load, part_overrides: [{ selector: "a.*", settings: { compute_dtype: "bf16" } }, { selector: "b.*", settings: { warp: 1, compute_dtype: "fp16" } }] },
    };
    const cleaned = withoutFields(settings, [["invoke", "bogus"], ["load", "part_overrides", 1, "settings", "warp"], ["recording", "missing"], ["nowhere", "x"]]);
    expect(cleaned.invoke).toEqual({ ...stored.invoke, steps: 8 });
    expect(cleaned.load.part_overrides).toEqual([{ selector: "a.*", settings: { compute_dtype: "bf16" } }, { selector: "b.*", settings: { compute_dtype: "fp16" } }]);
    expect(settings.invoke).toHaveProperty("bogus", 1);
  });
});
