// 專案引用插件貢獻的寫法（契約 StudioPluginRef）：內建包的貢獻是不帶前綴的 id（no-fighting-game，永久如此），
// 其他包是 <plugin_id>/<貢獻 id>。引用對到哪個貢獻一律由主控的登錄表決定（./registry 的 resolveRef）。
import type { StudioPluginRef } from "@/api/generated/contracts";

/** 依序去掉重複的引用（專案文件的 prompt_plugins 不重複）。 */
export function uniqueRefs(refs: readonly StudioPluginRef[] | null | undefined): StudioPluginRef[] {
  return [...new Set(refs ?? [])];
}
