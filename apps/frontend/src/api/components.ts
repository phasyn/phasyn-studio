// 元件設定與控制：寫入一律不自動重送（mutations retry=false）；結果未知時由使用者重新讀取。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notePendingWrite, PENDING_WRITE_MS, withPendingWrites } from "./catalog";
import type { Catalog, CancelResult, ComponentDescriptor, ComponentMetaPatch, ControlRequest, InstanceDefinition, SettingsPatch, SettingsView } from "./generated/contracts";
import { contractJson } from "./http";
import { qk } from "./keys";

function componentPath(nodeId: string, componentId: string): string {
  return `/api/nodes/${encodeURIComponent(nodeId)}/components/${encodeURIComponent(componentId)}`;
}

export function fetchSettings(nodeId: string, componentId: string, signal?: AbortSignal): Promise<SettingsView> {
  return contractJson("SettingsView", `${componentPath(nodeId, componentId)}/settings`, { signal });
}

/** 從 Node 讀取目前的 stored／loaded（Node 離線時失敗，畫面改用目錄快照並標示過時）。 */
export function useComponentSettings(nodeId: string, componentId: string) {
  return useQuery({
    queryKey: qk.settings(nodeId, componentId),
    queryFn: ({ signal }) => fetchSettings(nodeId, componentId, signal),
    staleTime: 2000,
    retry: false,
  });
}

export function usePatchSettings(nodeId: string, componentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsPatch) => contractJson("SettingsView", `${componentPath(nodeId, componentId)}/settings`, { method: "PATCH", json: body }),
    onSuccess: (view) => {
      client.setQueryData(qk.settings(nodeId, componentId), view);
      void client.invalidateQueries({ queryKey: qk.catalog() });
    },
  });
}

/**
 * start／stop／restart. A component with an exclusive_group answers 409 EXCLUSIVE_GROUP_CONFLICT while another member
 * of its group is loaded; resend with `replace_exclusive: true` only after the user confirms (the Node then stops the
 * idle members first). The request is never retried automatically.
 */
export function controlComponent(nodeId: string, componentId: string, request: ControlRequest): Promise<ComponentDescriptor> {
  return contractJson("ComponentDescriptor", `${componentPath(nodeId, componentId)}/control`, { method: "POST", json: request });
}

/** Cancels one call on the component (the Node answers whether it was still running). */
export function cancelCall(nodeId: string, componentId: string, callId: string): Promise<CancelResult> {
  return contractJson("CancelResult", `${componentPath(nodeId, componentId)}/cancel`, { method: "POST", json: { call_id: callId } });
}

export function useControlComponent(nodeId: string, componentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: ControlRequest) => controlComponent(nodeId, componentId, request),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.catalog() });
      void client.invalidateQueries({ queryKey: qk.settings(nodeId, componentId) });
    },
  });
}

export function useCancelCall(nodeId: string, componentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) => cancelCall(nodeId, componentId, callId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.catalog() });
    },
  });
}

export interface PutComponentVars {
  nodeId: string;
  definition: InstanceDefinition;
}

/** 新建／複製 instance（或 stopped 時替換完整定義）。 */
export function usePutComponent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, definition }: PutComponentVars) =>
      contractJson("ComponentDescriptor", componentPath(nodeId, definition.component_id), { method: "PUT", json: definition }),
    onSuccess: (descriptor) => {
      // Node 下一次上報快照前，新 instance 先出現在目錄中（可以立即選取）。
      notePendingWrite({ kind: "put", descriptor, until: Date.now() + PENDING_WRITE_MS });
      client.setQueryData<Catalog>(qk.catalog(), withPendingWrites);
      void client.invalidateQueries({ queryKey: qk.catalog() });
    },
  });
}

/**
 * Label, folder, autostart and limits only (PATCH …/meta: allowed in any state, never reloads the model).
 * On success the returned values overlay the catalog snapshot until the Node reports a matching one; errors are shown, never resent.
 */
export function usePatchComponentMeta(nodeId: string, componentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: qk.componentMeta(nodeId, componentId),
    mutationFn: (patch: ComponentMetaPatch) => contractJson("ComponentDescriptor", `${componentPath(nodeId, componentId)}/meta`, { method: "PATCH", json: patch }),
    retry: false,
    onSuccess: (descriptor) => {
      notePendingWrite({
        kind: "meta",
        nodeId,
        componentId,
        label: descriptor.label,
        folder: descriptor.folder,
        autostart: descriptor.autostart,
        limits: descriptor.limits,
        until: Date.now() + PENDING_WRITE_MS,
      });
      client.setQueryData<Catalog>(qk.catalog(), withPendingWrites);
      void client.invalidateQueries({ queryKey: qk.catalog() });
    },
  });
}

export interface DeleteComponentResult {
  component_id: string;
  deleted: true;
}

/**
 * 刪除 instance 定義（只允許 stopped／error，否則 409 STATE_CONFLICT）。Node 會記下 tombstone，設定檔的同名 seed
 * 重啟時不會重建；效能紀錄與檔案保留。成功後立即從目錄快照移除並重新讀取目錄。
 */
export function useDeleteComponent(nodeId: string, componentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: qk.componentDelete(nodeId, componentId),
    mutationFn: () => contractJson("DeleteComponentResult", componentPath(nodeId, componentId), { method: "DELETE" }),
    retry: false,
    onSuccess: () => {
      notePendingWrite({ kind: "delete", nodeId, componentId, until: Date.now() + PENDING_WRITE_MS });
      client.removeQueries({ queryKey: qk.settings(nodeId, componentId), exact: true });
      client.setQueryData<Catalog>(qk.catalog(), withPendingWrites);
      void client.invalidateQueries({ queryKey: qk.catalog() });
    },
  });
}
