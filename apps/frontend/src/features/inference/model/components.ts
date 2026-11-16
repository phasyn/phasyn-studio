// 「需要的元件」：pipeline 每個步驟用到的元件 instance（node_id＋component_id 去重）與能不能啟動
// （啟動順序與等待在 @/features/components 的 useComponentControl）。
// 目錄還沒讀到或讀取失敗時，元件狀態是「未知」：不說 Node 離線、不說不在目錄。純函式。
import { componentEntries } from "@/api/catalog";
import type { Catalog, ComponentDescriptor } from "@/api/generated/contracts";
import type { WirePipeline } from "@/api/types";
import { placeLabel } from "@/lib/deviceTag";
import { t } from "@/i18n";

export interface RequiredComponent {
  key: string;
  nodeId: string;
  componentId: string;
  /** 用到這個元件的步驟（依 pipeline 順序）。 */
  stepIds: string[];
  /** 目錄中找不到（Node 離線且沒有快照、或元件已刪除）＝null；目錄還沒讀到時也是 null（見 known）。 */
  descriptor: ComponentDescriptor | null;
  nodeLabel: string;
  /** Node 不在線：狀態是最後快照，可能過時。 */
  nodeStale: boolean;
  /** 已讀到元件目錄；false＝讀取中或讀取失敗，狀態未知。 */
  known: boolean;
}

/** 元件目錄的讀取狀態：沒有任何資料時是讀取中（loading）或無法讀取（error）；有資料但最近一次更新失敗＝stale。 */
export type CatalogStatus = "loading" | "error" | "stale" | "ready";

export function catalogStatus(query: { data: unknown; isError: boolean }): CatalogStatus {
  if (query.data === undefined) return query.isError ? "error" : "loading";
  return query.isError ? "stale" : "ready";
}

/** 目錄狀態未知時的說明；已讀到（即使可能過時）時 null。 */
export function catalogUnknownText(status: CatalogStatus): string | null {
  if (status === "loading") return t("讀取目錄中");
  if (status === "error") return t("目錄無法讀取（狀態未知）");
  return null;
}

export function requiredComponents(pipeline: WirePipeline, catalog: Catalog | undefined): RequiredComponent[] {
  const entries = new Map(componentEntries(catalog).map((entry) => [entry.key, entry]));
  const labels = new Map((catalog?.directory ?? []).map((entry) => [entry.node_id, entry.label || entry.node_id]));
  const out = new Map<string, RequiredComponent>();
  for (const step of pipeline.steps) {
    if (!step.node_id || !step.component_id) continue;
    const key = `${step.node_id}::${step.component_id}`;
    const existing = out.get(key);
    if (existing) {
      existing.stepIds.push(step.step_id);
      continue;
    }
    const entry = entries.get(key);
    out.set(key, {
      key,
      nodeId: step.node_id,
      componentId: step.component_id,
      stepIds: [step.step_id],
      descriptor: entry?.descriptor ?? null,
      nodeLabel: entry ? placeLabel(entry.descriptor.device, entry.node.label) : (labels.get(step.node_id) ?? step.node_id),
      nodeStale: entry ? entry.node.stale : catalog !== undefined,
      known: catalog !== undefined,
    });
  }
  return [...out.values()];
}

const STARTABLE = new Set(["stopped", "error"]);

/** 無法對這個元件送出啟動的原因（目錄未讀到、不在目錄、Node 離線）；null＝可以送出。 */
export function startBlock(item: RequiredComponent): string | null {
  if (!item.known) return t("元件目錄還沒讀到：狀態未知");
  if (!item.descriptor) return t("目錄中找不到這個元件（Node 離線或元件已刪除）");
  if (item.nodeStale) return t("Node 離線：狀態可能過時，無法送出啟動");
  return null;
}

/** 目前狀態需要啟動（已停止或錯誤）且可以送出。 */
export function needsStart(item: RequiredComponent): boolean {
  return item.descriptor !== null && !item.nodeStale && STARTABLE.has(item.descriptor.state);
}

/** The descriptors to start for these items (needs a start and is in the catalog). */
export function startTargets(items: readonly RequiredComponent[]): ComponentDescriptor[] {
  return items.flatMap((item) => (needsStart(item) && item.descriptor ? [item.descriptor] : []));
}

export interface Readiness {
  total: number;
  ready: number;
  /** 需要啟動且可以啟動。 */
  startable: number;
  /** 目錄中找不到或 Node 離線。 */
  unavailable: number;
  /** 目錄還沒讀到或讀取失敗：狀態未知。 */
  unknown: number;
}

export function readiness(items: readonly RequiredComponent[]): Readiness {
  let ready = 0;
  let startable = 0;
  let unavailable = 0;
  let unknown = 0;
  for (const item of items) {
    if (!item.known) unknown += 1;
    else if (!item.descriptor || item.nodeStale) unavailable += 1;
    else if (item.descriptor.state === "ready" || item.descriptor.state === "busy") ready += 1;
    else if (needsStart(item)) startable += 1;
  }
  return { total: items.length, ready, startable, unavailable, unknown };
}
