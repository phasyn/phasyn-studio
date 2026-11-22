// Detail of the selected run: a header (what it is, its state, its measured total time, the run's actions) and a
// 44 px tab strip, so the panel fits one screen instead of scrolling for thousands of pixels (audit F-04): 概覽 (time
// left, what to do next, one card per item), 階段 (stepper, stage matrix, DiT measurements), 時間軸 (when each step
// ran) and 指標 (what the components reported). The chosen tab is remembered in this browser. The running run's
// figures come from the render activity (one poll and one clock for the whole Studio); an ended run is read from its
// own steps.
import { Archive, ArchiveRestore, Ban, ChartGantt, ExternalLink, Gauge, LayoutDashboard, Rows3, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { isApiError } from "@/api/http";
import { useRun } from "@/api/runs";
import { ActionButton } from "@/components/common/ActionButton";
import { CancelRunDialog } from "@/components/common/CancelRunDialog";
import { NativeRunRecipePanel } from "@/features/inference-presets";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { returnFocusOr } from "@/components/ui/focusReturn";
import { PANEL_RAISED } from "@/components/ui/look";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { elapsedMs, useNow } from "@/lib/time";
import { usePersistentChoice } from "@/lib/usePersistentSize";
import { useRunProgress } from "../../hooks/useRunProgress";
import type { QueueItem } from "../../model/renderQueue";
import { useRenderActivity } from "../../renderActivityContext";
import { useStudio } from "../../studioContext";
import { TakeStateMark } from "../marks";
import { Gantt } from "./Gantt";
import { KIND_ICON } from "./kindIcon";
import { RunMetrics } from "./MetricsPanel";
import { Overview } from "./Overview";
import { runItems } from "./runView";
import { Stages } from "./Stages";
import { formatSpan, formatSpanExact } from "./time";
import { useLookup } from "./useLookup";
import { t, tServer } from "@/i18n";

type DetailTab = "overview" | "stages" | "timeline" | "metrics" | "recipe";
const DETAIL_TABS: readonly DetailTab[] = ["overview", "stages", "timeline", "metrics", "recipe"];

/** What else stops with the run: every shot of a batch or every variation (finished ones are kept). */
function cancelScopeText(item: QueueItem): string | undefined {
  if (item.kind === "batch") return t("這個 run 的 {count} 個鏡頭都會停止；已經完成的保留。", { count: item.takes.length });
  if (item.kind === "variations") return t("這個 run 的 {count} 個變體都會停止；已經完成的保留。", { count: item.takes.length });
  return undefined;
}

export function RunDetail({ item }: { item: QueueItem }) {
  const run = useRun(item.runId);
  const lookup = useLookup();
  const { project, archivedRunIds, setRunArchived, deleteRuns } = useStudio();
  const activity = useRenderActivity();
  // The render this project waits for: its figures (time left, items, clock) are worked out once for the Studio
  const live = activity !== null && activity.run.run_id === item.runId ? activity : null;
  const archived = archivedRunIds.has(item.runId);
  const [archiving, setArchiving] = useState(false);
  const [tab, setTab] = usePersistentChoice<DetailTab>("studio.render.detail.tab", "overview", DETAIL_TABS);
  // The Cancel button that asked (non-null while confirming); it leaves with the running state, and focus then goes to
  // the link to this run's record in the same header
  const [cancelOpener, setCancelOpener] = useState<HTMLElement | null>(null);
  const recordLinkRef = useRef<HTMLAnchorElement>(null);
  const running = run.data?.state === "running";
  // The project (or the list) can see the end before this run's own poll does: read it again then, so the header does
  // not keep 「渲染中」 and 「取消」 for a run that already finished
  const ended = item.state !== "rendering";
  const { refetch } = run;
  useEffect(() => {
    if (running && ended) void refetch();
  }, [running, ended, refetch]);
  // A second clock only when the activity does not give the time (a running run it does not cover)
  const ownNow = useNow(running && live === null);
  const now = live?.now ?? ownNow;
  // The activity's run is polled by its provider: read the same cache; anything else polls here while its DiT runs
  const progress = useRunProgress(run.data, { poll: live === null, lookup });
  const items = runItems(item, run.data, live, progress.views, lookup);
  const total = run.data ? elapsedMs(run.data.created_at, run.data.finished_at, running ? now : null) : null;
  const busyRun = running || item.state === "rendering";
  const Icon = KIND_ICON[item.kind];
  return (
    // 每選一個渲染項目就重新掛載（key＝run）：詳情淡入，不硬切
    <section aria-label={t("渲染詳情")} className={cn(PANEL_RAISED, "animate-fade-in")}>
      <header className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-subtle px-4 py-2.5">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-gradient-soft text-brand-cyan ring-1 ring-brand-blue/40 ring-inset">
          <Icon className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 basis-64">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-section font-semibold text-fg" title={item.title}>
              {item.title}
            </h2>
            <TakeStateMark state={run.data ? (run.data.state === "running" ? "rendering" : run.data.state) : item.state} />
          </div>
          <div className="flex min-w-0 items-center gap-x-2 text-caption text-fg-tertiary">
            <span className="truncate">{formatTimestamp(item.createdAt)}</span>
            <span className="inline-flex shrink-0 items-baseline gap-1" title={t("從 run 建立到結束的實際經過時間（進行中算到現在）：{total}", { total: formatSpanExact(total) })}>
              {t("總耗時")}
              <span className="machine text-data font-semibold text-fg">{formatSpan(total)}</span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {running && run.data ? (
            <Button size="sm" variant="danger" icon={<Ban aria-hidden />} onClick={(event) => { setCancelOpener(event.currentTarget); }} title={t("取消這個 run（會先確認）")}>
              {item.kind === "export" ? t("取消匯出") : t("取消渲染")}
            </Button>
          ) : null}
          <ActionButton
            size="sm"
            variant="quiet"
            icon={archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
            pending={archiving}
            disabledReason={busyRun ? t("渲染中的 run 不能封存") : null}
            title={archived ? t("取消封存：回到工作清單") : t("封存：從工作清單與素材隱藏，檔案與紀錄都保留")}
            onClick={() => {
              setArchiving(true);
              void setRunArchived(item.runId, !archived).finally(() => { setArchiving(false); });
            }}
          >
            {archived ? t("取消封存") : t("封存")}
          </ActionButton>
          <ActionButton
            size="sm"
            variant="quiet"
            icon={<Trash2 aria-hidden />}
            disabledReason={busyRun ? t("渲染中的 run 不能刪除：先取消或等它結束") : null}
            title={t("永久刪除這次渲染的影片、中間檔與紀錄")}
            onClick={() => { deleteRuns([item.runId]); }}
            className="hover:text-danger"
          >
            {t("刪除")}
          </ActionButton>
          {/* Secondary: everything needed is in this detail; the full record is one link away */}
          <Link ref={recordLinkRef} to={`/records/runs/${encodeURIComponent(item.runId)}`} title={t("在「紀錄・執行紀錄」開啟完整紀錄")} className="ml-1 inline-flex items-center gap-1 rounded-sm px-1 text-caption text-fg-tertiary underline-offset-2 hover:text-action-fg hover:underline [&_svg]:size-3">
            {t("在紀錄中開啟")}
            <ExternalLink aria-hidden />
          </Link>
        </div>
      </header>
      <PanelTabs
        variant="studio"
        idPrefix="run-detail"
        label={t("渲染詳情")}
        value={tab}
        onChange={(next) => { setTab(DETAIL_TABS.find((id) => id === next) ?? "overview"); }}
        tabs={[
          { id: "overview", label: t("概覽"), icon: LayoutDashboard },
          { id: "stages", label: t("階段"), icon: Rows3 },
          { id: "timeline", label: t("時間軸"), icon: ChartGantt },
          { id: "metrics", label: t("指標"), icon: Gauge },
          { id: "recipe", label: t("推論配方"), icon: SlidersHorizontal },
        ]}
      />
      {/* 唯一的捲動區：只垂直捲動；子項都允許縮到 0 寬（minmax(0,1fr)），寬內容在自己的欄內換行或截斷 */}
      <div role="tabpanel" id={`run-detail-panel-${tab}`} aria-labelledby={`run-detail-tab-${tab}`} className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto p-4">
        {run.isError && !run.data ? (
          <EmptyState
            size="compact"
            illustration="offline"
            title={t("讀取 run 失敗")}
            description={isApiError(run.error) ? tServer(run.error.message) : t("主控沒有回應；檢查連線後再讀取一次。")}
            action={
              <Button size="sm" variant="secondary" pending={run.isFetching} onClick={() => void run.refetch()}>
                {t("重新讀取")}
              </Button>
            }
          />
        ) : run.isError ? (
          <p className="text-data text-danger">{t("讀取 run 失敗：{value}", { value: isApiError(run.error) ? tServer(run.error.message) : "" })}</p>
        ) : null}
        {tab === "overview" ? <Overview item={item} run={run.data} live={live} items={items} views={progress.views} lookup={lookup} /> : null}
        {tab === "stages" ? <Stages run={run.data} item={item} now={now} views={progress.views} error={progress.error} remaining={live?.remaining?.branches} lookup={lookup} /> : null}
        {tab === "timeline" ? run.data ? <Gantt run={run.data} item={item} now={now} lookup={lookup} /> : <p className="text-data text-fg-tertiary">{t("讀取 run…")}</p> : null}
        {tab === "recipe" ? <NativeRunRecipePanel runId={item.runId} running={running} scope={{ projectId: project.project_id, shotId: item.takes[0]?.shot.shot_id ?? null }} /> : null}
        {tab === "metrics" ? <RunMetrics item={item} run={run.data} lookup={lookup} /> : null}
      </div>
      {/* Mounted only while confirming (every confirmation starts fresh); it stays with its answer when the run ends */}
      {run.data && cancelOpener ? (
        <CancelRunDialog
          run={run.data}
          open
          onOpenChange={(open) => { if (!(open)) { setCancelOpener(null); } }}
          scope={cancelScopeText(item)}
          onCloseAutoFocus={(event) => { returnFocusOr(event, cancelOpener, recordLinkRef.current); }}
        />
      ) : null}
    </section>
  );
}
