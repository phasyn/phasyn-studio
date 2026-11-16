// 對一個已安裝的包的動作：整個安裝的停用／啟用、匯出、重新載入開發包。每個請求只送一次；結果以訊息告知，失敗時說明原因
// （REVISION_CONFLICT＝別處剛改過，登錄表已重新讀取，再按一次即可）。
// 結果由 mutation 自己處理（useMutation 的選項），不是由按下按鈕的元件：答案回來時詳情欄可能已經換成別的包，或視窗已經
// 關上，訊息與匯出的檔案仍然要送到。
import { useMutation } from "@tanstack/react-query";
import type { StudioPlugin } from "@/api/generated/contracts";
import { exportPlugin, patchPlugin, PLUGIN_PACKAGE_EXTENSION, reloadPlugin, useInvalidatePlugins } from "@/api/plugins";
import { t } from "@/i18n";
import { downloadBlob } from "@/lib/download";
import { errorText, hasErrorCode } from "@/lib/errors";
import { pluginName } from "../model/evaluate";
import { useManager } from "./managerContext";

export interface PluginActions {
  setDisabled: (plugin: StudioPlugin, disabled: boolean) => void;
  exportPackage: (plugin: StudioPlugin) => void;
  reload: (plugin: StudioPlugin) => void;
  /** 正在進行的動作（按鈕顯示進行中並擋下重複點擊）。 */
  pending: { toggle: boolean; export: boolean; reload: boolean };
}

export function usePluginActions(): PluginActions {
  const { notify } = useManager();
  const invalidate = useInvalidatePlugins();
  const patch = useMutation({
    mutationFn: ({ plugin, disabled }: { plugin: StudioPlugin; disabled: boolean }) => patchPlugin(plugin.plugin_id, { disabled, expected_revision: plugin.revision }),
    onSuccess: (_detail, { plugin, disabled }) => {
      const name = pluginName(plugin);
      notify("success", disabled ? t("已停用「{name}」", { name }) : t("已啟用「{name}」", { name }));
    },
    onError: (error, { plugin }) =>
      notify("danger", hasErrorCode(error, "REVISION_CONFLICT") ? t("「{name}」剛在別處被修改，已重新讀取；請再試一次", { name: pluginName(plugin) }) : errorText(error)),
    onSettled: () => void invalidate(),
  });
  const exporter = useMutation({
    mutationFn: (plugin: StudioPlugin) => exportPlugin(plugin.plugin_id, `${plugin.plugin_id}-${plugin.version ?? "0.0.0"}${PLUGIN_PACKAGE_EXTENSION}`),
    onSuccess: ({ fileName, blob }) => {
      downloadBlob(fileName, blob);
      notify("success", t("已匯出 {fileName}", { fileName }));
    },
    onError: (error) => notify("danger", errorText(error)),
  });
  const reloader = useMutation({
    mutationFn: (plugin: StudioPlugin) => reloadPlugin(plugin.plugin_id),
    onSuccess: (detail, plugin) => {
      const name = pluginName(plugin);
      if (detail.plugin.status === "invalid") notify("warning", t("已重新載入「{name}」，但內容不合規；原因在概覽", { name }));
      else notify("success", t("已重新載入「{name}」", { name }));
    },
    onError: (error) => notify("danger", errorText(error)),
    onSettled: () => void invalidate(),
  });

  return {
    setDisabled: (plugin, disabled) => {
      if (!patch.isPending) patch.mutate({ plugin, disabled });
    },
    exportPackage: (plugin) => {
      if (!exporter.isPending) exporter.mutate(plugin);
    },
    reload: (plugin) => {
      if (!reloader.isPending) reloader.mutate(plugin);
    },
    pending: { toggle: patch.isPending, export: exporter.isPending, reload: reloader.isPending },
  };
}
