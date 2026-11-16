// Catalog lookups for the log tables: providers, node labels, calls in progress and runs not listed yet. Pure.
import type { Catalog, Recording } from "@/api/generated/contracts";
import { instanceKey, runSteps, type WireRun } from "@/api/types";

/** `instanceKey(node_id, component_id)` → provider_id：目錄優先，recording context 補上已不在目錄的 instance。 */
export function providerEntries(catalog: Catalog | undefined, recordings: readonly Recording[] = []): [string, string][] {
  const map = new Map<string, string>();
  for (const item of recordings) {
    const context = item.context;
    if (context.node_id && context.component_id && context.provider_id) map.set(instanceKey(context.node_id, context.component_id), context.provider_id);
  }
  for (const node of catalog?.nodes ?? []) {
    for (const component of node.components) map.set(instanceKey(node.node_id, component.component_id), component.provider_id);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** 正在進行的呼叫：目錄中各元件的 active_call_id，加上 run 中執行中步驟的 call_id（排序、去重）。 */
export function activeCallIds(catalog: Catalog | undefined, runs: readonly WireRun[] = []): string[] {
  const out = new Set<string>();
  for (const node of catalog?.nodes ?? []) for (const component of node.components) if (component.active_call_id) out.add(component.active_call_id);
  for (const run of runs) {
    if (run.state !== "running") continue;
    for (const step of runSteps(run)) if (step.state === "running" && step.call_id) out.add(step.call_id);
  }
  return [...out].sort();
}

/** Ids of the runs still running (sorted). */
export function activeRunIds(runs: readonly WireRun[]): string[] {
  return runs.filter((run) => run.state === "running").map((run) => run.run_id).sort();
}

/** node_id → 顯示名稱（directory 優先，其次 Node 快照）。 */
export function nodeLabelEntries(catalog: Catalog | undefined): [string, string][] {
  const map = new Map<string, string>();
  for (const entry of catalog?.directory ?? []) if (entry.label) map.set(entry.node_id, entry.label);
  for (const node of catalog?.nodes ?? []) if (node.label && !map.has(node.node_id)) map.set(node.node_id, node.label);
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * 近期 recording 指向、但 run 列表還沒有的 run（比列表最新的 run 更新）。
 * 用來在「即時」模式下觸發重新讀取 run 列表，而不必一直輪詢整份列表。
 */
export function unseenRunIds(runs: readonly WireRun[], recordings: readonly Recording[]): string[] {
  const known = new Set(runs.map((run) => run.run_id));
  let newest = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const at = Date.parse(run.created_at);
    if (!Number.isNaN(at) && at > newest) newest = at;
  }
  const out = new Set<string>();
  for (const item of recordings) {
    const runId = item.context.run_id;
    if (!runId || known.has(runId)) continue;
    const at = Date.parse(item.context.created_at);
    if (!Number.isNaN(at) && at >= newest) out.add(runId);
  }
  return [...out].sort();
}
