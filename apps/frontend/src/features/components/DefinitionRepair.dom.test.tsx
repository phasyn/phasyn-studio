// A stored definition the provider refuses (last_error UNSUPPORTED_SETTING): unknown fields are removed by replacing the
// whole definition (confirmed, stopped only, sent once); unsupported values open the settings editor. The detail
// strings are what the Node's check produces; the network is the in-memory Controller (installFakeApi).
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NodeView } from "@/api/catalog";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { installFakeApi } from "@/test/fakeApi";
import { catalog, descriptor } from "@/test/fixtures";
import { NODE_A_ID, NODE_A_LABEL } from "@/test/ids";
import { renderWithProviders } from "@/test/render";
import { DefinitionRepair } from "./DefinitionRepair";

const node: NodeView = { node_id: NODE_A_ID, label: NODE_A_LABEL, snapshot: null, directory: null, liveness: "online", stale: false };
const LAST_ERROR = {
  code: "UNSUPPORTED_SETTING",
  message: "provider 不支援此設定：invoke: Additional properties are not allowed ('bogus' was unexpected)",
  details: {
    errors: ["invoke: Additional properties are not allowed ('bogus' was unexpected)", "load/precision/compute_dtype: 'int3' is not one of ['bf16', 'fp16']"],
  },
};

function refusedEntry(state: ComponentDescriptor["state"]) {
  const refused = descriptor(NODE_A_ID, "seeded", "h3.dit", { runtime_id: "h3", state, exclusive_group: "dit", limits: { example: { max_items: 2 } }, folder: "生成/DiT", last_error: LAST_ERROR });
  const stored = refused.settings.stored;
  return { refused, draft: { ...stored, invoke: { ...stored.invoke, bogus: 1 } } };
}

describe("DefinitionRepair", () => {
  it("列出不認得的欄位與不支援的值；值可跳到設定；確認後以 PUT 送出移除欄位後的整份定義（只送一次）", async () => {
    const { refused, draft } = refusedEntry("stopped");
    const { calls } = installFakeApi({
      [`PUT /api/nodes/${NODE_A_ID}/components/seeded`]: (request) => ({ ...refused, ...(request.body as object), last_error: null }),
      "GET /api/catalog": () => catalog([{ ...refused, last_error: null }]),
    });
    const onJump = vi.fn();
    const onReplaced = vi.fn();
    const entry = { descriptor: refused, node, key: `${NODE_A_ID}::seeded` };
    const { user } = renderWithProviders(<DefinitionRepair entry={entry} draft={draft} draftChanged={false} onJump={onJump} onReplaced={onReplaced} />);

    expect(within(screen.getByRole("list", { name: "provider 不認得的欄位" })).getByText("invoke.bogus")).toBeInTheDocument();
    await user.click(within(screen.getByRole("list", { name: "不支援的值" })).getByRole("button", { name: "load.precision.compute_dtype" }));
    expect(onJump).toHaveBeenCalledWith("load.precision.compute_dtype");

    await user.click(screen.getByRole("button", { name: "移除這些欄位並替換定義…" }));
    const dialog = await screen.findByRole("dialog", { name: "移除 1 個欄位並替換定義？" });
    expect(within(dialog).getByText(/只有 stopped 時才能替換定義/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "移除並替換定義" }));
    await waitFor(() => expect(onReplaced).toHaveBeenCalled());

    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(1);
    const body = puts[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ component_id: "seeded", provider_id: "h3.dit", runtime_id: "h3", exclusive_group: "dit", limits: { example: { max_items: 2 } }, folder: "生成/DiT", autostart: false });
    expect(body.settings).toEqual(refused.settings.stored);
  });

  it("不是 stopped 時擋下替換、不開確認", async () => {
    const { refused, draft } = refusedEntry("error");
    installFakeApi({});
    const entry = { descriptor: refused, node, key: `${NODE_A_ID}::seeded` };
    const { user } = renderWithProviders(<DefinitionRepair entry={entry} draft={draft} draftChanged={false} onJump={() => undefined} onReplaced={() => undefined} />);
    const button = screen.getByRole("button", { name: "移除這些欄位並替換定義…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("只有 stopped 時才能替換定義（目前 error）");
    await user.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
