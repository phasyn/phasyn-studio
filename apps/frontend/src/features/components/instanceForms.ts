// 新建／複製 instance 的共用邏輯：device 與 model_path 表單 schema、預設 settings、ID 檢查。
import type { ComponentEntry, NodeView } from "@/api/catalog";
import type { InstanceSettings } from "@/api/generated/contracts";
import { matchesSetting, CONTRACT_ROOT } from "@/lib/contractSchemas";
import { localIdError } from "@/lib/ids";
import { cloneJson } from "@/lib/json";
import { propertySchema, type JsonSchema } from "@/lib/schema";
import { t } from "@/i18n";

const LOAD_SETTINGS = { $ref: "#/$defs/LoadSettings" };

/** 新建／複製時必須確認的 load 欄位：device（kind／id／resource_group）與本機 model_path。 */
export const DEVICE_FORM_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    device: propertySchema(LOAD_SETTINGS, "device", CONTRACT_ROOT) ?? { $ref: "#/$defs/Device" },
    model_path: { type: "string", description: t("Node 本機已安裝的模型路徑（由使用者提供，主控不下載）") },
  },
};

export const DEVICE_FORM_ROOT = CONTRACT_ROOT;

/** provider 沒有提供 default_settings 時的最小骨架（device 需使用者填寫）。 */
export function skeletonSettings(): InstanceSettings {
  return {
    load: { device: { kind: "cpu", id: "cpu", resource_group: "cpu" } },
    invoke: {},
    recording: { mode: "detailed" },
  };
}

export function settingsFromDefaults(defaults: InstanceSettings | null): InstanceSettings {
  return defaults ? cloneJson(defaults) : skeletonSettings();
}

export function componentIdError(componentId: string, node: NodeView | null): string | null {
  const error = localIdError(componentId, "component_id ");
  if (error != null && error !== "") return error;
  if (node?.snapshot?.components.some((component) => component.component_id === componentId) === true) {
    return t("Node「{label}」已有 component_id「{componentId}」：請改用其他 ID（要修改既有 instance 請在元件頁編輯）", { label: node.label, componentId });
  }
  return null;
}

/** load 只取 device 與 model_path 兩欄給表單編輯，其餘保留。 */
export function deviceFormValue(settings: InstanceSettings): Record<string, unknown> {
  const out: Record<string, unknown> = { device: settings.load.device };
  if (settings.load.model_path !== undefined) out["model_path"] = settings.load.model_path;
  return out;
}

export function withDeviceForm(settings: InstanceSettings, value: Record<string, unknown>): InstanceSettings {
  const load = { ...settings.load };
  if (matchesSetting("Device", value["device"])) load.device = value["device"];
  if (typeof value["model_path"] === "string") load.model_path = value["model_path"];
  else delete load.model_path;
  return { ...settings, load };
}

/** 新建／複製時送出的顯示名稱：前後空白不保存（之後基本資料比對時也是正規化後的值）。 */
export function instanceLabel(label: string, componentId: string): string {
  return label.trim() || componentId;
}

export function cloneDefaults(source: ComponentEntry, takenOnTarget: ReadonlySet<string>): { componentId: string; label: string } {
  let componentId = `${source.descriptor.component_id}-copy`;
  for (let index = 2; takenOnTarget.has(componentId) && index < 1000; index += 1) componentId = `${source.descriptor.component_id}-copy-${String(index)}`;
  return { componentId, label: t("{value}（複製）", { value: source.descriptor.label || source.descriptor.component_id }) };
}
