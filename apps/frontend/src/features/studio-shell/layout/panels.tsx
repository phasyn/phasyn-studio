// Panel pieces both Studios share: section titles and the collapse button / collapsed rail of a side panel (a panel or
// rail that appears after collapsing or expanding fades in from its edge). The tabs and the splitter between panels are
// the workbench ones (PanelTabs variant="studio", Splitter grip="always").
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { TOOL_BUTTON } from "@/components/ui/look";
import { notePanelToggle, usePanelEnter } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

/** 面板內的區段標題（13 px、圖示＋文字）。 */
export function SectionTitle({ icon: Icon, children, actions }: { icon: LucideIcon; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pb-2">
      <Icon aria-hidden className="size-3.5 shrink-0 text-brand-cyan/80" />
      <h3 className="text-data font-semibold text-fg-secondary">{children}</h3>
      {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
    </div>
  );
}

/**
 * 面板分頁列右側的收合按鈕（side＝面板在左或右，決定圖示方向）。按下時先記下 label，
 * 接著出現的窄軌（CollapsedRail 同一個 label）會淡入；面板本體以 usePanelEnter(label, side) 在展開時從邊緣淡入。
 */
export function PanelCollapseButton({ side, label, onCollapse }: { side: "left" | "right"; label: string; onCollapse: () => void }) {
  const Icon = side === "left" ? PanelLeftClose : PanelRightClose;
  return (
    <button
      type="button"
      onClick={() => {
        notePanelToggle(label);
        onCollapse();
      }}
      aria-label={t("收合{label}", { label })}
      title={t("收合{label}", { label })}
      data-panel-toggle=""
      className={cn(TOOL_BUTTON, "text-fg-tertiary")}
    >
      <Icon aria-hidden />
    </button>
  );
}

/** 收合後的窄軌：整條都是展開按鈕（圖示＋直排名稱）。因收合而出現時淡入。 */
export function CollapsedRail({ side, label, onExpand, className }: { side: "left" | "right"; label: string; onExpand: () => void; className?: string }) {
  const Icon = side === "left" ? PanelLeftOpen : PanelRightOpen;
  const enter = usePanelEnter<HTMLElement>(label, "none");
  return (
    <section
      ref={enter}
      aria-label={label}
      className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-line-subtle bg-surface shadow-edge", className)}
    >
      <button
        type="button"
        onClick={() => {
          notePanelToggle(label);
          onExpand();
        }}
        title={t("展開{label}", { label })}
        data-panel-toggle=""
        className="group/rail flex min-h-0 flex-1 flex-col items-center gap-2 py-2.5 text-fg-tertiary transition-colors duration-(--duration-fast) ease-standard outline-none hover:bg-raised/70 hover:text-fg active:bg-sunken active:duration-0 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
      >
        <Icon aria-hidden className="size-4 shrink-0 transition-colors duration-(--duration-fast) group-hover/rail:text-brand-cyan" />
        <span className="text-caption tracking-wide [writing-mode:vertical-rl]">{t("展開{label}", { label })}</span>
      </button>
    </section>
  );
}
