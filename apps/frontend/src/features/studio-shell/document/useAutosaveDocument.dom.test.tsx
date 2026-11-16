// Leaving a document (switching project or Studio) never loses edits nothing has saved yet: they are sent once, and
// when a save is still in flight they go after it, on the revision it creates — on the old revision they would only
// conflict. Nothing is sent when every edit is saved or being saved, and nothing after a conflict.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/http";
import { createDocReducer, type VersionedDoc } from "./docReducer";
import { useAutosaveDocument } from "./useAutosaveDocument";

interface ToyDoc extends VersionedDoc {
  value: number;
}

type ToyAction = { type: "add" };

const reducer = createDocReducer<ToyDoc, ToyAction>((doc) => ({ ...doc, value: doc.value + 1 }));
const INITIAL: ToyDoc = { revision: 3, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", value: 0 };

type Save = (doc: ToyDoc, options: { keepalive?: boolean }) => Promise<ToyDoc>;

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The first save waits for the test; later ones answer at once with the next revision. */
function setup() {
  const first = deferred<ToyDoc>();
  let calls = 0;
  const save = vi.fn<Save>((doc) => {
    calls += 1;
    return calls === 1 ? first.promise : Promise.resolve({ ...doc, revision: doc.revision + 1 });
  });
  const hook = renderHook(() => useAutosaveDocument({ initial: INITIAL, reducer, save, fetchLatest: () => Promise.resolve(INITIAL), publish: () => undefined, autosaveMs: 1 }));
  return { first, save, ...hook };
}

async function editThenStartSaving(hook: ReturnType<typeof setup>) {
  act(() => hook.result.current.dispatch({ type: "add" }));
  await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(1));
  expect(hook.result.current.state.status).toBe("saving");
}

describe("leaving a document", () => {
  it("sends edits made during an in-flight save after it, on the revision it creates", async () => {
    const hook = setup();
    await editThenStartSaving(hook);
    act(() => hook.result.current.dispatch({ type: "add" }));
    hook.unmount();
    expect(hook.save).toHaveBeenCalledTimes(1);
    await act(async () => {
      hook.first.resolve({ ...INITIAL, revision: 4, value: 1 });
      await hook.first.promise;
    });
    await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(2));
    expect(hook.save.mock.calls[1]).toEqual([expect.objectContaining({ value: 2, revision: 4 }), { keepalive: true }]);
  });

  it("after a failed save sends the newer edits once on the old revision, and after a conflict not at all", async () => {
    const failed = setup();
    await editThenStartSaving(failed);
    act(() => failed.result.current.dispatch({ type: "add" }));
    failed.unmount();
    await act(async () => {
      failed.first.reject(new Error("offline"));
      await failed.first.promise.catch(() => undefined);
    });
    await waitFor(() => expect(failed.save).toHaveBeenCalledTimes(2));
    expect(failed.save.mock.calls[1]).toEqual([expect.objectContaining({ value: 2, revision: 3 }), { keepalive: true }]);

    const conflict = setup();
    await editThenStartSaving(conflict);
    act(() => conflict.result.current.dispatch({ type: "add" }));
    conflict.unmount();
    await act(async () => {
      conflict.first.reject(new ApiError(409, { code: "REVISION_CONFLICT", message: "conflict", details: {} }, "conflict"));
      await conflict.first.promise.catch(() => undefined);
    });
    expect(conflict.save).toHaveBeenCalledTimes(1);
  });

  it("sends unsaved edits at once when no save is in flight", () => {
    const save = vi.fn<Save>((doc) => Promise.resolve({ ...doc, revision: doc.revision + 1 }));
    const hook = renderHook(() => useAutosaveDocument({ initial: INITIAL, reducer, save, fetchLatest: () => Promise.resolve(INITIAL), publish: () => undefined, autosaveMs: 60_000 }));
    act(() => hook.result.current.dispatch({ type: "add" }));
    hook.unmount();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toEqual([expect.objectContaining({ value: 1, revision: 3 }), { keepalive: true }]);
  });
});

// After a revision conflict the server's newest version is read once (nothing is resent). When it already holds every
// unsaved edit — another tab of the same project wrote back the same render results — it becomes the saved state: no
// conflict, and autosave goes on from it. Otherwise the conflict stands and autosave pauses as before.
describe("after a revision conflict", () => {
  interface SetDoc extends VersionedDoc {
    values: Record<string, number>;
  }
  type SetAction = { type: "set"; key: string; value: number };
  // Always a new object, as many edit reducers return for a value that does not change: equality is by content
  const tracking = createDocReducer<SetDoc, SetAction>((doc, action) => ({ ...doc, values: { ...doc.values, [action.key]: action.value } }), { trackPending: true });
  const BASE: SetDoc = { revision: 3, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", values: { take: 0, title: 0 } };
  const conflict = () => Promise.reject(new ApiError(409, { code: "REVISION_CONFLICT", message: "revision conflict", details: { stored_revision: 5 } }, "conflict"));

  function setupConflict(latest: SetDoc) {
    let calls = 0;
    const save = vi.fn<(doc: SetDoc, options: { keepalive?: boolean }) => Promise<SetDoc>>((doc) => {
      calls += 1;
      return calls === 1 ? conflict() : Promise.resolve({ ...doc, revision: doc.revision + 1 });
    });
    const fetchLatest = vi.fn(() => Promise.resolve(latest));
    const hook = renderHook(() => useAutosaveDocument({ initial: BASE, reducer: tracking, save, fetchLatest, publish: () => undefined, autosaveMs: 1 }));
    return { save, fetchLatest, ...hook };
  }

  it("takes the server version as saved when it already holds every unsaved edit, and keeps autosaving; otherwise the conflict stands", async () => {
    // The other tab wrote back the same result and also changed another field
    const synced = setupConflict({ ...BASE, revision: 5, values: { take: 1, title: 2 } });
    act(() => synced.result.current.dispatch({ type: "set", key: "take", value: 1 }));
    await waitFor(() => expect(synced.result.current.state.status).toBe("saved"));
    expect(synced.fetchLatest).toHaveBeenCalledTimes(1);
    expect(synced.result.current.state.draft).toMatchObject({ revision: 5, values: { take: 1, title: 2 } });
    act(() => synced.result.current.dispatch({ type: "set", key: "title", value: 3 }));
    await waitFor(() => expect(synced.result.current.state.draft.revision).toBe(6));
    expect(synced.save).toHaveBeenCalledTimes(2);
    expect(synced.save.mock.calls[1]?.[0]).toMatchObject({ revision: 5, values: { take: 1, title: 3 } });
    synced.unmount();

    // The server lacks the unsaved edit: a real conflict, autosave pauses
    const conflicting = setupConflict({ ...BASE, revision: 5, values: { take: 0, title: 2 } });
    act(() => conflicting.result.current.dispatch({ type: "set", key: "take", value: 1 }));
    await waitFor(() => expect(conflicting.result.current.state.status).toBe("conflict"));
    expect(conflicting.result.current.state).toMatchObject({ storedRevision: 5, draft: { revision: 3, values: { take: 1, title: 0 } } });
    act(() => conflicting.result.current.dispatch({ type: "set", key: "title", value: 9 }));
    expect(conflicting.save).toHaveBeenCalledTimes(1);
  });
});
