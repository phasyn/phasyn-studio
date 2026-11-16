// Removing items from the project library: where an item is used (video shot references and first frames, Image Studio
// references and masks, the One-Click Character Swap source video), and the reducer action that takes an unused item
// out of the library without touching shots or deleting files.
import { describe, expect, it } from "vitest";
import type { StudioImageShot, StudioImageTake, StudioLibraryItem, StudioProject, StudioReference } from "@/api/generated/contracts";
import { studioProject, studioShot } from "@/test/fixtures";
import { FIXED_TIME, uid } from "@/test/ids";
import { projectReducer } from "./project";

function item(itemId: string, kind: StudioLibraryItem["kind"] = "image"): StudioLibraryItem {
  return {
    item_id: itemId,
    kind,
    name: `${itemId}.bin`,
    file: { node_id: "n", file_id: itemId, size_bytes: 1, sha256: "0".repeat(64), media_type: `${kind}/x`, metadata: {} },
    created_at: FIXED_TIME,
    duration_seconds: kind === "image" ? null : 5,
    width: null,
    height: null,
    has_audio: kind === "image" ? false : null,
  };
}

function ref(alias: string, itemId: string, kind: StudioReference["kind"] = "image"): StudioReference {
  return { ref_id: `r-${alias}`, kind, alias, item_id: itemId, start_seconds: null, end_seconds: null };
}

function imageTake(takeId: string, libraryItemId: string | null): StudioImageTake {
  return { take_id: takeId, run_id: uid(7001), created_at: FIXED_TIME, state: "succeeded", seed: 1, image: null, image_white: null, library_item_id: libraryItemId, timings_ms: {}, error: null, params_snapshot: {} };
}

function imageShot(shotId: string, patch: Partial<StudioImageShot> = {}): StudioImageShot {
  return {
    image_shot_id: shotId,
    title: `圖片 ${shotId}`,
    mode: "i2i",
    prompt: "",
    negative_prompt: "",
    width: 1024,
    height: 1024,
    seed: -1,
    seed_mode: "random",
    batch: 1,
    steps: 40,
    guidance: 4,
    sigma_schedule: "native",
    flow_shift_mu: null,
    route: "",
    references: [],
    base_index: null,
    reference_resolution: 1024,
    mask_item_id: null,
    mask_invert: false,
    decode: "full",
    preview: { mode: "off", every: 1 },
    takes: [],
    active_take_id: null,
    note: "",
    ...patch,
  };
}

/** A project whose library holds lib-ref, lib-frame, lib-image, lib-mask, lib-swap and lib-free (used by nothing). */
function project(): StudioProject {
  return studioProject({
    library: ["lib-ref", "lib-frame", "lib-image", "lib-mask", "lib-swap", "lib-free"].map((id) => item(id, id === "lib-swap" ? "video" : "image")),
    shots: [
      studioShot({ shot_id: "s1", title: "開場" }),
      // The same file twice under two names, and a first frame from the library
      studioShot({ shot_id: "s2", title: "雨夜", references: [ref("Image1", "lib-ref"), ref("Image2", "lib-ref"), ref("Video1", "lib-swap", "video")], continuity: { mode: "image", item_id: "lib-frame" } }),
      studioShot({ shot_id: "s3", title: "街角", references: [ref("Image1", "lib-ref")] }),
    ],
    image_shots: [
      imageShot("i1", { references: [{ item_id: "lib-image", order: 0 }], base_index: 0, mask_item_id: "lib-mask", takes: [imageTake("t1", "lib-free")] }),
    ],
  });
}

describe("removeLibraryItem", () => {
  it("takes an unused item out of the library and clears the Image Studio take that pointed at it", () => {
    const before = project();
    const after = projectReducer(before, { type: "removeLibraryItem", itemId: "lib-free" });
    expect(after.library?.map((entry) => entry.item_id)).toEqual(["lib-ref", "lib-frame", "lib-image", "lib-mask", "lib-swap"]);
    expect(after.image_shots?.[0]?.takes[0]?.library_item_id).toBeNull();
    // Shots and everything else are untouched
    expect(after.shots).toBe(before.shots);
    expect(after.image_shots?.[0]?.references).toBe(before.image_shots?.[0]?.references);
  });

  it.each(["lib-ref", "lib-frame", "lib-image", "lib-mask"])("keeps %s while a shot or an image still uses it", (itemId) => {
    const before = project();
    expect(projectReducer(before, { type: "removeLibraryItem", itemId })).toBe(before);
  });
});
