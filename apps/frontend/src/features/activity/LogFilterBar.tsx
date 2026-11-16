// 紀錄表上方 40 px 篩選列：搜尋、等級、來源、即時開關、清除畫面（只隱藏，不刪除）、筆數。
// 一列放不下時依量測收合（useFitLevel，不分語言；放得下的篩選列外觀不變），最後才換行，讓下面的紀錄表留住高度：
//   1：「顯示 N／M 筆」只給螢幕閱讀器（仍是 aria-live，照常播報）；
//   2：「清除畫面」「還原」只留圖示（名稱仍在 aria-label 與 title）；
//   3：搜尋框可以再窄一些，選單也不保留最小寬度（只要放得下最長的選項）；
//   4：還放不下才換行。
// 前三級整列與右側群組都不換行、項目不縮，寬度不足就是量得到的溢出；搜尋框以最小寬度為 basis 再分配剩餘寬度，
// 所以放得下時與原本同寬。
import { Eraser, RotateCw, Search, Undo2 } from "lucide-react";
import { useId, useRef } from "react";
import { Input, Select, Switch } from "@/components/ui/controls";
import { ToolButton, ToolSeparator, ToolStrip } from "@/components/workbench/ToolStrip";
import { cn } from "@/lib/cn";
import { useFitLevel } from "@/lib/useFitLevel";
import {
  choiceForLevels,
  LEVEL_CHOICES,
  levelsForChoice,
  parseLevelChoice,
  parseSourceChoice,
  SOURCE_KIND_LABEL,
  type LogFilter,
  type LogSourceKind,
} from "./model";
import { t } from "@/i18n";

export interface LogFilterBarProps {
  /** 工具列的無障礙名稱（例如「活動紀錄篩選」）。 */
  label: string;
  filter: LogFilter;
  onFilterChange: (next: LogFilter) => void;
  /** 來源選單可選的類型（通常是資料中出現的類型）。 */
  sourceKinds: readonly LogSourceKind[];
  live: boolean;
  onLiveChange: (live: boolean) => void;
  /** 篩選後筆數。 */
  shown: number;
  /** 已載入的總筆數。 */
  total: number;
  /** 被「清除畫面」隱藏的筆數。 */
  cleared: number;
  onClear: () => void;
  onRestore: () => void;
  onRefresh?: () => void;
  /** 手動重新讀取進行中（只在非即時模式顯示轉動）。 */
  refreshing?: boolean;
  /** 選填：資料範圍（例如 run 明細的「這個 run／全部活動」）。 */
  scope?: { value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void };
}

const FILTER_FIT_LEVELS = 4;

export function LogFilterBar({
  label,
  filter,
  onFilterChange,
  sourceKinds,
  live,
  onLiveChange,
  shown,
  total,
  cleared,
  onClear,
  onRestore,
  onRefresh,
  refreshing = false,
  scope,
}: LogFilterBarProps) {
  const liveId = useId();
  const visibleTotal = total - cleared;
  const stripRef = useRef<HTMLDivElement>(null);
  // 筆數的變化不重設（它在第 1 級以後不佔寬度；寬度變化由 ResizeObserver 處理）；多出或少了按鈕、範圍選單才重新量
  const fit = useFitLevel(stripRef, FILTER_FIT_LEVELS, `${scope ? "scope" : ""}\u0000${onRefresh ? "refresh" : ""}\u0000${cleared > 0 ? "restore" : ""}`);
  const oneRow = fit < FILTER_FIT_LEVELS;
  return (
    <ToolStrip ref={stripRef} label={label} data-fit={fit} className={cn(oneRow && "flex-nowrap *:shrink-0")}>
      {scope ? (
        <Select compact aria-label={t("紀錄範圍")} value={scope.value} onChange={(event) => scope.onChange(event.target.value)} className={cn("w-auto", fit >= 3 ? "min-w-0" : "min-w-32")}>
          {scope.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : null}
      <div className={cn("relative flex-1 md:max-w-72", fit >= 3 ? "min-w-24 basis-24" : "min-w-36 basis-36")}>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
        <Input
          compact
          type="search"
          aria-label={t("搜尋紀錄")}
          placeholder={t("搜尋紀錄…")}
          value={filter.query}
          onChange={(event) => onFilterChange({ ...filter, query: event.target.value })}
          className="pl-8"
        />
      </div>
      <Select
        compact
        aria-label={t("等級篩選")}
        value={choiceForLevels(filter.levels)}
        onChange={(event) => onFilterChange({ ...filter, levels: levelsForChoice(parseLevelChoice(event.target.value)) })}
        className={cn("w-auto", fit >= 3 ? "min-w-0" : "min-w-36")}
      >
        {LEVEL_CHOICES.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </Select>
      <Select
        compact
        aria-label={t("來源篩選")}
        value={filter.source}
        onChange={(event) => onFilterChange({ ...filter, source: parseSourceChoice(event.target.value) })}
        className={cn("w-auto", fit >= 3 ? "min-w-0" : "min-w-28")}
      >
        <option value="all">{t("全部來源")}</option>
        {sourceKinds.map((kind) => (
          <option key={kind} value={kind}>
            {SOURCE_KIND_LABEL[kind]}
          </option>
        ))}
      </Select>
      <div className={cn("ml-auto flex items-center gap-x-2 gap-y-1", oneRow ? "flex-nowrap" : "flex-wrap")}>
        <span aria-live="polite" aria-atomic="true" className={cn("text-caption whitespace-nowrap text-fg-tertiary tabular-nums", fit >= 1 && "sr-only")}>
          {t("顯示 {shown}／{visibleTotal} 筆{value}", { shown, visibleTotal, value: cleared > 0 ? t("・已清除 {cleared} 筆", { cleared }) : "" })}
        </span>
        <ToolSeparator />
        <Switch id={liveId} label={t("即時")} checked={live} onChange={(event) => onLiveChange(event.target.checked)} className="min-h-8 gap-2 py-0 text-data" />
        {onRefresh ? (
          <ToolButton
            label={t("重新讀取")}
            icon={<RotateCw aria-hidden className={cn(refreshing && "animate-spin")} />}
            aria-busy={refreshing || undefined}
            onClick={onRefresh}
          />
        ) : null}
        <ToolButton
          label={t("清除畫面")}
          text={fit >= 2 ? undefined : t("清除畫面")}
          icon={<Eraser aria-hidden />}
          title={t("只把目前的紀錄從畫面上隱藏；不會刪除伺服器上的任何資料，之後的新紀錄照常出現")}
          disabledReason={visibleTotal === 0 ? t("畫面上沒有可清除的紀錄") : null}
          onClick={onClear}
        />
        {cleared > 0 ? (
          <ToolButton label={t("還原")} text={fit >= 2 ? undefined : t("還原")} icon={<Undo2 aria-hidden />} title={t("重新顯示被「清除畫面」隱藏的 {cleared} 筆紀錄", { cleared })} onClick={onRestore} />
        ) : null}
      </div>
    </ToolStrip>
  );
}
