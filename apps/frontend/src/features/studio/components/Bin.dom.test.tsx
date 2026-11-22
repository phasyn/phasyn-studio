import { contractFixture, fixtureValue } from "@/test/fixtures";
// The project panel's boundaries on the saved document. Assets tab: an item nothing uses is removed after confirming
// (autosave sends the library without it and focus moves to the next item); an item still in use names where it is used
// and cannot be removed, and its shot can be selected from there; the One-Click Character Swap source video is never
// removable. Shots tab: a length chosen for a multi-selection reaches exactly the selected shots in the saved project,
// and deleting a multi-selection removes exactly the shots that can go (a rendering one stays).
// The network is the in-memory Controller.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StudioImageShot, StudioLibraryItem, StudioProject } from "@/api/generated/contracts";
import { installFakeApi, type FakeRequest } from "@/test/fakeApi";
import { studioProject, studioShot, studioTake } from "@/test/fixtures";
import { FIXED_TIME, uid } from "@/test/ids";
import { renderWithProviders } from "@/test/render";
import { exampleCatalog, t2vaPipeline } from "../model/studioFixtures";
import { jobNote } from "../swap/job";
import { StudioProvider } from "../StudioProvider";
import { useStudio } from "../studioContext";
import { Bin } from "./Bin";

function item(itemId: string, name: string, kind: StudioLibraryItem["kind"], createdAt: string, patch: Partial<StudioLibraryItem> = {}): StudioLibraryItem {
  return {
    item_id: itemId,
    kind,
    name,
    file: { node_id: "n", file_id: itemId, size_bytes: 1, sha256: "0".repeat(64), media_type: `${kind}/x`, metadata: {} },
    created_at: createdAt,
    duration_seconds: kind === "image" ? null : 5,
    width: null,
    height: null,
    has_audio: kind === "image" ? false : null,
    ...patch,
  };
}

/** An Image Studio image that uses lib-a as its only reference image. */
function imageShot(): StudioImageShot {
  return {
    image_shot_id: "img-1",
    title: "海報",
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
    references: [{ item_id: "lib-a", order: 0 }],
    base_index: 0,
    reference_resolution: 1024,
    mask_item_id: null,
    mask_invert: false,
    decode: "full",
    preview: { mode: "off", every: 1 },
    takes: [],
    active_take_id: null,
    note: "",
  };
}

function SelectedShot() {
  const { selectedShotId } = useStudio();
  return <output aria-label="selected shot">{selectedShotId}</output>;
}

function renderBin(project: StudioProject) {
  const api = installFakeApi({
    "GET /api/catalog": () => exampleCatalog(),
    "GET /api/pipelines": () => ({ items: [t2vaPipeline()] }),
    "GET /api/runs": () => ({ items: [], next_cursor: null }),
    "GET /api/cost-profiles": () => ({ computed_at: FIXED_TIME, items: [] }),
    "PUT /api/studio/projects/project-1": ({ body }: FakeRequest) => { const doc = contractFixture("StudioProject", body); return { ...doc, revision: doc.revision + 1 }; },
  });
  const view = renderWithProviders(
    <StudioProvider initial={project}>
      <Bin />
      <SelectedShot />
    </StudioProvider>,
    { route: "/studio/generate?project=project-1" },
  );
  return { ...view, calls: api.calls };
}

/** The last project document the panel saved. */
async function lastSave(calls: FakeRequest[]): Promise<StudioProject> {
  await waitFor(() => { expect(calls.some((call) => call.method === "PUT")).toBe(true); }, { timeout: 3000 });
  return contractFixture("StudioProject", calls.filter((call) => call.method === "PUT").at(-1)?.body);
}

describe("Bin project library removal", () => {
  it("removes an unused item after confirming, saves the library without it and focuses the next item", async () => {
    const library = [item("lib-new", "new.png", "image", "2026-10-18T00:00:00.000Z"), item("lib-old", "old.mp4", "video", "2026-10-17T00:00:00.000Z")];
    const { user, calls } = renderBin(studioProject({ library }));
    await user.click(screen.getByRole("tab", { name: /素材/ }));
    expect(within(screen.getByRole("list", { name: "參考素材庫" })).getAllByText(/還沒有鏡頭使用/)).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "「new.png」的動作" }));
    await user.click(screen.getByRole("menuitem", { name: "從專案素材庫移除…" }));
    const dialog = await screen.findByRole("dialog", { name: "從專案素材庫移除「new.png」？" });
    expect(within(dialog).getByText(/不會刪除檔案/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "移除" }));

    await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
    expect(screen.queryByText("new.png")).toBeNull();
    await waitFor(() => { expect(screen.getByRole("button", { name: "在素材庫查看「old.mp4」" })).toHaveFocus(); });
    const saved = await lastSave(calls);
    expect(saved.library?.map((entry) => entry.item_id)).toEqual(["lib-old"]);
  });

  it("names where an item is used, keeps Remove disabled and selects the shot from there", async () => {
    const library = [item("lib-a", "hero.png", "image", "2026-10-18T00:00:00.000Z")];
    const shots = [
      studioShot({ shot_id: "shot-1", title: "開場" }),
      studioShot({ shot_id: "shot-2", title: "雨夜", references: [{ ref_id: "r1", kind: "image", alias: "Image1", item_id: "lib-a", start_seconds: null, end_seconds: null }] }),
    ];
    const { user, calls } = renderBin(studioProject({ library, shots, image_shots: [imageShot()] }));
    expect(screen.getByRole("status", { name: "selected shot" })).toHaveTextContent("shot-1");
    await user.click(screen.getByRole("tab", { name: /素材/ }));
    expect(screen.getByText(/1 個鏡頭使用・1 張 Image Studio 圖片使用/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "「hero.png」的動作" }));
    await user.click(screen.getByRole("menuitem", { name: "從專案素材庫移除…" }));
    const dialog = await screen.findByRole("dialog", { name: "從專案素材庫移除「hero.png」？" });
    expect(within(dialog).getByText(/還在使用中/)).toBeInTheDocument();
    const uses = within(dialog).getByRole("list", { name: "使用這個素材的地方（2）" });
    const [shotUse, imageUse] = within(uses).getAllByRole("listitem");
    expect(shotUse).toHaveTextContent("02雨夜參考 @Image1在屬性面板的「參考」分頁移除");
    expect(imageUse).toHaveTextContent("Image Studio・海報參考圖片在 Image Studio 的「圖片」分頁移除");
    expect(within(fixtureValue(imageUse, "Bin.dom.test.tsx")).getByRole("link", { name: "在 Image Studio 開啟" })).toHaveAttribute("href", "/image?project=project-1&shot=img-1");
    expect(within(dialog).getByRole("button", { name: "移除" })).toBeDisabled();

    await user.click(within(fixtureValue(shotUse, "Bin.dom.test.tsx")).getByRole("button", { name: "選取鏡頭" }));
    await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
    expect(screen.getByRole("status", { name: "selected shot" })).toHaveTextContent("shot-2");
    expect(screen.getByText("hero.png")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("never removes the One-Click Character Swap source video", async () => {
    const note = jobNote({ v: 1, fps: 24, start_frame: 0, end_frame: 240, max_frames: 124, crossfade_frames: 12, audio: "original", auto_export: false, segments: 0, mid_shot_joins: 0, created_at: FIXED_TIME });
    const library = [item("lib-src", "source.mp4", "video", "2026-10-18T00:00:00.000Z", { note })];
    const { user } = renderBin(studioProject({ library }));
    await user.click(screen.getByRole("tab", { name: /素材/ }));
    expect(screen.getByText(/一鍵換角的來源影片/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "「source.mp4」的動作" }));
    await user.click(screen.getByRole("menuitem", { name: "從專案素材庫移除…" }));
    const dialog = await screen.findByRole("dialog", { name: "從專案素材庫移除「source.mp4」？" });
    expect(within(dialog).getByText("這段影片是一鍵換角的來源影片，不能從素材庫移除。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "移除" })).toBeDisabled();
  });
});

describe("Bin shot multi-selection", () => {
  const shots = () => [
    studioShot({ shot_id: "shot-1", title: "開場" }),
    studioShot({ shot_id: "shot-2", title: "雨夜" }),
    studioShot({ shot_id: "shot-3", title: "追逐" }),
    studioShot({ shot_id: "shot-4", title: "收尾" }),
  ];

  it("gives a Shift-selected range one length and saves exactly those shots", async () => {
    const { user, calls } = renderBin(studioProject({ shots: shots() }));
    await user.click(screen.getByRole("option", { name: /開場/ }));
    await user.keyboard("[ShiftLeft>]");
    await user.click(screen.getByRole("option", { name: /追逐/ }));
    await user.keyboard("[/ShiftLeft]");
    expect(screen.getByRole("toolbar", { name: "選取的鏡頭" })).toHaveTextContent("已選取 3 個");

    await user.click(screen.getByRole("button", { name: "把選取的鏡頭改成同一個時長" }));
    const duration = screen.getByRole("dialog", { name: "把選取的鏡頭改成同一個時長" });
    const frames = within(duration).getByRole("spinbutton", { name: "影格數" });
    await user.clear(frames);
    await user.type(frames, "107");
    await user.click(within(duration).getByRole("button", { name: "套用" }));
    const saved = await lastSave(calls);
    expect(saved.shots.map((shot) => [shot.shot_id, shot.frames])).toEqual([
      ["shot-1", 107],
      ["shot-2", 107],
      ["shot-3", 107],
      ["shot-4", 124],
    ]);
  });

  it("deletes the selected shots that can go and keeps the one that is rendering", async () => {
    const list = shots();
    list[1] = studioShot({ shot_id: "shot-2", title: "雨夜", takes: [studioTake({ take_id: "take-r", run_id: uid(1201), state: "rendering", asset: null })] });
    const { user, calls } = renderBin(studioProject({ shots: list.slice(0, 3) }));
    await user.click(screen.getByRole("option", { name: /開場/ }));
    await user.keyboard("{Control>}a{/Control}");
    expect(screen.getByRole("toolbar", { name: "選取的鏡頭" })).toHaveTextContent("已選取 3 個");

    await user.keyboard("{Delete}");
    const dialog = await screen.findByRole("dialog", { name: "刪除 2 個鏡頭？" });
    expect(within(dialog).getByText(/雨夜：這個鏡頭正在渲染/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "刪除 2 個鏡頭" }));
    const saved = await lastSave(calls);
    expect(saved.shots.map((shot) => shot.shot_id)).toEqual(["shot-2"]);
  });
});
