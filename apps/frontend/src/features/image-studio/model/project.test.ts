// 專案 reducer（圖片、take、素材庫、遮罩、用在影片鏡頭）、白底版素材、影片鏡頭的選項，以及 params_snapshot
// （載入這組參數、設定已變更、差異）。
import { describe, expect, it } from "vitest";
import type { ImageLibraryItem, ImageStudioProject, StudioImageTake } from "../types";
import { libraryImage, project } from "./imageFixtures";
import { imageProjectReducer, libraryItemInUse, MASK_NOTE, type ImageProjectAction } from "./project";

const apply = (doc: ImageStudioProject, ...actions: ImageProjectAction[]) => actions.reduce(imageProjectReducer, doc);

describe("素材庫與遮罩", () => {

  it("被引用的遮罩（或使用者上傳的圖）不會被移除", () => {
    const shared: ImageLibraryItem = { ...libraryImage("m1"), note: MASK_NOTE };
    let doc = apply(project([{ image_shot_id: "s1" }, { image_shot_id: "s2" }]), { type: "setMask", shotId: "s1", item: shared }, { type: "setMask", shotId: "s2", item: shared });
    expect(libraryItemInUse(doc, "m1")).toBe(true);
    doc = apply(doc, { type: "setMask", shotId: "s1", item: null });
    expect(doc.library?.map((item) => item.item_id)).toEqual(["m1"]);
    const upload = libraryImage("u1");
    doc = apply(project([{ image_shot_id: "s1" }], [upload]), { type: "setMask", shotId: "s1", item: upload }, { type: "setMask", shotId: "s1", item: null });
    expect(doc.library?.map((item) => item.item_id)).toEqual(["u1"]);
  });
});

it("keeps the image chosen while another run is pending and pins the legacy choice", () => {
  const take: StudioImageTake = { take_id: "old", run_id: "run-A", state: "succeeded", created_at: "2026-11-18T00:00:00Z",
    seed: 42, image: null, image_white: null, library_item_id: null, timings_ms: {}, error: null, params_snapshot: {} };
  const later = { ...take, take_id: "later" };
  const candidate = { ...take, state: "rendering" as const, take_id: "new", run_id: "run-B" };
  const update = { type: "updateImageTake" as const, runId: candidate.run_id, takeId: candidate.take_id,
    patch: { state: "succeeded" as const }, activateOnSuccess: true };
  for (const selected of [null, "old"]) {
    let doc = project([{ image_shot_id: "shot", takes: [take, later, candidate] }]);
    if (selected !== null) doc = imageProjectReducer(doc, { type: "setActiveImageTake", shotId: "shot", takeId: selected });
    doc = imageProjectReducer(doc, update);
    expect(doc.image_shots?.[0]?.active_take_id).toBe(selected ?? "later");
  }
  const fresh = project([{ image_shot_id: "shot", takes: [candidate] }]);
  expect(imageProjectReducer(fresh, update).image_shots?.[0]?.active_take_id).toBe("new");
});
