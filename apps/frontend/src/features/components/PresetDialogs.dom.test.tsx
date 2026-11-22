// Deleting a preset from the apply dialog: confirmed first, one DELETE, then the list is read again. Synthetic presets.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Preset } from "@/api/generated/contracts";
import { installFakeApi } from "@/test/fakeApi";
import { descriptor } from "@/test/fixtures";
import { NODE_A_ID } from "@/test/ids";
import { renderWithProviders } from "@/test/render";
import { ApplyPresetDialog } from "./PresetDialogs";

const SETTINGS = descriptor(NODE_A_ID, "template", "h3.dit").settings.stored;
const preset = (presetId: string, label: string): Preset => ({ preset_id: presetId, label, provider_id: "h3.dit", settings: SETTINGS });

describe("preset：刪除", () => {
  it("先確認（說明已套用的設定不受影響），只送一次 DELETE，之後重新讀取清單", async () => {
    let items = [preset("fast", "快速"), preset("careful", "仔細")];
    const { calls } = installFakeApi({
      "GET /api/presets": () => ({ items }),
      "DELETE /api/presets/fast": () => {
        items = items.filter((item) => item.preset_id !== "fast");
        return { preset_id: "fast", deleted: true };
      },
    });
    const { user } = renderWithProviders(<ApplyPresetDialog target={{ providerId: "h3.dit", draft: SETTINGS }} onOpenChange={() => undefined} onApply={() => undefined} />);
    await user.click(await screen.findByRole("button", { name: "刪除 preset「快速」" }));
    const confirm = await screen.findByRole("dialog", { name: "刪除 preset「快速」？" });
    expect(within(confirm).getByText(/已套用過它的元件設定不受影響/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "刪除 preset" }));
    await waitFor(() => { expect(screen.queryByRole("dialog", { name: "刪除 preset「快速」？" })).not.toBeInTheDocument(); });
    await waitFor(() => { expect(screen.queryByText("快速")).not.toBeInTheDocument(); });
    expect(screen.getByText("仔細")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/presets/fast"]);
    expect(calls.filter((call) => call.method === "GET" && call.path === "/api/presets").length).toBeGreaterThanOrEqual(2);
  });

  it("取消確認就不送出", async () => {
    const { calls } = installFakeApi({ "GET /api/presets": () => ({ items: [preset("fast", "快速")] }) });
    const { user } = renderWithProviders(<ApplyPresetDialog target={{ providerId: "h3.dit", draft: SETTINGS }} onOpenChange={() => undefined} onApply={() => undefined} />);
    await user.click(await screen.findByRole("button", { name: "刪除 preset「快速」" }));
    const confirm = await screen.findByRole("dialog", { name: "刪除 preset「快速」？" });
    await user.click(within(confirm).getByRole("button", { name: "取消" }));
    await waitFor(() => { expect(screen.queryByRole("dialog", { name: "刪除 preset「快速」？" })).not.toBeInTheDocument(); });
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
  });
});
