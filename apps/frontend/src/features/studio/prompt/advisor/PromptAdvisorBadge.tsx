// 編輯器工具列上的「建議 n」：n＝錯誤＋警告＋建議（背景說明不計入）。按下在按鈕下方打開一個小浮層（ToolPopover，與插件徽章
// 同樣的鍵盤與焦點行為）：目前的發現、一鍵修正與「在專業編輯器中查看全部」。
// 外觀：與工具列其他工具同一個 TOOL 樣式（開著時淡品牌底＋品牌細框）；數字是膠囊小籤，有錯誤時紅、只有警告時琥珀、只有建議時
// 中性；沒有發現時是綠色勾。prompt 還是空的時不計數（空白本身已在編輯器裡說明，不先亮紅燈）。
// 計數的位置固定寬度（空白時保留），工具列量寬度時不會因為數字出現或消失而跳動；工具列窄到只剩一個工具寬時（fit.ts）
// 只留燈泡與數字，「建議」兩個字仍在可及名稱與提示文字裡。
import { CircleCheck, Lightbulb } from "lucide-react";
import { useId, useState } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { TOOL, toolPadding, useToolbarFit } from "../toolbar/fit";
import { ToolPopover } from "../toolbar/ToolPopover";
import { AdvisorPopover } from "./AdvisorPopover";
import { countBySeverity } from "./analyze";
import type { PromptMode } from "./types";
import { useAdvisorFindings } from "./useAdvisorFindings";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface PromptAdvisorBadgeProps {
  text: string;
  mode?: PromptMode | null;
  /** 鏡頭影格數（24 fps）；0＝未知。 */
  frames: number;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  firstFrame?: boolean;
  /** 編輯器停用：浮層可以看，修正不能套用。 */
  disabled?: boolean;
  /** 打開專業 Prompt 編輯器的「修正與建議」分頁。 */
  onOpen: () => void;
  /** 一鍵修正：以新的全文取代並留下可以復原的提示；false＝沒有套用。 */
  onApplyFix: (nextText: string, label: string) => boolean;
  className?: string;
}

const CHIP_TONE = {
  error: "bg-danger/15 text-danger",
  warning: "bg-warning/15 text-warning",
  suggestion: "bg-raised text-fg-secondary",
} as const;

export function PromptAdvisorBadge({ text, mode = null, frames, references, library, firstFrame, disabled = false, onOpen, onApplyFix, className }: PromptAdvisorBadgeProps) {
  const id = useId();
  const fit = useToolbarFit();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const { findings } = useAdvisorFindings({ text, mode, frames, references, library, firstFrame });
  const empty = text.trim() === "";
  const issues = empty ? [] : findings.filter((item) => item.severity !== "info");
  const counts = countBySeverity(issues);
  const total = issues.length;
  const parts = [
    counts.error > 0 ? t("{error} 個錯誤", { error: counts.error }) : null,
    counts.warning > 0 ? t("{warning} 個警告", { warning: counts.warning }) : null,
    counts.suggestion > 0 ? t("{suggestion} 個建議", { suggestion: counts.suggestion }) : null,
  ].filter((part): part is string => part !== null);
  const name = t("修正與建議：{value}", { value: empty ? t("prompt 是空的") : parts.length > 0 ? formatList(parts) : t("沒有發現問題") });
  const tone = counts.error > 0 ? CHIP_TONE.error : counts.warning > 0 ? CHIP_TONE.warning : CHIP_TONE.suggestion;
  const close = (restoreFocus: boolean) => {
    if (restoreFocus && anchor?.isConnected) anchor.focus();
    setAnchor(null);
  };
  return (
    <span className="flex shrink-0 items-center">
      <Button
        size="sm"
        variant="quiet"
        icon={<Lightbulb aria-hidden />}
        aria-label={name}
        title={name}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? id : undefined}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
        className={cn(TOOL, toolPadding(fit), className)}
      >
        {fit.advisorLabel ? <span aria-hidden>{t("建議", undefined, { context: "advisor-badge" })}</span> : null}
        <span aria-hidden className="grid min-w-4 place-items-center">
          {empty ? null : total > 0 ? (
            <span key={total} className={cn("machine min-w-4 rounded-full px-1 text-center text-[11px] leading-4 animate-pop-in", tone)}>
              {total}
            </span>
          ) : (
            <CircleCheck className="text-success" />
          )}
        </span>
      </Button>
      {anchor ? (
        <ToolPopover id={id} anchor={anchor} label={t("修正與建議")} width={340} onClose={close}>
          <AdvisorPopover
            text={text}
            empty={empty}
            issues={issues}
            blockedReason={disabled ? t("編輯器目前停用") : null}
            onApplyFix={onApplyFix}
            onOpenAll={() => {
              // 專業編輯器打開前先把焦點交回按鈕：關掉編輯器時焦點回到這裡
              close(true);
              onOpen();
            }}
          />
        </ToolPopover>
      ) : null}
    </span>
  );
}
