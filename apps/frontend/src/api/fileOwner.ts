import { nodeLabel, useCatalog } from "./catalog";
import { useController } from "./controller";
import { t } from "@/i18n";

/** 誰持有這個檔：主控上傳的檔標「主控」，否則顯示 Node 名稱（不在目錄中則顯示 node_id）。 */
export function useFileOwnerLabel(nodeId: string): string {
  const controller = useController();
  const catalog = useCatalog();
  if (controller.data && controller.data.controller_id === nodeId) return t("主控（{hostname}）", { hostname: controller.data.hostname });
  return nodeLabel(catalog.data, nodeId);
}
