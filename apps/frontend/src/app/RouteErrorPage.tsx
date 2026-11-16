import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { AuroraBackdrop } from "@/components/common/AuroraBackdrop";
import { EmptyState } from "@/components/common/EmptyState";
import { buttonVariants } from "@/components/ui/variants";
import { isChunkLoadError } from "@/lib/chunkLoad";
import { cn } from "@/lib/cn";
import { PATHS } from "./paths";
import { t } from "@/i18n";

/**
 * 畫面程式錯誤：顯示訊息與返回入口，不吞掉錯誤。`inline` 用在殼層之內（頁面出錯時導覽列仍在）；頁面的程式檔載入失敗
 * （網路中斷，或服務更新後舊檔已不存在）時改說明原因，只需要重新載入。
 */
export function RouteErrorPage({ inline = false }: { inline?: boolean }) {
  const error = useRouteError();
  const chunk = isChunkLoadError(error);
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : t("未知錯誤");
  return (
    <div className={cn("grid place-items-center overflow-y-auto px-4 text-fg", inline ? "h-full py-8" : "relative isolate h-dvh")}>
      {inline ? null : <AuroraBackdrop />}
      <EmptyState
        mark={!inline}
        title={chunk ? t("頁面的程式沒有載入成功") : t("畫面發生錯誤")}
        description={chunk ? t("可能是網路中斷，或服務剛更新、舊版的程式檔已不存在。請重新載入頁面。") : <code className="machine">{message}</code>}
        action={
          <>
            <button type="button" className={buttonVariants({ variant: "secondary" })} onClick={() => window.location.reload()}>
              {t("重新載入")}
            </button>
            <Link to={PATHS.components} className={buttonVariants({ variant: "quiet" })}>
              {t("回到元件頁")}
            </Link>
          </>
        }
      />
    </div>
  );
}
