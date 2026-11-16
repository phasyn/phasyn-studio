// A version of the open project saved elsewhere (another tab, an API client) replaces the page's version
// while nothing is unsaved, with a notice; with an unsaved edit the page keeps its version and nothing is read.
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installFakeApi } from "@/test/fakeApi";
import { renderWithProviders } from "@/test/render";
import { StudioNotices } from "../notices/StudioNotices";
import { StudioShellContext, useStudioShellValue } from "../StudioShellContext";
import { createDocReducer, type VersionedDoc } from "./docReducer";
import { useAutosaveDocument } from "./useAutosaveDocument";
import { useOutsideSaves } from "./useOutsideSaves";

interface ToyDoc extends VersionedDoc {
  project_id: string;
  title: string;
  value: number;
}

const reducer = createDocReducer<ToyDoc, { type: "add" }>((doc) => ({ ...doc, value: doc.value + 1 }), { trackPending: true });
const INITIAL: ToyDoc = { project_id: "p-1", title: "Toy", revision: 2, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", value: 1 };
const LATEST: ToyDoc = { ...INITIAL, revision: 4, value: 40 };

function Harness({ fetchLatest, autosaveMs = 5 }: { fetchLatest: () => Promise<ToyDoc>; autosaveMs?: number }) {
  const document = useAutosaveDocument({ initial: INITIAL, reducer, save: (doc) => Promise.resolve({ ...doc, revision: doc.revision + 1 }), fetchLatest, publish: () => undefined, autosaveMs });
  const shell = useStudioShellValue(document, { offerRebase: false });
  useOutsideSaves(document, shell.notify, 20);
  return (
    <StudioShellContext.Provider value={shell}>
      <button type="button" onClick={() => document.dispatch({ type: "add" })}>
        add
      </button>
      <span aria-label="value">{document.state.draft.value}</span>
      <StudioNotices />
    </StudioShellContext.Provider>
  );
}

function serveRevision(revision: () => number) {
  return installFakeApi({
    "GET /api/studio/projects": () => ({
      items: [{ project_id: "p-1", title: "Toy", revision: revision(), created_at: INITIAL.created_at, updated_at: INITIAL.updated_at, shot_count: 0, rendered_shot_count: 0 }],
    }),
  });
}

describe("versions saved elsewhere", () => {

  it("keeps an unsaved edit: nothing is read and the page keeps its version", async () => {
    let server = 2;
    const { calls } = serveRevision(() => server);
    const fetchLatest = vi.fn(() => Promise.resolve(LATEST));
    const { user } = renderWithProviders(<Harness fetchLatest={fetchLatest} autosaveMs={60_000} />);
    await user.click(screen.getByRole("button", { name: "add" }));
    server = 4;
    const seen = calls.length;
    await waitFor(() => expect(calls.length).toBeGreaterThan(seen + 1));
    expect(screen.getByLabelText("value")).toHaveTextContent("2");
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(screen.queryByText("已載入在其他地方保存的新版本")).toBeNull();
  });
});
