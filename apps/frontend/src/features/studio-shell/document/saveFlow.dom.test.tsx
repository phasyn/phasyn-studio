import { fixtureProject } from "@/test/fixtures";
// The shell's save flow as a user sees it: an edit marks the document unsaved, autosave sends it once and the indicator
// shows the new revision; a revision conflict pauses autosave and shows the banner, where "load the latest" drops the
// local edits and "keep both" re-applies them on the server version (only where the Studio offers it).
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/http";
import { renderWithProviders } from "@/test/render";
import { ConflictBanner } from "../ConflictBanner";
import { SaveIndicator } from "../SaveIndicator";
import { StudioShellContext, useStudioShellValue } from "../StudioShellContext";
import { createDocReducer, type VersionedDoc } from "./docReducer";
import { useAutosaveDocument } from "./useAutosaveDocument";

interface ToyDoc extends VersionedDoc {
  project_id: string;
  title: string;
  value: number;
}

interface ToyAction { type: "add"; amount: number }

const reducer = createDocReducer<ToyDoc, ToyAction>((doc, action) => ({ ...doc, value: doc.value + action.amount }), { trackPending: true });

const INITIAL: ToyDoc = { project_id: "p-1", title: "Toy", revision: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", value: 0 };

type Save = (doc: ToyDoc) => Promise<ToyDoc>;

function Harness({ save, fetchLatest, offerRebase }: { save: Save; fetchLatest: () => Promise<ToyDoc>; offerRebase: boolean }) {
  const document = useAutosaveDocument({ initial: INITIAL, parseMerged: fixtureProject, reducer, save, fetchLatest, publish: () => undefined, autosaveMs: 5 });
  const shell = useStudioShellValue(document, { offerRebase });
  return (
    <StudioShellContext value={shell}>
      <button type="button" onClick={() => { document.dispatch({ type: "add", amount: 1 }); }}>
        add
      </button>
      <span aria-label="value">{document.state.draft.value}</span>
      <SaveIndicator />
      <ConflictBanner />
    </StudioShellContext>
  );
}

const savedAs = (doc: ToyDoc): Promise<ToyDoc> => Promise.resolve({ ...doc, revision: doc.revision + 1 });
const conflict = () => Promise.reject(new ApiError(409, { code: "REVISION_CONFLICT", message: "revision conflict", details: { stored_revision: 5 } }, "conflict"));
const LATEST: ToyDoc = { ...INITIAL, revision: 5, value: 42 };

describe("studio shell save flow", () => {

  it("pauses on a revision conflict; loading the latest drops the local edit", async () => {
    const save = vi.fn<Save>(conflict);
    const { user } = renderWithProviders(<Harness save={save} fetchLatest={() => Promise.resolve(LATEST)} offerRebase={false} />);
    await user.click(screen.getByRole("button", { name: "add" }));
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("r5");
    expect(screen.queryByRole("button", { name: "保留兩邊" })).toBeNull();
    // Autosave stays paused while the conflict is open: another edit sends nothing
    await user.click(screen.getByRole("button", { name: "add" }));
    expect(save).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "載入最新版（捨棄這裡的變更）" }));
    await waitFor(() => { expect(screen.queryByRole("alert")).toBeNull(); });
    expect(screen.getByLabelText("value")).toHaveTextContent("42");
    expect(screen.getByText("r5")).toBeInTheDocument();
    // Saving works again after the conflict: announced once
    expect(screen.getByRole("status")).toHaveTextContent("已儲存");
  });

  it("keeps both: re-applies the unsaved edits on the latest version and saves them", async () => {
    let fail = true;
    const save = vi.fn<Save>((doc) => (fail ? conflict() : savedAs(doc)));
    const { user } = renderWithProviders(<Harness save={save} fetchLatest={() => Promise.resolve(LATEST)} offerRebase />);
    await user.click(screen.getByRole("button", { name: "add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1");
    fail = false;
    await user.click(screen.getByRole("button", { name: "保留兩邊" }));
    // Keep both first lists the edits it will replay and waits for a confirmation
    await user.click(await screen.findByRole("button", { name: "確認重新套用" }));
    await waitFor(() => { expect(screen.getByText("r6")).toBeInTheDocument(); });
    expect(screen.getByLabelText("value")).toHaveTextContent("43");
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ revision: 5, value: 43 });
  });
});
