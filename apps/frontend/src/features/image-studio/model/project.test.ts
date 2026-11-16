// 專案 reducer（圖片、take、素材庫、遮罩、用在影片鏡頭）、白底版素材、影片鏡頭的選項，以及 params_snapshot
// （載入這組參數、設定已變更、差異）。
import { describe, expect, it } from "vitest";
import type { ImageLibraryItem, ImageStudioProject } from "../types";
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
