import { describe, expect, it } from "vitest";
import { createDocReducer, initialDocState, type DocEvent, type DocState } from "./docReducer";

interface Doc {
  revision: number;
  created_at: string;
  updated_at: string;
  items: string[];
}
type Action = { type: "add"; item: string } | { type: "noop" };

const apply = (doc: Doc, action: Action): Doc => (action.type === "add" && !doc.items.includes(action.item) ? { ...doc, items: [...doc.items, action.item] } : doc);
const doc = (revision: number, items: string[] = []): Doc => ({ revision, created_at: "c", updated_at: `u${revision}`, items });
const tracked = createDocReducer(apply, { trackPending: true });
const plain = createDocReducer(apply);
const run = (reducer: typeof tracked, state: DocState<Doc, Action>, ...events: DocEvent<Doc, Action>[]) => events.reduce(reducer, state);

describe("createDocReducer", () => {

  it("keeps edits made while a save is in flight and saves them next on the new revision", () => {
    const saving = run(tracked, initialDocState(doc(3)), { type: "edit", action: { type: "add", item: "a" } }, { type: "saveStart" }, { type: "edit", action: { type: "add", item: "b" } });
    expect(saving.status).toBe("saving");
    const saved = run(tracked, saving, { type: "saveOk", saved: doc(4, ["a"]), seq: 1, generation: 0 });
    expect(saved).toMatchObject({ status: "dirty", savedSeq: 1, draft: { revision: 4, items: ["a", "b"] } });
    expect(saved.pending.map((item) => item.seq)).toEqual([2]);
    expect(run(tracked, saved, { type: "saveOk", saved: doc(5, ["a", "b"]), seq: 2, generation: 0 })).toMatchObject({ status: "saved", pending: [] });
  });

  it("stays in conflict through later edits; reset starts over and drops results of saves sent before it", () => {
    const conflicted = run(plain, initialDocState(doc(3)), { type: "edit", action: { type: "add", item: "a" } }, { type: "conflict", error: null, storedRevision: 6, generation: 0 }, { type: "edit", action: { type: "add", item: "b" } });
    expect(conflicted).toMatchObject({ status: "conflict", storedRevision: 6 });
    const reset = run(plain, conflicted, { type: "reset", doc: doc(6) });
    expect(reset).toMatchObject({ status: "saved", generation: 1, draft: { revision: 6, items: [] } });
    // A save sent before the reset answers late: ignored
    expect(run(plain, reset, { type: "saveOk", saved: doc(7, ["a", "b"]), seq: 2, generation: 0 })).toBe(reset);
    expect(run(plain, reset, { type: "saveError", error: new Error("late"), generation: 0 })).toBe(reset);
  });

  it("refresh takes a newer version saved elsewhere only while nothing is unsaved", () => {
    const start = initialDocState<Doc, Action>(doc(3, ["a"]));
    const refreshed = run(tracked, start, { type: "refresh", doc: doc(5, ["a", "agent"]) });
    expect(refreshed).toMatchObject({ status: "saved", generation: 1, refreshedRevision: 5, draft: { revision: 5, items: ["a", "agent"] } });
    // Not newer, or something unsaved (an edit, a save in flight, a conflict): the page keeps its version
    expect(run(tracked, start, { type: "refresh", doc: doc(3, ["other"]) })).toBe(start);
    const dirty = run(tracked, start, { type: "edit", action: { type: "add", item: "mine" } });
    expect(run(tracked, dirty, { type: "refresh", doc: doc(5, ["agent"]) })).toBe(dirty);
    const saving = run(tracked, dirty, { type: "saveStart" });
    expect(run(tracked, saving, { type: "refresh", doc: doc(5, ["agent"]) })).toBe(saving);
    // A save sent before the refresh answers late: ignored; the next edit starts from the refreshed version
    expect(run(tracked, refreshed, { type: "saveOk", saved: doc(4, ["a", "mine"]), seq: 1, generation: 0 })).toBe(refreshed);
    expect(run(tracked, refreshed, { type: "edit", action: { type: "add", item: "b" } }).draft).toMatchObject({ revision: 5, items: ["a", "agent", "b"] });
  });

  it("keep both: re-applies the unsaved actions on the latest version; nothing left to save when none applies", () => {
    const conflicted = run(tracked, initialDocState(doc(3)), { type: "edit", action: { type: "add", item: "mine" } }, { type: "conflict", error: null, storedRevision: 9, generation: 0 });
    const merged = run(tracked, conflicted, { type: "rebase", latest: doc(9, ["theirs"]) });
    expect(merged).toMatchObject({ status: "dirty", generation: 1, draft: { revision: 9, items: ["theirs", "mine"] } });
    const already = run(tracked, conflicted, { type: "rebase", latest: doc(9, ["mine"]) });
    expect(already).toMatchObject({ status: "saved", pending: [] });
    expect(already.savedSeq).toBe(already.editSeq);
  });
});
