// 推理 Studio 的區域標頭＋子品牌切換列（概念板的 sub-brand 列：圖示磚＋中文名稱＋寬字距英文副標）：反推、圖片反推、手動執行。
// 三個頁面的中欄頂端都放這一列；左側是區域圖示（AreaIcon）與「推理 Studio」，右側是三個子品牌連結（一般連結，
// aria-current="page"），和左欄的資源樹指向同樣的網址，所以未儲存內容的離開確認照常運作。
// 目前的子品牌：品牌淡漸層底＋亮漸層光邊、漸層圖示磚＋柔和光暈；其他：中性磚，滑過時亮一階；按下有 pressable 回饋。
import { GraduationCap, Play, ScanSearch, ScanText, type LucideIcon } from "lucide-react";
import { Link } from "react-router";
import { PATHS } from "@/app/paths";
import { AreaIcon } from "@/components/common/AreaIcon";
import { cn } from "@/lib/cn";
import { EN_LABEL, ICON_TILE, ICON_TILE_BRAND } from "@/components/ui/look";
import { t } from "@/i18n";

export type SubBrandId = "semantics" | "prompt-studies" | "training" | "run";

interface SubBrand {
  id: SubBrandId;
  to: string;
  label: string;
  /** 寬字距英文副標（裝飾）。 */
  en: string;
  /** 一行說明（tooltip）。 */
  hint: string;
  icon: LucideIcon;
}

const SUB_BRANDS: readonly SubBrand[] = [
  { id: "semantics", to: PATHS.semantics, label: t("反推"), en: "Semantics", hint: t("影片反推：原片 → Scene → caption → 資料集匯出"), icon: ScanText },
  { id: "prompt-studies", to: PATHS.promptStudies, label: t("圖片反推"), en: "Prompt Lab", hint: t("從一張圖反推 8 區段場景與 core／detailed prompt；生成比對與有界搜尋"), icon: ScanSearch },
  { id: "training", to: PATHS.training, label: t("LoRA 訓練"), en: "Training", hint: t("丟進影片、寫下方向：自動切片、反推、訓練，並比較不同強度的結果"), icon: GraduationCap },
  { id: "run", to: PATHS.inferenceRun, label: t("手動執行"), en: "Engine", hint: t("選一個元件組合，上傳輸入後建立 run"), icon: Play },
];

export function SubBrandNav({ current }: { current: SubBrandId }) {
  return (
    <div className="flex h-13 shrink-0 items-stretch overflow-x-auto border-b border-line-subtle bg-[radial-gradient(90%_160%_at_0%_0%,rgb(79_123_255/0.10),transparent_62%)]">
      <div className="flex shrink-0 items-center gap-2.5 border-r border-line-subtle/70 pr-3.5 pl-3">
        <AreaIcon area="inference" size={30} />
        <span className="grid gap-0.5 leading-none">
          <span className="text-data leading-4 font-semibold text-fg">{t("推理 Studio")}</span>
          <span aria-hidden className={cn(EN_LABEL, "text-brand-cyan/80")}>
            Inference
          </span>
        </span>
      </div>
      <nav aria-label={t("推理 Studio 功能切換")} className="flex min-w-0 items-stretch gap-1 px-2">
        {SUB_BRANDS.map((brand) => {
          const active = brand.id === current;
          const Icon = brand.icon;
          return (
            <Link
              key={brand.id}
              to={brand.to}
              aria-current={active ? "page" : undefined}
              title={brand.hint}
              className={cn(
                "pressable group my-2 flex min-w-0 shrink-0 items-center gap-2.5 rounded-lg border pr-3.5 pl-1.5 no-underline outline-none",
                "focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
                active ? "border-transparent bg-brand-gradient-soft border-brand-gradient" : "border-transparent hover:border-line-subtle hover:bg-raised",
              )}
            >
              <span aria-hidden className={cn("relative z-[2] size-7 transition-[background-color,border-color,color,box-shadow] duration-(--duration-base) [&_svg]:size-4", active ? ICON_TILE_BRAND : cn(ICON_TILE, "group-hover:text-fg-secondary"))}>
                <Icon />
              </span>
              <span className="relative z-[2] grid min-w-0 gap-0.5 leading-none">
                <span className={cn("truncate text-data leading-4", active ? "font-semibold text-fg" : "font-medium text-fg-secondary group-hover:text-fg")}>{brand.label}</span>
                <span aria-hidden className={cn(EN_LABEL, active ? "text-brand-cyan/85" : "text-fg-tertiary")}>
                  {brand.en}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
