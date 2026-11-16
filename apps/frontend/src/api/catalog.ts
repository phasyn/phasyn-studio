import { queryOptions, useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Catalog, CatalogLite, ComponentDescriptor, DirectoryEntry, NodeSnapshot, Part, ProviderInfo, ProviderList } from "./generated/contracts";
import { valuesEqual } from "@/lib/json";
import { apiJson } from "./http";
import { POLL, qk } from "./keys";
import { instanceKey } from "./types";

// ---------------------------------------------------------------- 輕量目錄（x-phasyn-extension）
//
// 完整目錄約 2.8 MB，其中 85% 是各元件的 parts（只有元件檢視器的「子部件」與追蹤設定會用到），而每個開著的分頁
// 每 3 秒輪詢一次。輪詢改讀 GET /api/catalog?parts=false（CatalogLite：元件不含 parts，附 parts_count 與 parts_digest），
// parts 以 digest 對到上一次完整讀取的結果補回；任何元件的 digest 不同（定義改變、新元件）才再讀一次完整目錄。
// 所以畫面拿到的仍是完整的 Catalog（parts 一律來自真的完整回應，不會用空陣列代替）。
// facts（provider describe 回報的事實）同樣只在完整目錄裡：依 facts_digest 記下與補回，任一 digest 不同就讀完整目錄。

export interface CachedParts {
  digest: string;
  parts: Part[];
  factsDigest: string | null;
  facts: ComponentDescriptor["facts"];
}

/** 把輕量目錄的元件補回 parts 與 facts（兩個 digest 與 parts 筆數都要相符）；任何一個元件對不到 → null（呼叫端改讀完整目錄）。 */
export function mergeCatalogParts(lite: CatalogLite, cache: ReadonlyMap<string, CachedParts>): Catalog | null {
  const nodes: NodeSnapshot[] = [];
  for (const node of lite.nodes) {
    const components: ComponentDescriptor[] = [];
    for (const component of node.components) {
      const { parts_count: count, parts_digest: digest, facts_digest: factsDigest, ...rest } = component;
      const hit = cache.get(instanceKey(node.node_id, component.component_id));
      if (!hit || hit.digest !== digest || hit.factsDigest !== factsDigest || hit.parts.length !== count) return null;
      components.push({ ...rest, parts: hit.parts, facts: hit.facts });
    }
    nodes.push({ ...node, components });
  }
  return { nodes, directory: lite.directory, observed_at: lite.observed_at };
}

/**
 * 完整目錄的 parts 依同一輪讀到的輕量目錄 digest 記下。兩次讀取之間 parts 若剛好改變，記下的 digest 是舊的：
 * 下一輪 digest 不符就會再讀一次完整目錄，所以不會把舊 parts 當成新的。
 */
export function partsCacheFrom(full: Catalog, lite: CatalogLite): Map<string, CachedParts> {
  const digests = new Map<string, { parts: string; facts: string | null }>();
  for (const node of lite.nodes) {
    for (const component of node.components) digests.set(instanceKey(node.node_id, component.component_id), { parts: component.parts_digest, facts: component.facts_digest });
  }
  const out = new Map<string, CachedParts>();
  for (const node of full.nodes) {
    for (const component of node.components) {
      const key = instanceKey(node.node_id, component.component_id);
      const digest = digests.get(key);
      if (digest !== undefined) out.set(key, { digest: digest.parts, parts: component.parts, factsDigest: digest.facts, facts: component.facts });
    }
  }
  return out;
}

let partsCache: ReadonlyMap<string, CachedParts> = new Map();

/** Clears the module-level parts cache and pending writes (tests only). */
export function resetCatalogCache(): void {
  partsCache = new Map();
  pendingWrites.clear();
}

/** 讀目錄：輕量目錄＋parts 快取；對不到時讀一次完整目錄並更新快取。 */
async function readCatalog(signal?: AbortSignal): Promise<Catalog> {
  const lite = await apiJson<CatalogLite>("/api/catalog", { query: { parts: false }, signal });
  const merged = mergeCatalogParts(lite, partsCache);
  if (merged) return merged;
  const full = await apiJson<Catalog>("/api/catalog", { signal });
  partsCache = partsCacheFrom(full, lite);
  return full;
}

/** 已確認的寫入在目錄快照中的最長遮蓋時間（Node 每 5 秒上報一次快照，留兩次的餘裕）。 */
export const PENDING_WRITE_MS = 12_000;

/**
 * 伺服器已確認、但 Controller 目錄還沒收到 Node 新快照的寫入（Node 每 5 秒才上報一次）：
 * put＝新建的 instance 在快照出現前先列出；meta＝顯示名稱／資料夾／自動啟動／使用上限在快照一致前先顯示新值；
 * delete＝刪除的 instance 在快照移除前先隱藏。快照一致或逾時（PENDING_WRITE_MS）後就只用快照，不重送任何請求。
 */
export type PendingWrite =
  | { kind: "put"; descriptor: ComponentDescriptor; until: number }
  | {
      kind: "meta";
      nodeId: string;
      componentId: string;
      label: string;
      folder: string | null;
      autostart: boolean;
      limits: ComponentDescriptor["limits"];
      until: number;
    }
  | { kind: "delete"; nodeId: string; componentId: string; until: number };

const pendingWrites = new Map<string, PendingWrite>();

export function notePendingWrite(write: PendingWrite): void {
  const key = write.kind === "put" ? instanceKey(write.descriptor.node_id, write.descriptor.component_id) : instanceKey(write.nodeId, write.componentId);
  pendingWrites.set(key, write);
}

function metaMatches(descriptor: ComponentDescriptor, write: Extract<PendingWrite, { kind: "meta" }>): boolean {
  return (
    descriptor.label === write.label &&
    descriptor.folder === write.folder &&
    descriptor.autostart === write.autostart &&
    valuesEqual(descriptor.limits, write.limits)
  );
}

/** 把尚未出現在快照中的已確認寫入套到目錄上；回傳已一致或逾時而可以丟掉的鍵。 */
export function applyPendingWrites(catalog: Catalog, pending: ReadonlyMap<string, PendingWrite>, now: number): { catalog: Catalog; settled: string[] } {
  const settled: string[] = [];
  let nodes = catalog.nodes;
  const patchNode = (nodeId: string, change: (components: ComponentDescriptor[]) => ComponentDescriptor[]) => {
    nodes = nodes.map((node) => (node.node_id === nodeId ? { ...node, components: change(node.components) } : node));
  };
  for (const [key, write] of pending) {
    if (write.until <= now) {
      settled.push(key);
      continue;
    }
    const nodeId = write.kind === "put" ? write.descriptor.node_id : write.nodeId;
    const componentId = write.kind === "put" ? write.descriptor.component_id : write.componentId;
    const node = nodes.find((item) => item.node_id === nodeId);
    const current = node?.components.find((item) => item.component_id === componentId) ?? null;
    if (write.kind === "put") {
      if (current || !node) settled.push(key);
      else patchNode(nodeId, (components) => [...components, write.descriptor]);
    } else if (write.kind === "meta") {
      if (!current || metaMatches(current, write)) settled.push(key);
      else
        patchNode(nodeId, (components) =>
          components.map((item) =>
            item.component_id === componentId
              ? { ...item, label: write.label, folder: write.folder, autostart: write.autostart, limits: write.limits }
              : item,
          ),
        );
    } else if (!current) {
      settled.push(key);
    } else {
      patchNode(nodeId, (components) => components.filter((item) => item.component_id !== componentId));
    }
  }
  return { catalog: nodes === catalog.nodes ? catalog : { ...catalog, nodes }, settled };
}

/** 寫入成功當下立即套用到快取中的目錄（不等重新讀取）；不丟掉任何待確認的寫入。 */
export function withPendingWrites(catalog: Catalog | undefined): Catalog | undefined {
  if (!catalog || pendingWrites.size === 0) return catalog;
  return applyPendingWrites(catalog, pendingWrites, Date.now()).catalog;
}

/**
 * 目前的元件目錄（輕量輪詢＋parts 快取，見上方說明），並套上尚未出現在快照中的已確認寫入。
 * 所有讀目錄的地方（輪詢、啟動／停止後等狀態、切換 DiT）都用這個，不直接 GET /api/catalog。
 */
export async function fetchCatalog(signal?: AbortSignal): Promise<Catalog> {
  const raw = await readCatalog(signal);
  if (pendingWrites.size === 0) return raw;
  const { catalog, settled } = applyPendingWrites(raw, pendingWrites, Date.now());
  for (const key of settled) pendingWrites.delete(key);
  return catalog;
}

/** The catalog query (one definition; every reader shares the 3-second poll). */
export function catalogQueryOptions() {
  return queryOptions({ queryKey: qk.catalog(), queryFn: ({ signal }) => fetchCatalog(signal), refetchInterval: POLL.catalog, staleTime: 1000 });
}

/**
 * The catalog without its timestamps (Catalog / NodeSnapshot `observed_at`, DirectoryEntry `last_seen_at`, all set to
 * ""). Those change on every poll, so a timestamp-free copy is deep-equal across polls when nothing else changed.
 */
export function withoutTimestamps(catalog: Catalog): Catalog {
  return {
    ...catalog,
    observed_at: "",
    nodes: catalog.nodes.map((node) => ({ ...node, observed_at: "" })),
    directory: catalog.directory.map((entry) => ({ ...entry, last_seen_at: "" })),
  };
}

/**
 * Controller 目錄：所有已登記 Node 與元件；離線 Node 保留最後快照（過時），不隱藏。
 * Without `select` this is the raw catalog (with timestamps). With `select`, the selector receives the
 * timestamp-free catalog and its result is structurally shared, so consumers re-render only on real changes;
 * pass a stable function (module-level or useCallback) so it runs once per poll.
 */
export function useCatalog(): UseQueryResult<Catalog>;
export function useCatalog<T>(select: (catalog: Catalog) => T): UseQueryResult<T>;
export function useCatalog<T>(select?: (catalog: Catalog) => T): UseQueryResult<Catalog | T> {
  const selector = select ? (catalog: Catalog): Catalog | T => select(withoutTimestamps(catalog)) : undefined;
  return useQuery({ ...catalogQueryOptions(), select: selector });
}

const stable = (catalog: Catalog) => catalog;

/** The timestamp-free catalog whose reference changes only when components, states or the directory change. */
export function useStableCatalog(): UseQueryResult<Catalog> {
  return useCatalog(stable);
}

export function fetchProviders(nodeId: string, signal?: AbortSignal): Promise<ProviderList> {
  return apiJson<ProviderList>(`/api/nodes/${encodeURIComponent(nodeId)}/providers`, { signal });
}

/** Node 上可建立的 provider（含不可用原因）。 */
export function useProviders(nodeId: string | null) {
  return useQuery({
    queryKey: qk.providers(nodeId ?? ""),
    queryFn: ({ signal }) => fetchProviders(nodeId ?? "", signal),
    enabled: nodeId !== null && nodeId.length > 0,
    staleTime: 30_000,
  });
}

export interface ProviderIndex {
  /** key：node_id::runtime_id::provider_id。 */
  byRuntime: Map<string, ProviderInfo>;
  /** key：node_id::provider_id（runtime 不明時的後備）。 */
  byProvider: Map<string, ProviderInfo>;
  /** 無法取得 provider 清單的 Node（通常是離線）。 */
  failedNodes: Set<string>;
  loading: boolean;
}

/** 各 Node 的 provider 清單 → 以 provider 的 kind 判斷元件功能分類（模板、正式解碼選擇器使用）。 */
export function useProviderIndex(nodeIds: readonly string[]): ProviderIndex {
  return useQueries({
    queries: nodeIds.map((nodeId) => ({
      queryKey: qk.providers(nodeId),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchProviders(nodeId, signal),
      staleTime: 30_000,
      retry: false,
    })),
    combine: (results) => {
      const byRuntime = new Map<string, ProviderInfo>();
      const byProvider = new Map<string, ProviderInfo>();
      const failedNodes = new Set<string>();
      results.forEach((result, index) => {
        const nodeId = nodeIds[index];
        if (nodeId === undefined) return;
        if (result.isError) failedNodes.add(nodeId);
        for (const item of result.data?.items ?? []) {
          byRuntime.set(`${nodeId}::${item.runtime_id}::${item.provider_id}`, item);
          if (!byProvider.has(`${nodeId}::${item.provider_id}`)) byProvider.set(`${nodeId}::${item.provider_id}`, item);
        }
      });
      return { byRuntime, byProvider, failedNodes, loading: results.some((result) => result.isPending) };
    },
  });
}

export function providerFor(index: ProviderIndex, descriptor: Pick<ComponentDescriptor, "node_id" | "runtime_id" | "provider_id">): ProviderInfo | null {
  return (
    index.byRuntime.get(`${descriptor.node_id}::${descriptor.runtime_id}::${descriptor.provider_id}`) ??
    index.byProvider.get(`${descriptor.node_id}::${descriptor.provider_id}`) ??
    null
  );
}

export type NodeLiveness = DirectoryEntry["state"] | "unknown";

export interface NodeView {
  node_id: string;
  label: string;
  snapshot: NodeSnapshot | null;
  directory: DirectoryEntry | null;
  liveness: NodeLiveness;
  /** 非 online：資料可能過時（stale）。 */
  stale: boolean;
}

export interface ComponentEntry {
  descriptor: ComponentDescriptor;
  node: NodeView;
  key: string;
}

/** Lookup structure over one catalog object (built once per object, cached). */
export interface CatalogIndex {
  /** catalog.nodes merged with the directory: registered Nodes without a snapshot are listed too. */
  nodes: readonly NodeView[];
  entries: readonly ComponentEntry[];
  all: readonly ComponentDescriptor[];
  component(nodeId: string, componentId: string): ComponentDescriptor | null;
  entry(nodeId: string, componentId: string): ComponentEntry | null;
  /** Snapshot label, else directory label; null when neither names the Node (callers choose their fallback). */
  nodeLabel(nodeId: string): string | null;
  /** Directory liveness; null when the directory does not list the Node. */
  online(nodeId: string): boolean | null;
}

const EMPTY_INDEX: CatalogIndex = { nodes: [], entries: [], all: [], component: () => null, entry: () => null, nodeLabel: () => null, online: () => null };
const indexCache = new WeakMap<Catalog, CatalogIndex>();

function buildIndex(catalog: Catalog): CatalogIndex {
  const directory = new Map(catalog.directory.map((entry) => [entry.node_id, entry]));
  const nodes: NodeView[] = catalog.nodes.map((snapshot) => {
    const entry = directory.get(snapshot.node_id) ?? null;
    const liveness: NodeLiveness = entry?.state ?? "unknown";
    return { node_id: snapshot.node_id, label: snapshot.label || entry?.label || snapshot.node_id, snapshot, directory: entry, liveness, stale: liveness !== "online" };
  });
  const seen = new Set(nodes.map((view) => view.node_id));
  for (const entry of catalog.directory) {
    if (!seen.has(entry.node_id)) nodes.push({ node_id: entry.node_id, label: entry.label || entry.node_id, snapshot: null, directory: entry, liveness: entry.state, stale: entry.state !== "online" });
  }
  const entries = nodes.flatMap((node) => (node.snapshot?.components ?? []).map((descriptor) => ({ descriptor, node, key: instanceKey(node.node_id, descriptor.component_id) })));
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const labels = new Map(catalog.nodes.map((node) => [node.node_id, node.label]));
  return {
    nodes,
    entries,
    all: entries.map((entry) => entry.descriptor),
    component: (nodeId, componentId) => byKey.get(instanceKey(nodeId, componentId))?.descriptor ?? null,
    entry: (nodeId, componentId) => byKey.get(instanceKey(nodeId, componentId)) ?? null,
    nodeLabel: (nodeId) => labels.get(nodeId) || directory.get(nodeId)?.label || null,
    online: (nodeId) => {
      const entry = directory.get(nodeId);
      return entry ? entry.state === "online" : null;
    },
  };
}

/** The index of a catalog object; repeated calls with the same object return the same index. */
export function indexCatalog(catalog: Catalog | undefined): CatalogIndex {
  if (!catalog) return EMPTY_INDEX;
  let index = indexCache.get(catalog);
  if (!index) {
    index = buildIndex(catalog);
    indexCache.set(catalog, index);
  }
  return index;
}

/** 合併 catalog.nodes 與 directory：沒有快照的已登記 Node 也列出。 */
export function nodeViews(catalog: Catalog | undefined): NodeView[] {
  return [...indexCatalog(catalog).nodes];
}

export function componentEntries(catalog: Catalog | undefined): ComponentEntry[] {
  return [...indexCatalog(catalog).entries];
}

export function findComponent(catalog: Catalog | undefined, nodeId: string, componentId: string): ComponentEntry | null {
  return indexCatalog(catalog).entry(nodeId, componentId);
}

export function nodeLabel(catalog: Catalog | undefined, nodeId: string | null | undefined): string {
  if (!nodeId) return "—";
  return indexCatalog(catalog).nodeLabel(nodeId) ?? nodeId;
}
