import { fixtureValue } from "@/test/fixtures";
import { describe, expect, it } from "vitest";
import type { ComponentEntry, NodeView } from "@/api/catalog";
import { descriptor, pipeline, step } from "@/test/fixtures";
import { NODE_A_ID, NODE_B_ID, PIPELINE_ID, RESOURCE_GROUP } from "@/test/ids";
import { deleteBlockReason, pipelinesUsing } from "./componentsModel";

const DIT = "dit-ref2va-bf16-base";
const DESCRIPTORS = [
  descriptor(NODE_A_ID, "te-gpu0", "h3.conditioning", { resourceGroup: RESOURCE_GROUP.gpu0 }),
  descriptor(NODE_A_ID, DIT, "h3.dit", { resourceGroup: RESOURCE_GROUP.gpu0 }),
  descriptor(NODE_A_ID, "echo", "test.echo", { resourceGroup: "cpu-echo" }),
];
const t2va = pipeline(PIPELINE_ID.t2va, [step("te", NODE_A_ID, "te-gpu0"), step("dit", NODE_A_ID, DIT)], { label: "t2va：TE(GPU 0) → DiT(GPU 0)" });

const view = (node_id: string, stale = false): NodeView => ({ node_id, label: node_id, snapshot: null, directory: null, liveness: stale ? "offline" : "online", stale });
const ENTRIES: ComponentEntry[] = DESCRIPTORS.map((item) => ({ descriptor: item, node: view(item.node_id), key: `${item.node_id}::${item.component_id}` }));

describe("刪除 instance", () => {
  it("列出引用它的元件組合與步驟", () => {
    const other = { ...t2va, pipeline_id: "other", label: "", steps: [] };
    expect(pipelinesUsing([t2va, other], NODE_A_ID, DIT)).toEqual([{ pipelineId: PIPELINE_ID.t2va, label: "t2va：TE(GPU 0) → DiT(GPU 0)", stepIds: ["dit"] }]);
    expect(pipelinesUsing([t2va], NODE_B_ID, DIT)).toEqual([]);
  });

  it("只允許已停止或錯誤的 instance", () => {
    const entry = fixtureValue(ENTRIES.find((item) => item.descriptor.component_id === DIT), "componentsModel.test.ts");
    expect(deleteBlockReason(entry)).toBe("先停止元件才能刪除");
    expect(deleteBlockReason({ ...entry, descriptor: { ...entry.descriptor, state: "stopped" } })).toBeNull();
    expect(deleteBlockReason({ ...entry, descriptor: { ...entry.descriptor, state: "error" } })).toBeNull();
    expect(deleteBlockReason({ node: view(NODE_A_ID, true), descriptor: { ...entry.descriptor, state: "stopped" } })).toMatch(/離線/);
  });
});
