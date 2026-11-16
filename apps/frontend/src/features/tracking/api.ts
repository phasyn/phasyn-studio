// 追蹤設定的寫入：每個元件一個普通 PATCH（settings API），不自動重送；讀取沿用 GET settings。
import type { SettingsPatch, SettingsView } from "@/api/generated/contracts";
import { apiJson } from "@/api/http";

export { fetchSettings } from "@/api/components";

export function patchSettings(nodeId: string, componentId: string, body: SettingsPatch): Promise<SettingsView> {
  return apiJson<SettingsView>(`/api/nodes/${encodeURIComponent(nodeId)}/components/${encodeURIComponent(componentId)}/settings`, {
    method: "PATCH",
    json: body,
  });
}
