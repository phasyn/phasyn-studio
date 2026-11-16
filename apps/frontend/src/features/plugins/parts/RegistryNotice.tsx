// 插件登錄表讀不到，或讀到過之後重新讀取失敗（畫面上仍是上一次讀到的內容）時的說明與重試。兩種情況都沒有時不畫任何東西。
import { usePluginRegistryQuery } from "@/api/plugins";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { t } from "@/i18n";
import type { PluginRegistry } from "../model/registry";

export function RegistryNotice({ registry, className }: { registry: PluginRegistry; className?: string }) {
  const query = usePluginRegistryQuery();
  const stale = registry.status === "ready" && registry.refreshError !== null;
  if (registry.status !== "error" && !stale) return null;
  return (
    <div className={className}>
      <ErrorCallout
        error={stale ? registry.refreshError : registry.error}
        title={stale ? t("重新讀取插件登錄表失敗；顯示的是上一次讀到的內容") : t("讀不到插件登錄表")}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    </div>
  );
}
