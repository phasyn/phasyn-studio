import { describe, expect, it } from "vitest";
import { schemaControl } from "@/lib/schema";
import { addableCatalog, addEntry, convertLegacy, LORA_STACK_CONTROL, moveEntry, normalizeStack, parseCatalog, removeEntry, stackEntries, stackProblems, type LoraCatalogEntry } from "./loraStackModel";

const catalog: LoraCatalogEntry[] = parseCatalog({
  lora_catalog: [
    { manifest_path: "pai-h3-fl2va-acc8.json", lora_id: "pai-h3-fl2va-acc8", label: "PAI 8", role: "acceleration", format: "pdd_videox_fun", variants: ["fl2va"], steps: [8], fixed_scale: 1 },
    { manifest_path: "lx-turbo8.json", lora_id: "lx-turbo8", label: "Turbo 8", role: "acceleration", format: "peft_diffusers", variants: ["fl2va"], steps: [8], fixed_scale: null },
    { manifest_path: "concept.json", lora_id: "concept", label: "Concept", role: "style", format: "peft_diffusers", variants: ["fl2va"], steps: [8, 50], fixed_scale: null },
    { manifest_path: "ref-only.json", lora_id: "ref-only", label: "Ref", role: "style", format: "peft_diffusers", variants: ["ref2va"], steps: [50], fixed_scale: null },
    { bogus: true },
  ],
});

describe("LoRA stack model", () => {
  it("reads the catalog and finds the control keyword on a nullable list", () => {
    expect(catalog.map((entry) => entry.lora_id)).toEqual(["pai-h3-fl2va-acc8", "lx-turbo8", "concept", "ref-only"]);
    expect(schemaControl({ anyOf: [{ type: "null" }, { type: "array", "x-phasyn-control": LORA_STACK_CONTROL }] })).toBe(LORA_STACK_CONTROL);
    expect(schemaControl({ type: "array" })).toBeNull();
  });

  it("adds with the fixed scale, moves, removes and empties to null", () => {
    let entries = addEntry([], "pai-h3-fl2va-acc8.json", catalog);
    entries = addEntry(entries, "concept.json", catalog);
    expect(entries).toEqual([{ manifest_path: "pai-h3-fl2va-acc8.json", scale: 1 }, { manifest_path: "concept.json", scale: 1 }]);
    expect(moveEntry(entries, 1, -1).map((e) => e.manifest_path)).toEqual(["concept.json", "pai-h3-fl2va-acc8.json"]);
    expect(moveEntry(entries, 0, -1)).toEqual(entries);
    expect(normalizeStack(removeEntry(removeEntry(entries, 0), 0))).toBeNull();
  });

  it("converts the legacy single field into the first stack entry", () => {
    const next = convertLegacy({ variant: "fl2va", lora: { manifest_path: "pai-h3-fl2va-acc8.json", scale: 1, merge_mode: "dynamic" } });
    expect(next["lora"]).toBeNull();
    expect(stackEntries(next["loras"])).toEqual([{ manifest_path: "pai-h3-fl2va-acc8.json", scale: 1, merge_mode: "dynamic" }]);
  });

  it("flags two accelerators, duplicates, wrong variants and fixed scales", () => {
    const kinds = (entries: Parameters<typeof stackProblems>[0], legacy = false) => stackProblems(entries, catalog, { variant: "fl2va", legacy }).map((p) => p.kind);
    expect(kinds([{ manifest_path: "pai-h3-fl2va-acc8.json", scale: 1 }, { manifest_path: "concept.json", scale: 0.8 }])).toEqual([]);
    expect(kinds([{ manifest_path: "pai-h3-fl2va-acc8.json", scale: 1 }, { manifest_path: "lx-turbo8.json", scale: 1 }])).toEqual(["accelerators"]);
    expect(kinds([{ manifest_path: "concept.json", scale: 1 }, { manifest_path: "concept.json", scale: 1 }])).toEqual(["duplicate"]);
    expect(kinds([{ manifest_path: "ref-only.json", scale: 1 }])).toEqual(["variant"]);
    expect(kinds([{ manifest_path: "pai-h3-fl2va-acc8.json", scale: 0.5 }])).toEqual(["fixed_scale"]);
    expect(kinds([{ manifest_path: "concept.json", scale: 1 }], true)).toEqual(["both_forms"]);
  });

  it("offers only what can still be added", () => {
    const offered = addableCatalog([{ manifest_path: "pai-h3-fl2va-acc8.json", scale: 1 }], catalog, "fl2va").map((e) => e.manifest_path);
    expect(offered).toEqual(["concept.json"]);
  });
});
