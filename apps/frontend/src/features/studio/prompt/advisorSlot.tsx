// 「修正與建議」的插槽：實作在 prompt/advisor/**（PromptAdvisorPanel／PromptAdvisorBadge）；這裡固定 props 介面與接線。
// The advisor (its rule engine, catalog, transforms and both views) loads apart from the shot workspace chunk: the
// badge's code arrives right after the inline editor mounts (until then a pending badge keeps its place), and the panel
// with the professional editor's 修正與建議 tab.
import { Lightbulb } from "lucide-react";
import { lazy, Suspense } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { LazyBoundary } from "@/components/common/LazyBoundary";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ToolbarPartBoundary } from "../components/chrome/ToolbarPartBoundary";
import { TOOL, toolPadding, useToolbarFit } from "./toolbar/fit";
import { t } from "@/i18n";

const PromptAdvisorPanel = lazy(() => import("./advisor/PromptAdvisorPanel").then((m) => ({ default: m.PromptAdvisorPanel })));
const PromptAdvisorBadge = lazy(() => import("./advisor/PromptAdvisorBadge").then((m) => ({ default: m.PromptAdvisorBadge })));

export type PromptTask = "t2va" | "fl2va" | "ref2va";

export interface AdvisorSlotProps {
  /** 目前的 prompt 全文。 */
  text: string;
  /** 鏡頭影格數（24 fps）；呼叫端沒提供時為 0＝未知。 */
  frames: number;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  /** 這個鏡頭的 H3 任務（呼叫端沒提供時為 undefined＝未知）。 */
  mode?: PromptTask;
  /** 編輯器停用：可以看與複製，不能套用或插入。 */
  disabled?: boolean;
  /** 套用修正或改寫：以新的全文取代（經 onChange，編輯器留下可復原的提示）；label 是改了什麼。 */
  onApplyFix: (next: string, label: string) => void;
  /** 在編輯器選取並捲動到全文中的 [start, end)。 */
  onRevealRange?: (start: number, end: number) => void;
  /** 插入範本：有標題的區塊附加在選取的區塊後面，其他文字插入到游標位置。 */
  onInsertTemplate?: (text: string) => void;
}

export interface AdvisorBadgeSlotProps {
  text: string;
  frames: number;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  mode?: PromptTask;
  /** 編輯器停用：浮層可以看，修正不能套用。 */
  disabled?: boolean;
  /** 打開專業 Prompt 編輯器的「修正與建議」分頁。 */
  onOpen: () => void;
  /** 浮層裡的一鍵修正：以新的全文取代並留下可以復原的提示；false＝沒有套用（例如超過字數上限）。 */
  onApplyFix: (next: string, label: string) => boolean;
}

/** 「修正與建議」面板（專業 Prompt 編輯器側欄分頁；由外層容器捲動）。 */
export function AdvisorSlot(props: AdvisorSlotProps) {
  return (
    <LazyBoundary className="m-3">
      <Suspense fallback={<p role="status" className="p-3 text-caption text-fg-tertiary animate-fade-in">{t("讀取中…")}</p>}>
        <PromptAdvisorPanel {...props} />
      </Suspense>
    </LazyBoundary>
  );
}

/** The badge while the advisor's code loads: the same tool geometry (the count slot kept empty), busy and inert. */
function PendingAdvisorBadge() {
  const fit = useToolbarFit();
  return (
    <span className="flex shrink-0 items-center">
      <Button size="sm" variant="quiet" pending icon={<Lightbulb aria-hidden />} aria-label={t("修正與建議")} title={t("修正與建議")} className={cn(TOOL, toolPadding(fit))}>
        {fit.advisorLabel ? <span aria-hidden>{t("建議", undefined, { context: "advisor-badge" })}</span> : null}
        <span aria-hidden className="grid min-w-4 place-items-center" />
      </Button>
    </span>
  );
}

/** 行內編輯器工具列的「建議 n」：錯誤＋警告＋建議數，按下打開列出發現與一鍵修正的浮層。 */
export function AdvisorBadgeSlot(props: AdvisorBadgeSlotProps) {
  return (
    <ToolbarPartBoundary>
      <Suspense fallback={<PendingAdvisorBadge />}>
        <PromptAdvisorBadge {...props} />
      </Suspense>
    </ToolbarPartBoundary>
  );
}
