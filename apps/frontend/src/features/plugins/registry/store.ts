// 目前的插件登錄表（主控 GET /api/studio/plugins 在這個分頁的唯一一份）。事實來源是 React Query 的快取；這裡把快取的
// 狀態換成 PluginRegistry，並留一份給不在 React 裡的呼叫端同步讀取（渲染規劃是純函式，送出時要讀到「現在」的登錄表）。
//   - 元件用 usePluginRegistry()：直接讀快取，快取一變就重新 render；
//   - currentPluginRegistry()：最近一次從快取算出的那一份。沒有任何元件在看登錄表時是 loading，
//     所以選了插件貢獻的專案在登錄表讀到之前不能渲染（fail closed）。
import type { QueryClient } from "@tanstack/react-query";
import type { StudioPluginList } from "@/api/generated/contracts";
import { ApiError } from "@/api/http";
import { pluginKeys } from "@/api/plugins";
import { t } from "@/i18n";
import { isPluginList, LOADING_REGISTRY, registryFromError, registryFromList, registryFromStaleList, type PluginRegistry } from "../model/registry";

let ambient: PluginRegistry = LOADING_REGISTRY;
const listeners = new Set<() => void>();
const bindings = new Map<QueryClient, { count: number; unsubscribe: () => void }>();

/**
 * 同一個錯誤（或同一份格式不對的回應）永遠得到同一個物件，快照才穩定：useSyncExternalStore 的快照每次不同會無限重繪。
 * 物件用 WeakMap 記；不是物件的值（字串的回應本文、被丟出的原始值、空的回應）只記最近的那一個。
 */
const failed = new WeakMap<object, PluginRegistry>();
let failedValue: { key: unknown; registry: PluginRegistry } | null = null;

function failedRegistry(key: unknown, error: unknown): PluginRegistry {
  if (typeof key !== "object" || key === null) {
    if (!failedValue || !Object.is(failedValue.key, key)) failedValue = { key, registry: registryFromError(error) };
    return failedValue.registry;
  }
  let registry = failed.get(key);
  if (!registry) {
    registry = registryFromError(error);
    failed.set(key, registry);
  }
  return registry;
}

function invalidResponse(): ApiError {
  return new ApiError(200, { code: "INVALID_RESPONSE", message: t("插件登錄表的內容無法解讀") }, "INVALID_RESPONSE", "GET");
}

function fromCache(client: QueryClient): PluginRegistry {
  const state = client.getQueryState<StudioPluginList>(pluginKeys.registry());
  if (!state) return LOADING_REGISTRY;
  const data: unknown = state.data;
  // 讀到過一次之後重新讀取失敗：留著上一次的內容，並把失敗的原因帶出來（畫面要說明這不一定是主控現在的內容）
  if (isPluginList(data)) return state.status === "error" ? registryFromStaleList(data, state.error) : registryFromList(data);
  if (state.status === "error") return failedRegistry(state.error, state.error);
  // 成功的回應卻不是登錄表（例如代理伺服器回的 HTML，或空的本文）：是讀不到，不是還在讀
  if (state.status === "success") return failedRegistry(data, invalidResponse());
  return LOADING_REGISTRY;
}

/** 快取目前的登錄表（同時更新給非 React 呼叫端的那一份）。同樣的快取狀態回傳同一個物件。 */
export function pluginRegistrySnapshot(client: QueryClient): PluginRegistry {
  ambient = fromCache(client);
  return ambient;
}

/** 最近一次算出的登錄表：給渲染規劃這類同步、不在 React 裡的呼叫端。 */
export function currentPluginRegistry(): PluginRegistry {
  return ambient;
}

function isRegistryKey(key: unknown): boolean {
  if (!Array.isArray(key)) return false;
  const parts: readonly unknown[] = key;
  const expected = pluginKeys.registry();
  return parts.length === expected.length && expected.every((part, index) => parts[index] === part);
}

/** 訂閱登錄表的變化（useSyncExternalStore 用）；最後一個訂閱離開後回到 loading。 */
export function watchPluginRegistry(client: QueryClient, listener: () => void): () => void {
  listeners.add(listener);
  let binding = bindings.get(client);
  if (!binding) {
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (!isRegistryKey(event.query.queryKey)) return;
      const before = ambient;
      if (pluginRegistrySnapshot(client) !== before) for (const notify of listeners) notify();
    });
    binding = { count: 0, unsubscribe };
    bindings.set(client, binding);
  }
  const bound = binding;
  bound.count += 1;
  pluginRegistrySnapshot(client);
  return () => {
    listeners.delete(listener);
    bound.count -= 1;
    if (bound.count > 0) return;
    bound.unsubscribe();
    bindings.delete(client);
    if (bindings.size === 0) ambient = LOADING_REGISTRY;
  };
}

/** 測試用：直接指定目前的登錄表（null＝回到 loading）。 */
export function setCurrentPluginRegistry(registry: PluginRegistry | null): void {
  ambient = registry ?? LOADING_REGISTRY;
  for (const notify of listeners) notify();
}
