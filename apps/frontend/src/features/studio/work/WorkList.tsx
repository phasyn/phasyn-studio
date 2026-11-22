// The 工作 panel (left column of the Render workspace): every run of the project in one list — renders, exports, fixes,
// masks, mix previews, transcription and voice lines; the lab and experiment tool runs that only name the project
// wait in a collapsed 「其他工具」 group at the end of the list. A title bar with the collapse button, status tabs with 16 px
// icons and counts, a kind menu and the archived toggle, then one row per run (the running one first; a tracked render
// keeps its live progress row), 「讀取較早的工作」 at the end, and the export entry at the bottom. Records brought in with a
// portable package fold into a section under the list. Clicking a row opens its detail on the right.
import { Archive, Ban, CircleCheck, Clapperboard, Download, ListTodo, LoaderCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { contractJson } from "@/api/http";
import { Disclosure } from "@/components/common/Disclosure";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { LIST_ROW, LIST_ROW_IDLE, LIST_ROW_SELECTED, PANEL, PANEL_HEADER, PANEL_TITLE } from "@/components/ui/look";
import { reveal, usePanelEnter } from "@/components/ui/motion";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { PanelCollapseButton } from "@/features/studio-shell";
import { t } from "@/i18n";
import { joinInline } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { downloadJson } from "@/lib/download";
import { formatTimestamp } from "@/lib/format";
import { ExportDialog } from "../components/ExportDialog";
import { TakeStateMark } from "../components/marks";
import { QueueRow } from "../components/render/QueueRow";
import { useStudio } from "../studioContext";
import { matchesFilter, WORK_KIND_LABEL, WORK_KINDS, type WorkFilter, type WorkItem, type WorkKind } from "./workItems";

/** The panel's width: four tabs with icons and counts fit their strip (PanelTabs drops icons when it is too narrow). */
export const WORK_LIST_WIDTH = "27rem";

function isKind(value: string): value is WorkKind {
  return (WORK_KINDS as readonly string[]).includes(value);
}

function WorkRow({ item, index, active, archived, onSelect }: { item: WorkItem; index: number; active: boolean; archived: boolean; onSelect: (runId: string) => void }) {
  const Icon = item.icon;
  const meta = joinInline([item.kindLabel, formatTimestamp(item.createdAt)]);
  return (
    <li ref={reveal(index)}>
      <button
        type="button"
        onClick={() => { onSelect(item.runId); }}
        aria-current={active ? "true" : undefined}
        className={cn(LIST_ROW, "grid min-h-[3.25rem] w-full min-w-0 content-center gap-1 px-3 py-2 text-left", active ? LIST_ROW_SELECTED : LIST_ROW_IDLE)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon aria-hidden className={cn("size-3.5 shrink-0", active ? "text-brand-cyan" : "text-fg-tertiary")} />
          <span className={cn("truncate text-data", archived ? "text-fg-tertiary" : "text-fg")} title={item.title}>
            {item.title}
          </span>
          {archived ? <Archive aria-label={t("已封存")} className="size-3 shrink-0 text-fg-tertiary" /> : null}
          <span className="ml-auto flex shrink-0 items-center">
            <TakeStateMark state={item.state} />
          </span>
        </span>
        <span className="truncate pl-5.5 text-caption text-fg-tertiary" title={meta}>
          {meta}
        </span>
      </button>
    </li>
  );
}

/** Records that came with a portable package: their recipes (and draft plans) can be downloaded. */
function ImportedRecords({ projectId }: { projectId: string }) {
  const imported = useQuery({
    queryKey: ["studio", "archive-history", projectId],
    queryFn: ({ signal }) => contractJson("StudioPortableHistory", "/api/studio/projects/" + encodeURIComponent(projectId) + "/portable/history", { signal }),
    staleTime: 60_000,
  });
  const runs = imported.data?.runs ?? [];
  const drafts = imported.data?.drafts ?? [];
  if (runs.length + drafts.length === 0) return null;
  return (
    <div className="border-t border-line-subtle px-3 py-1.5">
      <Disclosure summary={t("從可攜包帶來的紀錄（{count}）", { count: runs.length + drafts.length })} summaryClassName="text-caption">
        <ul className="grid max-h-40 gap-0.5 overflow-y-auto">
          {runs.map((job) => (
            <li key={job.run_id}>
              <Button size="sm" variant="quiet" icon={<Download aria-hidden />} className="w-full justify-start" title={t("下載這筆紀錄的生成配方（JSON）")} onClick={() => { downloadJson(job.run_id + ".json", job.request); }}>
                <span className="truncate">{job.request.label ?? job.request.pipeline.label}</span>
              </Button>
            </li>
          ))}
          {drafts.map((plan, index) => (
            <li key={plan.plan_id}>
              <Button size="sm" variant="quiet" icon={<Download aria-hidden />} className="w-full justify-start" onClick={() => { downloadJson(plan.plan_id + ".json", plan); }}>
                {t("批次草稿 {index}", { index: index + 1 })}
              </Button>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

export interface WorkListProps {
  items: readonly WorkItem[];
  selected: string | null;
  onSelect: (runId: string) => void;
  onCollapse: () => void;
  /** The Controller's list has older runs. */
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** The Controller's list is still loading (the tracked renders show already). */
  loading: boolean;
}

export function WorkList({ items, selected, onSelect, onCollapse, hasMore, loadingMore, onLoadMore, loading }: WorkListProps) {
  const { project, archivedRunIds } = useStudio();
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [kind, setKind] = useState<WorkKind | "all">("all");
  const [showArchived, setShowArchived] = useState(false);
  const isArchived = (item: WorkItem) => archivedRunIds.has(item.runId) || (item.run?.archived_at ?? null) !== null;
  const archivedCount = items.filter(isArchived).length;
  const visible = items.filter((item) => item.studio && (showArchived || !isArchived(item)) && (kind === "all" || item.kind === kind));
  const shown = visible.filter((item) => matchesFilter(filter, item));
  // Lab and experiment tool runs: under 「其他工具」 (collapsed), with the status filter; hidden while a kind is chosen
  const tools = kind === "all" ? items.filter((item) => !item.studio && (showArchived || !isArchived(item)) && matchesFilter(filter, item)) : [];
  const count = (which: WorkFilter) => visible.filter((item) => matchesFilter(which, item)).length;
  const kinds = WORK_KINDS.filter((id) => id !== "tool" && (id === kind || items.some((item) => item.kind === id)));
  const enter = usePanelEnter<HTMLElement>(t("工作"), "left");
  return (
    <section ref={enter} aria-label={t("工作")} className={PANEL}>
      <div className={cn(PANEL_HEADER, "pr-1.5")}>
        <ListTodo aria-hidden className="size-4 shrink-0 text-brand-cyan" />
        <h2 className={cn(PANEL_TITLE, "truncate")}>{t("工作")}</h2>
        {loading ? <LoaderCircle aria-label={t("讀取工作清單…")} className="size-3.5 shrink-0 animate-spin text-fg-tertiary" /> : null}
        <span className="ml-auto" />
        <PanelCollapseButton side="left" label={t("工作")} onCollapse={onCollapse} />
      </div>
      <PanelTabs
        variant="studio"
        idPrefix="work-list"
        label={t("依狀態篩選工作")}
        value={filter}
        onChange={(next) => { setFilter(next === "active" || next === "done" || next === "failed" ? next : "all"); }}
        tabs={[
          { id: "all", label: t("全部"), icon: ListTodo, count: visible.length },
          { id: "active", label: t("進行中"), icon: LoaderCircle, count: count("active") },
          { id: "done", label: t("完成"), icon: CircleCheck, count: count("done") },
          { id: "failed", label: t("未成功"), icon: Ban, count: count("failed") },
        ]}
      />
      <div className="flex min-h-10 shrink-0 items-center gap-3 border-b border-line-subtle px-3 py-1.5">
        <div className="w-40 shrink-0">
          <Select
            compact
            aria-label={t("工作類型")}
            value={kind}
            onChange={(event) => {
              const value = event.target.value;
              setKind(value === "all" || !isKind(value) ? "all" : value);
            }}
          >
            <option value="all">{t("全部類型")}</option>
            {kinds.map((id) => (
              <option key={id} value={id}>
                {WORK_KIND_LABEL[id]()}
              </option>
            ))}
          </Select>
        </div>
        {archivedCount > 0 ? (
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-caption text-fg-secondary transition-colors duration-(--duration-fast) hover:text-fg">
            <input type="checkbox" className="size-3.5 accent-action" checked={showArchived} onChange={(event) => { setShowArchived(event.target.checked); }} />
            <Archive aria-hidden className="size-3.5 shrink-0 text-fg-tertiary" />
            <span className="truncate">{t("顯示已封存（{archivedCount}）", { archivedCount })}</span>
          </label>
        ) : null}
      </div>
      <div role="tabpanel" id={`work-list-panel-${filter}`} aria-labelledby={`work-list-tab-${filter}`} className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && tools.length === 0 && !loading ? (
          <EmptyState
            size="compact"
            icon={items.length === 0 ? <Clapperboard /> : visible.length === 0 && archivedCount > 0 && !showArchived ? <Archive /> : <ListTodo />}
            title={items.length === 0 ? t("還沒有工作") : t("沒有符合篩選的工作")}
            description={items.length === 0 ? t("到「鏡頭」選一個鏡頭按「渲染鏡頭」，渲染、修正、匯出都會列在這裡。") : undefined}
          />
        ) : (
          <ul aria-label={t("工作項目")} className="grid py-1">
            {shown.map((item, index) =>
              item.queue ? (
                <QueueRow key={item.runId} item={item.queue} index={index} active={item.runId === selected} archived={isArchived(item)} onSelect={onSelect} />
              ) : (
                <WorkRow key={item.runId} item={item} index={index} active={item.runId === selected} archived={isArchived(item)} onSelect={onSelect} />
              ),
            )}
          </ul>
        )}
        {tools.length > 0 ? (
          <div className="border-t border-line-subtle py-1">
            <Disclosure defaultOpen={tools.some((item) => item.runId === selected)} summary={t("其他工具（{count}）", { count: tools.length })} summaryClassName="px-3 text-caption">
              <ul aria-label={t("其他工具")} className="grid pt-1">
                {tools.map((item, index) => (
                  <WorkRow key={item.runId} item={item} index={index} active={item.runId === selected} archived={isArchived(item)} onSelect={onSelect} />
                ))}
              </ul>
            </Disclosure>
          </div>
        ) : null}
        {hasMore ? (
          <div className="px-3 pt-1 pb-3">
            <Button size="sm" variant="quiet" className="w-full" pending={loadingMore} onClick={onLoadMore}>
              {t("讀取較早的工作")}
            </Button>
          </div>
        ) : null}
      </div>
      <ImportedRecords projectId={project.project_id} />
      {/* 渲染好之後在這裡就能匯出成片：與「編輯」的「匯出」是同一個對話框 */}
      <div className="shrink-0 border-t border-line-subtle p-3">
        <ExportDialog size="md" className="w-full" />
      </div>
    </section>
  );
}
