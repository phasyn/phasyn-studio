// 開啟專案素材庫的按鈕（Studio 工具列）：留在頁面的程式裡，素材庫對話框本身另外載入（assetLibraryLoad，LazyAssetLibraryHost）。
// 滑鼠或焦點到按鈕上就先載入；對話框的程式還沒到就按下時，按鈕顯示進行中，到了就打開。
import { Library } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { videoLibrary } from "../../references/materials";
import { useStudio } from "../../studioContext";
import { loadAssetLibrary, useAssetLibraryLoad } from "./assetLibraryLoad";
import { openAssetLibrary, useAssetLibraryOpen } from "./libraryOpen";
import { t } from "@/i18n";

/** 素材庫裡的項目數：參考素材、渲染結果（成功的 take）與匯出成片。 */
function useLibraryCounts() {
  const { project } = useStudio();
  const assets = videoLibrary(project.library ?? []).length;
  const takes = project.shots.reduce((sum, shot) => sum + shot.takes.filter((take) => Boolean(take.state === "succeeded" && take.asset)).length, 0);
  const exports = project.exports.filter((record) => Boolean(record.state === "succeeded" && record.asset)).length;
  return { assets, takes, exports, total: assets + takes + exports };
}

/**
 * 開啟素材庫的大按鈕（主要樣式＋圖示＋數量）：toolbar＝Studio 工具列（一直顯示文字）；panel＝專案面板
 * 「素材」分頁頂端，佔滿整列並說明裡面有什麼。
 */
export function AssetLibraryButton({ placement = "toolbar", className }: { placement?: "toolbar" | "panel"; className?: string }) {
  const counts = useLibraryCounts();
  const { open } = useAssetLibraryOpen();
  const load = useAssetLibraryLoad();
  // Opened before the dialog's code arrived: the button spins (its width kept) until the dialog takes over
  const pending = open && load.module === null && load.failure === null;
  const title = t("開啟專案素材庫：參考素材 {assets}・渲染結果 {takes}・匯出成片 {exports}", { assets: counts.assets, takes: counts.takes, exports: counts.exports });
  const countPill = <span className="machine inline-flex min-w-6 items-center justify-center rounded-full bg-white/18 px-1.5 text-caption leading-5 font-semibold text-[#fff]">{counts.total}</span>;
  if (placement === "panel") {
    return (
      <Button variant="primary" pending={pending} onClick={() => { openAssetLibrary(); }} onPointerEnter={loadAssetLibrary} onFocus={loadAssetLibrary} title={title} className={cn("h-auto min-h-12 w-full justify-start gap-3 rounded-lg px-3 py-2 text-left", className)}>
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-white/15 [&_svg]:size-4.5">
          <Library />
        </span>
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate text-body font-semibold">{t("開啟素材庫")}</span>
          <span className="line-clamp-2 text-[11px] font-normal whitespace-normal text-[#fff]/80">{t("參考素材・渲染結果・匯出成片")}</span>
        </span>
        {countPill}
      </Button>
    );
  }
  return (
    <Button
      variant="primary"
      icon={<Library aria-hidden />}
      pending={pending}
      onClick={() => { openAssetLibrary(); }}
      onPointerEnter={loadAssetLibrary}
      onFocus={loadAssetLibrary}
      title={title}
      className={cn("h-10 min-w-0 shrink-0 rounded-full px-4 text-body [&_svg]:size-4.5", className)}
    >
      <span className="truncate">{t("素材庫")}</span>
      {countPill}
    </Button>
  );
}
