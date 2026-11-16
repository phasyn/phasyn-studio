import { describe, expect, it } from "vitest";
import type { StudioProject } from "@/api/generated/contracts";
import { newProject, type ProjectAction } from "../model/project";
import { initialDocState } from "@/features/studio-shell/testing";
import { projectDocReducer as docReducer } from "./useProjectDocument";

describe("project document state", () => {
  it("keeps edits made while a save is in flight and stops on conflict", () => {
    const base = { ...newProject("P"), revision: 3 };
    let state = initialDocState<StudioProject, ProjectAction>(base);
    state = docReducer(state, { type: "edit", action: { type: "rename", title: "第一版" } });
    expect(state.status).toBe("dirty");
    const seqAtSave = state.editSeq;
    state = docReducer(state, { type: "saveStart" });
    state = docReducer(state, { type: "edit", action: { type: "rename", title: "第二版" } }); // 儲存期間的編輯
    expect(state.status).toBe("saving");
    state = docReducer(state, { type: "saveOk", saved: { ...state.base, title: "第一版", revision: 4 }, seq: seqAtSave, generation: 0 });
    expect(state.status).toBe("dirty"); // 還有新編輯：之後以 r4 再存一次
    expect(state.draft.title).toBe("第二版");
    expect(state.draft.revision).toBe(4);
    state = docReducer(state, { type: "conflict", error: null, storedRevision: 6, generation: 0 });
    state = docReducer(state, { type: "edit", action: { type: "rename", title: "第三版" } });
    expect(state.status).toBe("conflict"); // 衝突時不恢復自動保存
    expect(docReducer(state, { type: "reset", doc: { ...base, revision: 6 } }).status).toBe("saved");
  });
});
