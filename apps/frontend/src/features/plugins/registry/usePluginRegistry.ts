// 元件讀取插件登錄表：第一次使用時向主控讀取，之後跟著快取更新（安裝、停用、移除之後會重新讀取；視窗重新取得焦點時
// 若已超過 30 秒也會重讀）。回傳的物件在登錄表沒變時是同一個，可以直接當 memo 的相依。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { pluginRegistryQuery } from "@/api/plugins";
import type { PluginRegistry } from "../model/registry";
import { pluginRegistrySnapshot, watchPluginRegistry } from "./store";

/** 這個觀察者只負責讓查詢保持使用中（讀取與重讀）；畫面的更新由下面的訂閱負責，所以它自己不觸發 render。 */
const OBSERVER = { ...pluginRegistryQuery, notifyOnChangeProps: [] };

export function usePluginRegistry(): PluginRegistry {
  const client = useQueryClient();
  useQuery(OBSERVER);
  const subscribe = useCallback((notify: () => void) => watchPluginRegistry(client, notify), [client]);
  const snapshot = useCallback(() => pluginRegistrySnapshot(client), [client]);
  return useSyncExternalStore(subscribe, snapshot);
}
