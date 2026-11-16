// 流程分頁（Phasyn 步驟列）：反推、圖片反推的「1 → 2 → 3 → 4」步驟。行為與 PanelTabs 相同（APG tabs：單一 Tab 停駐點、
// ←→／Home／End 自動切換；tab id＝`${idPrefix}-tab-${id}`、tabpanel id＝`${idPrefix}-panel-${id}` 由呼叫端渲染），
// 外觀是概念板的步驟列（與共用 Stepper 同一套語言）：選取的步驟是品牌淡漸層膠囊＋亮漸層光邊，圓點顯示這一步的狀態
// （完成、進行中、錯誤、需要注意），前一步完成時連接線以亮漸層點亮（表示進度，不表示成功）。按下有 pressable 回饋；
// 指示線在步驟間滑動、切換時 tabpanel 短暫淡入（ActiveIndicator）。
// 狀態一律有圖示＋報讀文字，顏色只是第二線索；這是「看哪一步」，不是精靈：任何一步都可以直接切換。
// 比步驟列窄時依量測收合（useFitLevel，不分語言；放得下的步驟列外觀不變）：
//   1：收掉裝飾用的英文副標；
//   2：再收緊間距、縮短連接線；
//   3：再收掉連接線（仍是一列）；
//   4：非選取的步驟只留狀態圓點（圓點裡仍是編號或狀態圖示）：名稱改為只給螢幕閱讀器、並寫進 title；danger／warning
//      計數改成圓點角落的小標記（仍在可存取名稱裡），一般計數只給螢幕閱讀器。選取的步驟保持完整；
//   5：連這樣都放不下才換成多列：滑動指示線（只會左右移動）隱藏，選取的步驟自己畫底線。
// 每一步的狀態圓點、可存取名稱（「步驟 N：名稱」、計數）與狀態報讀文字在每一級都不變。
import { Check, CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react";
import { Fragment, useRef } from "react";
import { ActiveIndicator } from "@/components/ui/active-indicator";
import { StableLabel } from "@/components/ui/stable-label";
import { cn } from "@/lib/cn";
import { useFitLevel } from "@/lib/useFitLevel";
import { EN_LABEL } from "@/components/ui/look";
import { t } from "@/i18n";

const FIT_LEVELS = 5;

export type FlowStatus = "todo" | "running" | "done" | "warning" | "error";

export interface FlowTabItem {
  id: string;
  /** 中文標籤（不含編號；編號由位置決定，顯示在圓點裡）。 */
  label: string;
  /** 英文副標（裝飾，寬螢幕才顯示）。 */
  en?: string;
  status: FlowStatus;
  /** 狀態的補充（tooltip 與報讀），例如「run 執行中」「3 個資料錯誤」。 */
  detail?: string | null;
  count?: number | null;
  countTone?: "neutral" | "danger" | "warning";
}

const STATUS_TEXT: Record<FlowStatus, string> = { todo: "", running: t("進行中"), done: t("已完成"), warning: t("需要注意"), error: t("有錯誤") };

const DOT: Record<FlowStatus, string> = {
  todo: "border-line-strong text-fg-tertiary",
  running: "border-info/50 bg-info/12 text-info",
  done: "border-success/45 bg-success/12 text-success",
  warning: "border-warning/50 bg-warning/12 text-warning",
  error: "border-danger/55 bg-danger/12 text-danger",
};

/**
 * 步驟列顯示的內容改變時從第 0 級重新量：標籤、副標、計數，以及選取的步驟（第 4 級只有它顯示名稱）。狀態只換圓點裡的
 * 圖示，不影響寬度。
 */
function fitContent(tabs: readonly FlowTabItem[], value: string): string {
  return `${value}\u0002${tabs.map((tab) => `${tab.id}\u0000${tab.label}\u0000${tab.en ?? ""}\u0000${tab.count ?? ""}\u0000${tab.countTone ?? ""}`).join("\u0001")}`;
}

/** 計數的顏色；只剩圓點的步驟把 danger／warning 計數畫成圓點右上角的實心小標記（文字仍在可存取名稱裡）。 */
function countClass(tab: FlowTabItem, dotOnly: boolean): string {
  const tone = tab.countTone === "danger" || tab.countTone === "warning" ? tab.countTone : null;
  if (dotOnly) {
    if (!tone) return "sr-only";
    return cn(
      "machine absolute -top-1 -right-1 z-[3] h-3.5 min-w-3.5 rounded-full px-[3px] text-center text-[9px] leading-3.5 font-semibold text-on-accent ring-2 ring-surface",
      tone === "danger" ? "bg-danger" : "bg-warning",
    );
  }
  return cn("machine rounded-sm px-1 text-caption font-normal", tone === "danger" ? "bg-danger/15 text-danger" : tone === "warning" ? "bg-warning/15 text-warning" : "bg-overlay text-fg-tertiary");
}

function Glyph({ status, index }: { status: FlowStatus; index: number }) {
  if (status === "done") return <Check className="size-3" strokeWidth={2.5} />;
  if (status === "running") return <LoaderCircle className="size-3 animate-spin" strokeWidth={2.5} />;
  if (status === "error") return <CircleAlert className="size-3" strokeWidth={2.5} />;
  if (status === "warning") return <TriangleAlert className="size-3" strokeWidth={2.5} />;
  return <span className="machine text-[11px] leading-none font-semibold">{index + 1}</span>;
}

export function FlowTabs({
  tabs,
  value,
  onChange,
  idPrefix,
  label,
  className,
}: {
  tabs: readonly FlowTabItem[];
  value: string;
  onChange: (id: string) => void;
  idPrefix: string;
  label: string;
  className?: string;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const fit = useFitLevel(listRef, FIT_LEVELS, fitContent(tabs, value));
  const tight = fit >= 2;
  const noConnectors = fit >= 3;
  const compact = fit >= 4;
  const wrapped = fit >= 5;
  const focusAt = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (!tab) return;
    onChange(tab.id);
    refs.current.get(tab.id)?.focus();
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      data-fit={fit}
      className={cn(
        "@container relative flex h-11 min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b border-line-subtle px-3",
        className,
        tight && "gap-0.5",
        wrapped && "h-auto flex-wrap gap-y-3 py-1.5",
      )}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        const previous = tabs[index - 1];
        const status = STATUS_TEXT[tab.status];
        const spoken = [status, tab.detail && tab.detail !== status ? tab.detail : null].filter(Boolean).join(t("："));
        // 只剩圓點時，名稱（與狀態）放進 title；可存取名稱由下面的報讀文字組成，不變
        const dotOnly = compact && !selected;
        return (
          <Fragment key={tab.id}>
            {index > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "h-px shrink-0 rounded-full",
                  tight ? "w-1.5" : "w-3 @2xl:w-5 @4xl:w-8",
                  previous?.status === "done" ? "bg-brand-gradient" : "bg-line-strong",
                  noConnectors && "hidden",
                )}
              />
            ) : null}
            <button
              ref={(node) => {
                if (node) refs.current.set(tab.id, node);
                else refs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              title={dotOnly ? `${t("步驟 {index}：", { index: index + 1 })}${tab.label}${spoken ? t("（{spoken}）", { spoken }) : ""}` : (tab.detail ?? undefined)}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") focusAt(index + 1);
                else if (event.key === "ArrowLeft") focusAt(index - 1);
                else if (event.key === "Home") focusAt(0);
                else if (event.key === "End") focusAt(tabs.length - 1);
                else return;
                event.preventDefault();
              }}
              className={cn(
                "pressable inline-flex h-8 shrink-0 items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-data whitespace-nowrap outline-none",
                "focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
                selected
                  ? "border-transparent bg-brand-gradient-soft text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] border-brand-gradient"
                  : "border-transparent text-fg-secondary hover:border-line-subtle hover:bg-raised hover:text-fg",
                tight && "gap-1.5 pr-2",
                dotOnly && "relative pr-1",
                // 選取的步驟自己的底線（::after 是 border-brand-gradient 的漸層框，所以用 ::before），位置同滑動指示線：步驟下方 6 px
                wrapped &&
                  selected &&
                  "relative before:pointer-events-none before:absolute before:inset-x-3.5 before:-bottom-1.5 before:h-0.5 before:rounded-full before:bg-brand-gradient",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "relative z-[2] grid size-6 shrink-0 place-items-center rounded-full border transition-[background-color,border-color,color,box-shadow] duration-(--duration-base)",
                  selected && tab.status === "todo" ? "border-transparent bg-brand-gradient text-on-accent shadow-glow-sm" : DOT[tab.status],
                )}
              >
                <Glyph status={tab.status} index={index} />
              </span>
              <span className="sr-only">{t("步驟 {index}：", { index: index + 1 })}</span>
              <StableLabel weight="semibold" className={cn(selected && "font-semibold", dotOnly && "sr-only")}>
                {tab.label}
              </StableLabel>
              {tab.en ? (
                <span aria-hidden className={cn(EN_LABEL, fit >= 1 ? "hidden" : "hidden @4xl:inline", selected ? "text-brand-cyan/85" : "text-fg-tertiary")}>
                  {tab.en}
                </span>
              ) : null}
              {tab.count !== undefined && tab.count !== null ? <span className={countClass(tab, dotOnly)}>{tab.count}</span> : null}
              {spoken ? <span className="sr-only">{t("（{spoken}）", { spoken })}</span> : null}
            </button>
          </Fragment>
        );
      })}
      <ActiveIndicator container={listRef} edge="bottom" inset={14} className={wrapped ? "hidden" : undefined} />
    </div>
  );
}
