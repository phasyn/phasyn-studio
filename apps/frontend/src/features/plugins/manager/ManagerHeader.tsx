// 插件管理視窗的標題列：名稱、重新讀取登錄表，以及主要動作「安裝插件…」（大按鈕、有文字）。
import { Puzzle, RefreshCw, Upload } from "lucide-react";
import { usePluginRegistryQuery } from "@/api/plugins";
import { ActionButton } from "@/components/common/ActionButton";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ICON_TILE_BRAND, TOOL_BUTTON } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useManager } from "./managerContext";

export function ManagerHeader({ descriptionId }: { descriptionId: string }) {
  const { pickFile, installBlocked } = useManager();
  const query = usePluginRegistryQuery();
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line-subtle px-4 pr-14">
      <span aria-hidden className={cn(ICON_TILE_BRAND, "size-8 [&_svg]:size-4")}>
        <Puzzle />
      </span>
      <DialogTitle className="text-section">{t("插件管理")}</DialogTitle>
      <DialogDescription id={descriptionId} className="sr-only">
        {t("安裝、檢視與移除插件包，並決定這個專案使用哪些插件項目。")}
      </DialogDescription>
      <button
        type="button"
        aria-label={t("重新讀取插件登錄表")}
        title={t("重新讀取插件登錄表")}
        onClick={() => void query.refetch()}
        className={cn(TOOL_BUTTON, "ml-auto size-8 [&_svg]:size-4")}
      >
        <RefreshCw aria-hidden className={query.isFetching ? "animate-spin" : undefined} />
      </button>
      <ActionButton variant="primary" icon={<Upload aria-hidden />} disabledReason={installBlocked} onClick={pickFile}>
        {t("安裝插件…")}
      </ActionButton>
    </header>
  );
}
