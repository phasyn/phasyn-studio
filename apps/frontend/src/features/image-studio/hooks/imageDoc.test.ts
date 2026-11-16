// Image Studio 的文件狀態（shell 的 docReducer＋圖片 reducer）：編輯、保存成功（保存期間的新編輯保留）、衝突後「保留兩邊」
// 重新套用還沒保存的動作。
import { describe, expect, it } from "vitest";
import { type DocEvent, type DocState } from "@/features/studio-shell";
import { initialDocState } from "@/features/studio-shell/testing";
import type { ImageProjectAction } from "../model/project";
import { project } from "../model/imageFixtures";
import type { ImageStudioProject } from "../types";
import { imageDocReducer } from "./useImageDocument";

type State = DocState<ImageStudioProject, ImageProjectAction>;
const run = (state: State, ...events: DocEvent<ImageStudioProject, ImageProjectAction>[]) => events.reduce(imageDocReducer, state);
const initialImageDoc = (doc: ImageStudioProject): State => initialDocState(doc);

describe("imageDocReducer", () => {

  it("保存成功：保存期間的新編輯保留，已保存的動作丟掉", () => {
    const start = initialImageDoc(project([{ image_shot_id: "s1" }]));
    const first = run(start, { type: "edit", action: { type: "updateImageShot", shotId: "s1", patch: { prompt: "1" } } }, { type: "saveStart" });
    const saved = { ...first.draft, revision: 4 };
    const second = run(first, { type: "edit", action: { type: "updateImageShot", shotId: "s1", patch: { steps: 20 } } }, { type: "saveOk", saved, seq: 1, generation: 0 });
    expect(second.status).toBe("dirty");
    expect(second.draft.revision).toBe(4);
    expect(second.draft.image_shots?.[0]).toMatchObject({ prompt: "1", steps: 20 });
    expect(second.pending.map((item) => item.seq)).toEqual([2]);
    const clean = run(second, { type: "saveOk", saved: { ...second.draft, revision: 5 }, seq: 2, generation: 0 });
    expect(clean).toMatchObject({ status: "saved", pending: [] });
  });

  it("衝突後保留兩邊：伺服器最新版（別人加了影片鏡頭）＋這裡還沒保存的圖片變更", () => {
    const start = initialImageDoc(project([{ image_shot_id: "s1" }]));
    const conflicted = run(
      start,
      { type: "edit", action: { type: "updateImageShot", shotId: "s1", patch: { prompt: "mine" } } },
      { type: "conflict", error: new Error("409"), storedRevision: 9, generation: 0 },
      { type: "edit", action: { type: "updateImageShot", shotId: "s1", patch: { batch: 4 } } },
    );
    expect(conflicted.status).toBe("conflict");
    const latest = { ...project([{ image_shot_id: "s1" }]), revision: 9, title: "別人改的名稱" };
    const merged = run(conflicted, { type: "rebase", latest });
    expect(merged.status).toBe("dirty");
    expect(merged.draft).toMatchObject({ revision: 9, title: "別人改的名稱" });
    expect(merged.draft.image_shots?.[0]).toMatchObject({ prompt: "mine", batch: 4 });
    expect(merged.pending).toHaveLength(2);
  });

  it("保留兩邊但動作都已不適用（圖片被刪掉）：沒有要保存的", () => {
    const start = initialImageDoc(project([{ image_shot_id: "s1" }]));
    const conflicted = run(start, { type: "edit", action: { type: "updateImageShot", shotId: "s1", patch: { prompt: "x" } } }, { type: "conflict", error: null, storedRevision: 5, generation: 0 });
    const latest = { ...project([]), revision: 5 };
    expect(run(conflicted, { type: "rebase", latest })).toMatchObject({ status: "saved", pending: [] });
  });
});
