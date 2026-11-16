// Resident components: GPU components that the Node loads at service start (autostart) and whose weights stay on the
// device (offload.mode is "none" or unset). The UI marks them as resident and asks for confirmation before stopping one.
// Decided only from catalog facts (autostart, device, offload); no component ids are hard-coded. Pure functions.
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { t } from "@/i18n";

type ResidentFacts = Pick<ComponentDescriptor, "autostart" | "device" | "settings">;

/** 目前載入（沒有載入時用保存的設定）的 offload 模式；沒有設定 → null。 */
export function offloadMode(component: ResidentFacts): string | null {
  const offload = component.settings.loaded?.offload ?? component.settings.stored.load.offload;
  const mode = offload?.mode;
  return typeof mode === "string" ? mode : null;
}

export function isResidentComponent(component: ResidentFacts): boolean {
  if (component.autostart !== true || component.device.kind === "cpu") return false;
  const mode = offloadMode(component);
  return mode === null || mode === "none";
}

/** 「常駐」標記的說明。 */
export const RESIDENT_HINT = t("常駐：Node 服務啟動時自動載入，權重一直留在顯示卡（autostart、offload none）；使用者決定讓它一直開著，停止前會先確認");

