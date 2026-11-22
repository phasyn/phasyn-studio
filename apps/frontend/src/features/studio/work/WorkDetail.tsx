// Detail of a 工作 item that is not a tracked shot render or export (a fix, a mask, a mix preview, a transcription, a
// tool run…): the same header as the render detail (what it is, its state, local time, measured total time, cancel
// while it runs) and three tabs — 概覽 (kind, times, the shot it was made for, why it failed, whether its result no
// longer matches the project), 時間軸 (when each step ran) and 推論配方 (the generation receipt). The run's full record
// is a secondary link (「在紀錄中開啟」); everything a person needs is here.
import { Ban, ChartGantt, ExternalLink, LayoutDashboard, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { Suspense, use, useMemo, useState } from "react";
import { Link } from "react-router";
import { isApiError } from "@/api/http";
import { useRun } from "@/api/runs";
import type { WireRun } from "@/api/types";
import { CancelRunDialog } from "@/components/common/CancelRunDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { KeyValueList, type KvItem } from "@/components/ui/kv";
import { CARD, PANEL_RAISED } from "@/components/ui/look";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { NativeRunRecipePanel } from "@/features/inference-presets";
import { t, tServer } from "@/i18n";
import { cn } from "@/lib/cn";
import { wireDefinitions } from "@/lib/contractSchemas";
import { formatTimestamp } from "@/lib/format";
import { elapsedMs, useNow } from "@/lib/time";
import { usePersistentChoice } from "@/lib/usePersistentSize";
import { workDependencies } from "../components/projectHistoryState";
import { TakeStateMark } from "../components/marks";
import { Gantt } from "../components/render/Gantt";
import { formatSpan, formatSpanExact } from "../components/render/time";
import { useLookup } from "../components/render/useLookup";
import { projectTimeline } from "../editor/sources";
import type { QueueItem } from "../model/renderQueue";
import { useStudio } from "../studioContext";
import { noteOf, runState, type WorkItem } from "./workItems";
import { WorkResult } from "./WorkResults";

type DetailTab = "overview" | "timeline" | "recipe";
const DETAIL_TABS: readonly DetailTab[] = ["overview", "timeline", "recipe"];

/** The Gantt's view of a run without takes: one group per branch, unnamed. */
function ganttItem(item: WorkItem): QueueItem {
  return { runId: item.runId, kind: "shot", title: item.title, createdAt: item.createdAt, takes: [], record: null, state: item.state };
}

/** Whether the run's result still matches the project (the same check the old 專案工作歷史 made). */
function StaleNote({ run }: { run: WireRun }) {
  const { project } = useStudio();
  const definitions = use(wireDefinitions());
  const reason = useMemo(() => {
    const timeline = projectTimeline(project);
    return timeline.ok ? workDependencies(project, timeline.value, definitions)(run) : null;
  }, [project, definitions, run]);
  if (reason === null) return null;
  return (
    <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-data text-warning">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      {t("這個結果已經跟不上專案：{reason}。需要的話重新做一次。", { reason })}
    </p>
  );
}

function Overview({ item, run, total }: { item: WorkItem; run: WireRun; total: number | null }) {
  const { project } = useStudio();
  const noted = noteOf(run)["shot_id"];
  const shotId = (run.studio_work ?? run.request.origin?.studio_work)?.shot_id ?? (typeof noted === "string" ? noted : undefined);
  const shot = shotId === undefined ? undefined : (project.shots.find((entry) => entry.shot_id === shotId)?.title ?? project.image_shots?.find((entry) => entry.image_shot_id === shotId)?.title);
  const facts: KvItem[] = [
    { key: "kind", label: t("類型"), value: item.kindLabel },
    ...(shot === undefined ? [] : [{ key: "shot", label: t("鏡頭"), value: shot }]),
    { key: "started", label: t("開始"), value: formatTimestamp(run.created_at), mono: true },
    { key: "finished", label: t("結束"), value: run.finished_at === null ? t("還在進行") : formatTimestamp(run.finished_at), mono: true },
    { key: "total", label: t("總耗時"), value: formatSpanExact(total), mono: true },
  ];
  return (
    <div className="grid content-start gap-4">
      <section aria-label={t("概覽")} className={cn(CARD, "px-4 py-3")}>
        <KeyValueList items={facts} className="max-w-xl" />
      </section>
      {run.error ? (
        <p role="status" className="flex items-start gap-1.5 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-data text-danger">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{tServer(run.error.message)}</span>
        </p>
      ) : null}
      <WorkResult kind={item.kind} run={run} />
      <Suspense fallback={null}>
        <StaleNote run={run} />
      </Suspense>
    </div>
  );
}

export function WorkDetail({ item }: { item: WorkItem }) {
  const run = useRun(item.runId);
  const lookup = useLookup();
  const { project } = useStudio();
  const [tab, setTab] = usePersistentChoice<DetailTab>("studio.work.detail.tab", "overview", DETAIL_TABS);
  const [confirming, setConfirming] = useState(false);
  const running = run.data?.state === "running";
  const now = useNow(running);
  const total = run.data ? elapsedMs(run.data.created_at, run.data.finished_at, running ? now : null) : null;
  const Icon = item.icon;
  return (
    <section aria-label={t("工作詳情")} className={cn(PANEL_RAISED, "animate-fade-in")}>
      <header className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-subtle px-4 py-2.5">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-gradient-soft text-brand-cyan ring-1 ring-brand-blue/40 ring-inset">
          <Icon className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 basis-64">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-section font-semibold text-fg" title={item.title}>
              {item.title}
            </h2>
            <TakeStateMark state={run.data ? runState(run.data) : item.state} />
          </div>
          <div className="flex min-w-0 items-center gap-x-2 text-caption text-fg-tertiary">
            <span className="shrink-0">{item.kindLabel}</span>
            <span className="truncate">{formatTimestamp(item.createdAt)}</span>
            <span className="inline-flex shrink-0 items-baseline gap-1" title={t("從開始到結束的實際經過時間（進行中算到現在）：{total}", { total: formatSpanExact(total) })}>
              {t("總耗時")}
              <span className="machine text-data font-semibold text-fg">{formatSpan(total)}</span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running ? (
            <Button size="sm" variant="danger" icon={<Ban aria-hidden />} onClick={() => { setConfirming(true); }} title={t("取消這個工作（會先確認）")}>
              {t("取消")}
            </Button>
          ) : null}
          <Link to={`/records/runs/${encodeURIComponent(item.runId)}`} title={t("在「紀錄・執行紀錄」開啟完整紀錄")} className="inline-flex items-center gap-1 rounded-sm px-1 text-caption text-fg-tertiary underline-offset-2 hover:text-action-fg hover:underline [&_svg]:size-3">
            {t("在紀錄中開啟")}
            <ExternalLink aria-hidden />
          </Link>
        </div>
      </header>
      <PanelTabs
        variant="studio"
        idPrefix="work-detail"
        label={t("工作詳情")}
        value={tab}
        onChange={(next) => { setTab(DETAIL_TABS.find((id) => id === next) ?? "overview"); }}
        tabs={[
          { id: "overview", label: t("概覽"), icon: LayoutDashboard },
          { id: "timeline", label: t("時間軸"), icon: ChartGantt },
          { id: "recipe", label: t("推論配方"), icon: SlidersHorizontal },
        ]}
      />
      <div role="tabpanel" id={`work-detail-panel-${tab}`} aria-labelledby={`work-detail-tab-${tab}`} className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto p-4">
        {run.isError && !run.data ? (
          <EmptyState
            size="compact"
            illustration="offline"
            title={t("讀取工作失敗")}
            description={isApiError(run.error) ? tServer(run.error.message) : t("主控沒有回應；檢查連線後再讀取一次。")}
            action={
              <Button size="sm" variant="secondary" pending={run.isFetching} onClick={() => void run.refetch()}>
                {t("重新讀取")}
              </Button>
            }
          />
        ) : null}
        {!run.data && !run.isError ? <p className="text-data text-fg-tertiary">{t("讀取工作…")}</p> : null}
        {run.data && tab === "overview" ? <Overview item={item} run={run.data} total={total} /> : null}
        {run.data && tab === "timeline" ? <Gantt run={run.data} item={ganttItem(item)} now={now} lookup={lookup} /> : null}
        {tab === "recipe" ? <NativeRunRecipePanel runId={item.runId} running={running} scope={{ projectId: project.project_id, shotId: null }} /> : null}
      </div>
      {run.data && confirming ? (
        <CancelRunDialog run={run.data} open onOpenChange={(open) => { if (!open) setConfirming(false); }} />
      ) : null}
    </section>
  );
}
