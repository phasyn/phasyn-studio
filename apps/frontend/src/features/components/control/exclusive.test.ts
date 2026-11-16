import { describe, expect, it, vi } from "vitest";
import type { ComponentDescriptor, ControlRequest } from "@/api/generated/contracts";
import { ApiError } from "@/api/http";
import { catalog, descriptor, type DescriptorOptions } from "@/test/fixtures";
import { NODE_A_ID, uid } from "@/test/ids";
import { ExclusiveBusy, exclusiveBlockReason, requestStart, type ConfirmReplace } from "./exclusive";

const dit = (component_id: string, options: DescriptorOptions = {}, node = NODE_A_ID) => descriptor(node, component_id, "h3.dit", { exclusive_group: "dit", state: "stopped", ...options });
const target = dit("dit-ref2va-bf16-base");

function conflictError(code: "EXCLUSIVE_GROUP_CONFLICT" | "EXCLUSIVE_GROUP_BUSY", holders: { component_id: string; state: string; active_call_id: string | null }[]) {
  return new ApiError(409, { code, message: "互斥群組 dit 已由其他成員載入", details: { group: "dit", holders } }, "HTTP 409");
}

/** A fake control endpoint: answers each request with the next queued result (a descriptor or an error). */
function fakeSend(...results: (ComponentDescriptor | Error)[]) {
  const sent: ControlRequest[] = [];
  const send = vi.fn((body: ControlRequest) => {
    sent.push(body);
    const next = results.shift() ?? { ...target, state: "loading" as const };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return { send, sent };
}

const approve: ConfirmReplace = () => Promise.resolve(true);
const decline: ConfirmReplace = () => Promise.resolve(false);

describe("exclusiveConflict（讀目錄，只作提示）", () => {

  it("閒置成員不擋（會先確認）；載入中、停止中、執行呼叫中的成員擋下並說明", () => {
    const holder = (state: ComponentDescriptor["state"], active_call_id: string | null = null) => ({ group: "dit", holders: [{ component_id: "dit-a", state, active_call_id }] });
    expect(exclusiveBlockReason(holder("ready"))).toBeNull();
    expect(exclusiveBlockReason(null)).toBeNull();
    expect(exclusiveBlockReason(holder("loading"))).toContain("正在載入");
    expect(exclusiveBlockReason(holder("stopping"))).toContain("正在停止");
    expect(exclusiveBlockReason(holder("busy"))).toContain("正在執行呼叫");
    expect(exclusiveBlockReason(holder("ready", uid(2001)))).toContain("dit-a");
  });
});

describe("requestStart（每個請求只送一次；replace_exclusive 一定先經過使用者確認）", () => {
  it("沒有其他成員：直接送 start，不確認", async () => {
    const { send, sent } = fakeSend();
    const confirm = vi.fn(approve);
    const result = await requestStart(target, { catalog: catalog([target]), confirm, send });
    expect(result).toMatchObject({ kind: "sent", replaced: [] });
    expect(sent).toEqual([{ action: "start" }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("目錄已顯示閒置成員：先確認，再送一次 replace_exclusive；restart 也一樣", async () => {
    const doc = catalog([target, dit("dit-a", { state: "ready" })]);
    const { send, sent } = fakeSend();
    const confirm = vi.fn(approve);
    const result = await requestStart(target, { action: "restart", catalog: doc, confirm, send });
    expect(confirm).toHaveBeenCalledWith({ group: "dit", holders: [{ component_id: "dit-a", state: "ready", active_call_id: null }] }, target);
    expect(sent).toEqual([{ action: "restart", replace_exclusive: true }]);
    expect(result).toMatchObject({ kind: "sent", replaced: ["dit-a"] });
  });

  it("使用者取消：什麼都不送", async () => {
    const { send } = fakeSend();
    const result = await requestStart(target, { catalog: catalog([target, dit("dit-a", { state: "ready" })]), confirm: decline, send });
    expect(result).toEqual({ kind: "declined" });
    expect(send).not.toHaveBeenCalled();
  });

  it("目錄顯示成員忙碌：丟 ExclusiveBusy，不確認也不送", async () => {
    const { send } = fakeSend();
    const confirm = vi.fn(approve);
    await expect(requestStart(target, { catalog: catalog([target, dit("dit-a", { state: "loading" })]), confirm, send })).rejects.toBeInstanceOf(ExclusiveBusy);
    expect(send).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("目錄過時、Node 回 409 CONFLICT：確認後才送第二次（replace_exclusive）", async () => {
    const holders = [{ component_id: "dit-a", state: "ready", active_call_id: null }];
    const { send, sent } = fakeSend(conflictError("EXCLUSIVE_GROUP_CONFLICT", holders));
    const confirm = vi.fn(approve);
    const result = await requestStart(target, { catalog: catalog([target]), confirm, send });
    expect(sent).toEqual([{ action: "start" }, { action: "start", replace_exclusive: true }]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "sent", replaced: ["dit-a"] });
  });

  it("Node 回 409 BUSY 或其他錯誤：原樣丟出，不確認、不重送", async () => {
    const busy = conflictError("EXCLUSIVE_GROUP_BUSY", [{ component_id: "dit-a", state: "loading", active_call_id: null }]);
    const first = fakeSend(busy);
    const confirm = vi.fn(approve);
    await expect(requestStart(target, { catalog: catalog([target]), confirm, send: first.send })).rejects.toBe(busy);
    expect(first.sent).toHaveLength(1);
    const offline = new ApiError(0, null, "network");
    const second = fakeSend(offline);
    await expect(requestStart(target, { catalog: catalog([target]), confirm, send: second.send })).rejects.toBe(offline);
    expect(second.sent).toHaveLength(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});
