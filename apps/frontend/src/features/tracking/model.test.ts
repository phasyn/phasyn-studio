import { describe, expect, it } from "vitest";
import type { ComponentEntry, NodeView } from "@/api/catalog";
import type { ComponentDescriptor, SettingsView } from "@/api/generated/contracts";
import {
  buildRows,
  changedKeys,
  initialResults,
  planBulk,
  planDraftSaves,
  rebaseDraft,
  RECORDER_DEFAULTS,
  setDraftField,
  type TrackingRow,
} from "./model";

// 合成示例：只為單元測試建構的最小目錄資料，不代表任何實際 Node。
function node(nodeId: string, stale = false): NodeView {
  return { node_id: nodeId, label: nodeId.toUpperCase(), snapshot: null, directory: null, liveness: stale ? "offline" : "online", stale };
}

function view(recording: Record<string, unknown>, revision: number): SettingsView {
  return {
    stored_revision: revision,
    loaded_revision: null,
    stored: { load: { device: { kind: "cpu", id: "cpu", resource_group: "cpu" } }, invoke: {}, recording: recording as never },
    loaded: null,
    restart_required: false,
    settings_schema: {},
    parameters_schema: {},
  };
}

function entry(nodeView: NodeView, componentId: string, recording: Record<string, unknown>, revision = 3): ComponentEntry {
  const descriptor = {
    component_id: componentId,
    label: "",
    provider_id: componentId.startsWith("echo") ? "test.echo" : "h3.dit",
    runtime_id: "rt",
    node_id: nodeView.node_id,
    state: "ready",
    recorder_state: "ok",
    settings: view(recording, revision),
  } as unknown as ComponentDescriptor;
  return { descriptor, node: nodeView, key: `${nodeView.node_id}::${componentId}` };
}

const full = { ...RECORDER_DEFAULTS, mode: "detailed" };
const nodeA = node("node-a");
const nodeB = node("node-b", true);
const entries = [entry(nodeA, "dit", { ...full }), entry(nodeA, "echo", { mode: "summary" }, 7), entry(nodeB, "dit2", { ...full })];

function rows(local = new Map<string, SettingsView>()): TrackingRow[] {
  return buildRows(entries, local);
}

function rowOf(list: TrackingRow[], key: string): TrackingRow {
  const row = list.find((item) => item.key === key);
  if (!row) throw new Error(key);
  return row;
}

describe("批次規劃（每個元件一個 PATCH）", () => {
  it("正常路徑：只送與已保存值不同的欄位，expected_revision 用目前 revision", () => {
    const list = rows();
    const plan = planBulk(list, ["node-a::dit", "node-a::echo"], { mode: "summary", capture_prompt: false }, {});
    expect(plan.send).toEqual([
      expect.objectContaining({ key: "node-a::dit", expectedRevision: 3, recording: { mode: "summary", capture_prompt: false } }),
      expect.objectContaining({ key: "node-a::echo", expectedRevision: 7, recording: { capture_prompt: false } }),
    ]);
    expect(plan.skipped).toEqual([]);
    expect(initialResults(plan)).toEqual({ "node-a::dit": { status: "queued" }, "node-a::echo": { status: "queued" } });
  });

  it("邊界：離線 Node、有草稿的列、已是指定值的列都略過並說明原因", () => {
    const list = rows();
    const draft = setDraftField(rowOf(list, "node-a::echo"), undefined, "log_level", "debug");
    expect(draft).toBeDefined();
    const plan = planBulk(list, ["node-a::dit", "node-a::echo", "node-b::dit2"], { mode: "detailed" }, { "node-a::echo": draft! });
    expect(plan.send).toEqual([]);
    expect(plan.skipped.map((skip) => [skip.key, skip.short])).toEqual([
      ["node-a::dit", "無變更"],
      ["node-a::echo", "有未儲存變更"],
      ["node-b::dit2", "Node 離線"],
    ]);
  });
});

describe("草稿與儲存", () => {
  it("改回預設值時草稿消失；草稿儲存用開始編輯時的 revision", () => {
    const echo = rowOf(rows(), "node-a::echo");
    const off = setDraftField(echo, undefined, "gpu_event_timing", false);
    expect(changedKeys(off)).toEqual(["gpu_event_timing"]);
    expect(setDraftField(echo, off, "gpu_event_timing", true)).toBeUndefined();
    const plan = planDraftSaves(rows(), { "node-a::echo": off! }, ["node-a::echo"]);
    expect(plan.send[0]).toMatchObject({ expectedRevision: 7, recording: { gpu_event_timing: false } });
  });

  it("重新讀取後把我的變更套到最新版", () => {
    const dit = rowOf(rows(), "node-a::dit");
    const mine = setDraftField(dit, undefined, "mode", "trace");
    const rebased = rebaseDraft(mine!, view({ ...full, log_level: "warning" }, 9));
    expect(rebased?.baseRevision).toBe(9);
    expect(rebased?.value).toMatchObject({ mode: "trace", log_level: "warning" });
    expect(rebaseDraft(mine!, view({ ...full, mode: "trace" }, 10))).toBeUndefined();
  });
});
