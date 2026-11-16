// 元件 instance 的選擇（純函式）：依 provider_id 列出目錄中所有 instance（任何 Node），就緒者優先、離線 Node 殿後。
// 預設選第一個可用的；不自動啟動、不自動換到別的 instance（使用者在檢視器明確選擇，任務建立時凍結）。
import { componentEntries } from "@/api/catalog";
import type { Catalog, ComponentDescriptor } from "@/api/generated/contracts";
import { instanceKey } from "@/api/types";
import { placeLabel } from "@/lib/deviceTag";
import type { TaskComponents } from "../types";
import { PROVIDERS } from "./routes";
import { t } from "@/i18n";

export interface ComponentChoice {
  key: string;
  descriptor: ComponentDescriptor;
  /** 「[GPU 1] Node A」這類位置文字。 */
  place: string;
  usable: boolean;
  /** 不能用的原因（未就緒、Node 離線）。 */
  reason: string | null;
}

const STATE_TEXT: Record<string, string> = { stopped: t("已停止"), loading: t("載入中"), ready: t("就緒"), busy: t("呼叫中"), stopping: t("停止中"), error: t("錯誤") };

export function componentChoices(catalog: Catalog | undefined, providerId: string): ComponentChoice[] {
  return componentEntries(catalog)
    .filter((entry) => entry.descriptor.provider_id === providerId)
    .map((entry) => {
      const usable = !entry.node.stale && (entry.descriptor.state === "ready" || entry.descriptor.state === "busy");
      const reason = entry.node.stale
        ? t("{label} 不在線上", { label: entry.node.label })
        : usable
          ? null
          : t("{component_id} {value}：到「元件修改」啟動", { component_id: entry.descriptor.component_id, value: STATE_TEXT[entry.descriptor.state] ?? entry.descriptor.state });
      return { key: entry.key, descriptor: entry.descriptor, place: placeLabel(entry.descriptor.device, entry.node.label), usable, reason };
    })
    .sort((a, b) => Number(!a.usable) - Number(!b.usable) || a.descriptor.component_id.localeCompare(b.descriptor.component_id));
}

/** 使用者的選擇不存在時（或還沒選）用第一個可用的，再沒有就用第一個（顯示未就緒原因）。 */
export function chooseComponent(choices: readonly ComponentChoice[], selected: string | null): ComponentChoice | null {
  return choices.find((choice) => choice.key === selected) ?? choices.find((choice) => choice.usable) ?? choices[0] ?? null;
}

export function findDescriptor(catalog: Catalog | undefined, key: string | null): ComponentDescriptor | null {
  if (!key) return null;
  return componentEntries(catalog).find((entry) => entry.key === key)?.descriptor ?? null;
}

export function descriptorKey(descriptor: Pick<ComponentDescriptor, "node_id" | "component_id">): string {
  return instanceKey(descriptor.node_id, descriptor.component_id);
}

export type ComponentRole = keyof TaskComponents;

export const ROLE_PROVIDER: Record<ComponentRole, string> = {
  vision: PROVIDERS.vision,
  compile: PROVIDERS.compile,
  score: PROVIDERS.score,
};

export const ROLE_LABELS: Record<ComponentRole, string> = {
  vision: t("視覺模型（qimg.vision）"),
  compile: t("候選編譯（prompt.scene_compile）"),
  score: t("評分（prompt.scene_score）"),
};

/** 這個角色的元件現在能不能用；可以時為 null。 */
export function roleProblem(role: ComponentRole, choice: ComponentChoice | null): string | null {
  if (!choice) return t("目錄中沒有 {role} 元件：到「元件修改」建立 instance", { role: ROLE_PROVIDER[role] });
  return choice.reason;
}
