// Render queue panel (left): a title bar with the collapse button, filter tabs with 16 px icons and a count on every
// tab, the archived toggle, one row per run (the running one first; QueueRow) and the export entry at the bottom.
// The panel is 27rem wide so the four tabs keep their icons and counts (PanelTabs drops icons when its strip is too
// narrow).
import { Archive, Ban, CircleCheck, Clapperboard, ListVideo, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { PANEL, PANEL_HEADER, PANEL_TITLE } from "@/components/ui/look";
import { usePanelEnter } from "@/components/ui/motion";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { PanelCollapseButton } from "@/features/studio-shell";
import { cn } from "@/lib/cn";
import type { QueueItem } from "../../model/renderQueue";
import { useStudio } from "../../studioContext";
import { ExportDialog } from "../ExportDialog";
import { QueueRow } from "./QueueRow";
import { t } from "@/i18n";

/** The queue's width: four tabs with icons and counts fit their strip (see the header comment). */
export const QUEUE_WIDTH = "27rem";

type QueueFilter = "all" | "active" | "done" | "failed";

/** 沒有成功的都在「未成功」（失敗、取消、中斷）：標籤不把取消說成失敗。 */
function matches(filter: QueueFilter, item: QueueItem): boolean {
  if (filter === "active") return item.state === "rendering";
  if (filter === "done") return item.state === "succeeded";
  if (filter === "failed") return item.state !== "succeeded" && item.state !== "rendering";
  return true;
}

export function Queue({ items, selected, onSelect, onCollapse }: { items: QueueItem[]; selected: string | null; onSelect: (runId: string) => void; onCollapse: () => void }) {
  const { archivedRunIds } = useStudio();
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = items.filter((item) => archivedRunIds.has(item.runId)).length;
  const visible = showArchived ? items : items.filter((item) => !archivedRunIds.has(item.runId));
  const shown = visible.filter((item) => matches(filter, item));
  const count = (which: QueueFilter) => visible.filter((item) => matches(which, item)).length;
  const enter = usePanelEnter<HTMLElement>(t("渲染佇列"), "left");
  return (
    <section ref={enter} aria-label={t("渲染佇列")} className={PANEL}>
      <div className={cn(PANEL_HEADER, "pr-1.5")}>
        <ListVideo aria-hidden className="size-4 shrink-0 text-brand-cyan" />
        <h2 className={cn(PANEL_TITLE, "truncate")}>{t("渲染佇列")}</h2>
        <span className="ml-auto" />
        <PanelCollapseButton side="left" label={t("渲染佇列")} onCollapse={onCollapse} />
      </div>
      <PanelTabs
        variant="studio"
        idPrefix="render-queue"
        label={t("篩選渲染")}
        value={filter}
        onChange={(next) => setFilter(next === "active" || next === "done" || next === "failed" ? next : "all")}
        tabs={[
          { id: "all", label: t("全部"), icon: ListVideo, count: visible.length },
          { id: "active", label: t("進行中"), icon: LoaderCircle, count: count("active") },
          { id: "done", label: t("完成"), icon: CircleCheck, count: count("done") },
          { id: "failed", label: t("未成功"), icon: Ban, count: count("failed") },
        ]}
      />
      {archivedCount > 0 ? (
        <label className="flex min-h-8 shrink-0 cursor-pointer items-center gap-2 border-b border-line-subtle px-3 py-1.5 text-caption text-fg-secondary transition-colors duration-(--duration-fast) hover:bg-raised/50">
          <input type="checkbox" className="size-3.5 accent-action" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          <Archive aria-hidden className="size-3.5 text-fg-tertiary" />
          {t("顯示已封存（{archivedCount}）", { archivedCount })}
        </label>
      ) : null}
      <div role="tabpanel" id={`render-queue-panel-${filter}`} aria-labelledby={`render-queue-tab-${filter}`} className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <EmptyState
            size="compact"
            icon={items.length === 0 ? <Clapperboard /> : visible.length === 0 ? <Archive /> : <ListVideo />}
            title={items.length === 0 ? t("還沒有渲染紀錄") : visible.length === 0 ? t("渲染紀錄都已封存") : t("沒有符合篩選的項目")}
            description={items.length === 0 ? t("到「鏡頭」選一個鏡頭按「渲染鏡頭」。") : visible.length === 0 ? t("勾選「顯示已封存」可以查看。") : undefined}
          />
        ) : (
          <ul aria-label={t("渲染項目")} className="grid py-1">
            {shown.map((item, index) => (
              <QueueRow key={item.runId} item={item} index={index} active={item.runId === selected} archived={archivedRunIds.has(item.runId)} onSelect={onSelect} />
            ))}
          </ul>
        )}
      </div>
      {/* 渲染好之後在這裡就能匯出成片：與專案選單、「編輯」的「匯出」是同一個對話框 */}
      <div className="shrink-0 border-t border-line-subtle p-3">
        <ExportDialog size="md" className="w-full" />
      </div>
    </section>
  );
}
