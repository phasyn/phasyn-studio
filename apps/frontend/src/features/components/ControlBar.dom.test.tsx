// Exclusive groups from the user's side: the Node decides conflicts; the UI confirms
// before replace_exclusive and never offers a replacement for a busy member. The network is the shared in-memory Controller (installFakeApi).
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NodeView } from "@/api/catalog";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { fakeError, installFakeApi, type FakeHandler, type FakeRequest } from "@/test/fakeApi";
import { catalog, descriptor } from "@/test/fixtures";
import { NODE_A_ID, NODE_A_LABEL } from "@/test/ids";
import { renderWithProviders } from "@/test/render";
import { ControlBar } from "./ControlBar";

/** Answers with the given replies in turn (the last one repeats). */
function replies(...queue: unknown[]): FakeHandler {
  let index = 0;
  return () => queue[Math.min(index++, queue.length - 1)];
}

const target = descriptor(NODE_A_ID, "dit-a", "h3.dit", { exclusive_group: "dit", state: "stopped", resourceGroup: "gpu-0" });
const node: NodeView = { node_id: NODE_A_ID, label: NODE_A_LABEL, snapshot: null, directory: null, liveness: "online", stale: false };
const entry = { descriptor: target, node, key: `${NODE_A_ID}::dit-a` };
const CONTROL = `POST /api/nodes/${NODE_A_ID}/components/dit-a/control`;
const RECORDINGS: FakeHandler = () => ({ items: [], next_cursor: null });

function conflict(code: "EXCLUSIVE_GROUP_CONFLICT" | "EXCLUSIVE_GROUP_BUSY", state: ComponentDescriptor["state"]): Response {
  return fakeError(409, code, `互斥群組 dit 的 dit-b ${state}`, { group: "dit", holders: [{ component_id: "dit-b", state, active_call_id: null }] });
}

const controlBodies = (calls: readonly FakeRequest[]) => calls.filter((call) => call.method === "POST").map((call) => call.body);

describe("ControlBar：互斥群組（exclusive_group）", () => {
  it("Node 回 CONFLICT → 確認框列出要停止的元件 → 確認後第二次請求帶 replace_exclusive", async () => {
    const { calls } = installFakeApi({
      "GET /api/catalog": () => catalog([target]),
      "GET /api/recordings": RECORDINGS,
      [CONTROL]: replies(conflict("EXCLUSIVE_GROUP_CONFLICT", "ready"), { ...target, state: "loading" }),
    });
    const { user } = renderWithProviders(<ControlBar entry={entry} />);
    await user.click(screen.getByRole("button", { name: "啟動" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("停止 dit-b 並啟動 dit-a？")).toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "會被停止的元件" })).toHaveTextContent("dit-b");
    await user.click(within(dialog).getByRole("button", { name: "停止並啟動" }));
    await waitFor(() => { expect(controlBodies(calls)).toEqual([{ action: "start" }, { action: "start", replace_exclusive: true }]); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("目錄已顯示閒置成員：先提示並確認；取消就什麼都不送", async () => {
    const holder = descriptor(NODE_A_ID, "dit-b", "h3.dit", { exclusive_group: "dit", state: "ready", resourceGroup: "gpu-0" });
    const { calls } = installFakeApi({ "GET /api/catalog": () => catalog([target, holder]), "GET /api/recordings": RECORDINGS });
    const { user } = renderWithProviders(<ControlBar entry={entry} />);
    expect(await screen.findByText(/啟動會先停止 dit-b/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "啟動" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => { expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); });
    expect(controlBodies(calls)).toEqual([]);
  });

  it("Node 回 BUSY：顯示原因，不提供取代、不重送", async () => {
    const { calls } = installFakeApi({
      "GET /api/catalog": () => catalog([target]),
      "GET /api/recordings": RECORDINGS,
      [CONTROL]: () => conflict("EXCLUSIVE_GROUP_BUSY", "loading"),
    });
    const { user } = renderWithProviders(<ControlBar entry={entry} />);
    await user.click(screen.getByRole("button", { name: "啟動" }));
    expect(await screen.findByText("互斥群組 dit 的 dit-b loading")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止並啟動" })).not.toBeInTheDocument();
    expect(controlBodies(calls)).toEqual([{ action: "start" }]);
  });
});
