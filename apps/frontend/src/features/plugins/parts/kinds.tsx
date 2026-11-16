// 貢獻種類的圖示（./kindIcons）與包的圖示磚：依來源，內建＝品牌漸層、已安裝＝中性、開發＝琥珀邊。
import { Blocks, Hammer, Package, type LucideIcon } from "lucide-react";
import type { StudioPlugin } from "@/api/generated/contracts";
import { ICON_TILE, ICON_TILE_BRAND } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import type { ContributionKind } from "../model/contributions";
import { KIND_ICON, KIND_TONE } from "./kindIcons";

export function ContributionIcon({ kind, className }: { kind: ContributionKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon aria-hidden className={cn("size-4 shrink-0", KIND_TONE[kind], className)} />;
}

const SOURCE_ICON: Record<StudioPlugin["source"], LucideIcon> = { builtin: Blocks, installed: Package, dev: Hammer };

/** 包的圖示磚：sm＝清單列（28 px）、lg＝詳情標題（40 px）。 */
export function PluginTile({ plugin, size = "sm", className }: { plugin: Pick<StudioPlugin, "source">; size?: "sm" | "lg"; className?: string }) {
  const Icon = SOURCE_ICON[plugin.source];
  return (
    <span
      aria-hidden
      className={cn(
        plugin.source === "builtin" ? ICON_TILE_BRAND : ICON_TILE,
        plugin.source === "dev" && "border-warning/40 text-warning",
        // 清單列裡的磚不發光（資料區保持俐落）
        size === "lg" ? "size-10 rounded-lg [&_svg]:size-5" : "size-7 shadow-none [&_svg]:size-4",
        className,
      )}
    >
      <Icon />
    </span>
  );
}
