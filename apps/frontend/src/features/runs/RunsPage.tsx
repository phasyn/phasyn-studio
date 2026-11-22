import { Activity, Archive, ArchiveRestore, ListPlus, ListVideo, Search, Trash2 } from "lucide-react";
import { use, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateAfterRunChange, setRunArchived, useRunList } from "@/api/runs";
import { runSteps, type RunState } from "@/api/types";
import { AreaIcon } from "@/components/common/AreaIcon";
import { CircularProgress } from "@/components/common/CircularProgress";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { StatusBadge } from "@/components/common/StatusBadge";
import { IdText, TimeText } from "@/components/common/values";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { reveal } from "@/components/ui/motion";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/variants";
import { DocTabs } from "@/components/workbench/DocTabs";
import { OutlinerSlotContext } from "@/components/workbench/outlinerContext";
import { ToolStrip } from "@/components/workbench/ToolStrip";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { ActivityLog } from "@/features/activity";
import { runDisplayName, runDisplayNameWithId, runIdName } from "@/lib/runName";
import { useSearchParamText } from "@/lib/useSearchParamText";
import { RunDeleteDialog } from "./RunDeleteDialog";
import { runOutputKind, stepProgress, stepProgressText } from "./runModel";
import { RunStateFilterBar, RunStateOutliner, type RunStateFilterProps } from "./RunStateOutliner";
import { PATHS, runPath } from "@/app/paths";
import { tServer, t } from "@/i18n";
import { T } from "@/i18n/T";
import { Elapsed } from "./Elapsed";

/** 第一次讀取時的佔位列數。 */
const SKELETON_ROWS = [0, 1, 2, 3, 4];

/** run 列表：cursor 分頁（載入更多不移動焦點）；有執行中的 run 時才輪詢。狀態與文字篩選只作用在已載入的 run。 */
export function RunsPage() {
  const [params, setParams] = useSearchParams();
  const archivedView = params.get("archived") === "only";
  const runs = useRunList(50, archivedView ? "only" : "exclude");
  const client = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const anyRunning = items.some((run) => run.state === "running");
  const stateFilter = params.get("state") ?? "";
  // The state outline lives in the left column; when that is collapsed the tool strip carries the same filter.
  const outlineShown = use(OutlinerSlotContext) !== null;
  // The search box shows local text (fast typing keeps every character); the URL follows when typing pauses
  const [query, setQuery] = useSearchParamText("q");
  const counts: Partial<Record<RunState, number>> = {};
  for (const run of items) counts[run.state] = (counts[run.state] ?? 0) + 1;
  const needle = query.trim().toLowerCase();
  const shown = items.filter(
    (run) =>
      (!stateFilter || run.state === stateFilter) &&
      (!needle ||
        [run.run_id, run.request.label ?? "", run.request.pipeline.label, run.request.pipeline.pipeline_id, run.error?.code ?? ""].some((text) =>
          text.toLowerCase().includes(needle),
        )),
  );
  const update = (key: string, value: string) => { setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    ); };
  // 選取只保留目前畫面上、可以處理（非執行中）的 run
  const selectable = shown.filter((run) => run.state !== "running");
  const chosen = selectable.filter((run) => selected.has(run.run_id));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;
  const toggle = (runId: string, on: boolean) => { setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(runId);
      else next.delete(runId);
      return next;
    }); };
  // Bulk results and the delete confirmation name each run with its short id: many runs share a label or a pipeline
  const labelOf = (runId: string) => {
    const run = items.find((item) => item.run_id === runId);
    return run ? runDisplayNameWithId(run) : runIdName(runId);
  };
  const stateFilterProps: RunStateFilterProps = {
    counts,
    total: items.length,
    selected: stateFilter,
    onSelect: (state) => { update("state", state); },
    partial: runs.hasNextPage,
    archivedView,
    onArchivedView: (archived) => {
      setSelected(new Set());
      update("archived", archived ? "only" : "");
    },
  };
  const archiveChosen = async (archived: boolean) => {
    if (archiving || chosen.length === 0) return;
    setArchiving(true);
    setBulkError(null);
    const failed: string[] = [];
    for (const run of chosen) {
      try {
        await setRunArchived(run.run_id, archived);
      } catch (error) {
        failed.push(t("{run_id}：{value}", { run_id: labelOf(run.run_id), value: tServer(error instanceof Error ? error.message : String(error)) }));
      }
    }
    invalidateAfterRunChange(client, chosen.map((run) => run.run_id), false);
    setSelected(new Set());
    setArchiving(false);
    if (failed.length > 0) setBulkError(t("{failedCount} 個 run {value}失敗：{failed}", { failedCount: failed.length, value: archived ? t("封存") : t("取消封存"), failed: failed.join(t("；")) }));
  };

  const center = (
    <>
      <DocTabs label={t("開啟的文件")} tabs={[{ id: "runs", label: t("執行紀錄"), icon: ListVideo, to: PATHS.runs, active: true }]} />
      <PageHeader
        icon={<AreaIcon area="records" size={28} />}
        title={t("執行紀錄")}
        description={t("每個 run 凍結當次流程與輸入；失敗不自動重試、沒有恢復，重新執行就是新的 run。")}
        meta={anyRunning ? <span className="text-caption text-fg-tertiary">{t("有執行中的 run：每 3 秒自動更新")}</span> : null}
        className="shrink-0 border-b border-line-subtle px-4 py-3"
        actions={
          <Link to={PATHS.inferenceRun} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <ListPlus aria-hidden />
            {t("手動執行（推理 Studio）")}
          </Link>
        }
      />
      <ToolStrip label={t("篩選 run")} role="search">
        <div className="relative w-72 min-w-44">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input
            compact
            type="search"
            value={query}
            placeholder={t("搜尋名稱、run_id、流程、錯誤碼")}
            aria-label={t("搜尋 run（名稱、run_id、流程、錯誤碼）")}
            autoComplete="off"
            onChange={(event) => { setQuery(event.target.value); }}
            className="pl-8"
          />
        </div>
        {outlineShown ? null : <RunStateFilterBar {...stateFilterProps} />}
        {chosen.length > 0 ? (
          <div className="flex items-center gap-1.5 rounded-md border border-brand-blue/30 bg-brand-soft py-0.5 pr-0.5 pl-2.5 animate-rise-in">
            <span className="text-caption text-fg-secondary" aria-live="polite">
              <T source={"已選 <0>{chosenCount}</0> 個"} values={{ chosenCount: chosen.length }} slots={[<span key="slot-0" className="machine text-fg" />]} />
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon={archivedView ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
              pending={archiving}
              onClick={() => void archiveChosen(!archivedView)}
              title={archivedView ? t("取消封存：回到一般清單") : t("封存：從一般清單隱藏，檔案與紀錄都保留")}
            >
              {archivedView ? t("取消封存") : t("封存")}
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 aria-hidden />} disabled={archiving} onClick={() => { setDeleting(chosen.map((run) => run.run_id)); }}>
              {t("永久刪除")}
            </Button>
          </div>
        ) : null}
        <p className="ml-auto text-caption text-fg-tertiary" aria-live="polite">
          <T source={"{value}顯示 <0>{shownCount}</0>／已載入 <1>{itemsCount}</1> 個 run"} values={{ value: archivedView ? t("已封存・") : "", shownCount: shown.length, itemsCount: items.length }} slots={[<span key="slot-0" className="machine text-fg-secondary" />, <span key="slot-1" className="machine" />]} />
        </p>
        {runs.hasNextPage ? (
          <Button size="sm" variant="secondary" onClick={() => void runs.fetchNextPage()} pending={runs.isFetchingNextPage}>
            {t("載入更多")}
          </Button>
        ) : items.length > 0 ? (
          <span className="pr-1 text-caption text-fg-tertiary">{t("已載入全部")}</span>
        ) : null}
      </ToolStrip>
      {(runs.isError && items.length > 0) || (bulkError != null && bulkError !== "") ? (
        <div className="grid shrink-0 gap-2 border-b border-line-subtle px-4 py-2">
          {runs.isError && items.length > 0 ? <ErrorCallout error={runs.error} title={t("更新失敗：顯示上一次的資料")} onRetry={() => void runs.refetch()} /> : null}
          {(bulkError != null && bulkError !== "") ? (
            <p role="alert" className="text-data text-danger">
              {bulkError}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {runs.isPending ? (
          <div role="status" className="grid content-start gap-2 px-4 py-4">
            <p className="text-body text-fg-secondary">{t("讀取 run 列表…")}</p>
            {SKELETON_ROWS.map((row) => (
              <div key={row} aria-hidden className="skeleton h-8 animate-shimmer" />
            ))}
          </div>
        ) : runs.isError && items.length === 0 ? (
          <div className="p-4">
            <ErrorCallout error={runs.error} title={t("無法讀取 run 列表")} onRetry={() => void runs.refetch()} retrying={runs.isFetching} />
          </div>
        ) : items.length === 0 && archivedView ? (
          <EmptyState icon={<Archive />} title={t("沒有已封存的 run")} description={t("在一般清單勾選 run 後按「封存」，它會移到這裡；檔案與紀錄都保留，可以隨時取消封存。")} />
        ) : items.length === 0 ? (
          <EmptyState
            illustration="frames"
            title={t("還沒有 run")}
            description={t("在「推理 Studio・手動執行」選一個元件組合、填好輸入後建立第一個 run；Image Studio 與 Video Studio 的生成也會出現在這裡。")}
            action={
              <Link to={PATHS.inferenceRun} className={buttonVariants({ variant: "primary" })}>
                {t("前往「推理 Studio・手動執行」")}
              </Link>
            }
          />
        ) : shown.length === 0 ? (
          <EmptyState icon={<Search />} title={t("沒有符合篩選的 run")} description={t("只篩選已載入的 {itemsCount} 個 run；可以清除篩選或載入更多。", { itemsCount: items.length })} />
        ) : (
          <TableScroll label={t("run 列表")} className="relative min-h-0 flex-1 overflow-auto">
            {/* 固定欄寬（table-fixed）：機器值單行截斷、完整內容在 title；只有 run 名稱欄吃剩餘寬度，不會把流程 ID 擠成一字一行。 */}
            <Table className="min-w-[70.5rem] table-fixed [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]">
              <colgroup>
                <col className="w-11" />
                <col />
                <col className="w-40" />
                <col className="w-34" />
                <col className="w-46" />
                <col className="w-24" />
                <col className="w-24" />
                <col className="w-44" />
              </colgroup>
              <thead>
                <tr>
                  <Th scope="col">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-action"
                      checked={allChosen}
                      disabled={selectable.length === 0}
                      onChange={(event) => { setSelected(event.target.checked ? new Set(selectable.map((run) => run.run_id)) : new Set()); }}
                      aria-label={t("選取畫面上所有可以處理的 run")}
                      title={t("選取畫面上所有可以處理的 run（執行中的 run 不能封存或刪除）")}
                    />
                  </Th>
                  <Th scope="col">run</Th>
                  <Th scope="col">{t("流程")}</Th>
                  <Th scope="col">{t("狀態")}</Th>
                  <Th scope="col">{t("建立")}</Th>
                  <Th scope="col">{t("耗時")}</Th>
                  <Th scope="col">{t("步驟")}</Th>
                  <Th scope="col">{t("錯誤")}</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((run, index) => {
                  const progress = stepProgress(runSteps(run));
                  const running = run.state === "running";
                  const name = runDisplayName(run);
                  return (
                    <Tr
                      key={run.run_id}
                      selected={selected.has(run.run_id)}
                      className="[&>td]:align-middle animate-rise-in"
                      ref={reveal(index)}
                    >
                      <Td>
                        <input
                          type="checkbox"
                          className="size-3.5 accent-action disabled:cursor-not-allowed"
                          checked={selected.has(run.run_id)}
                          disabled={running}
                          onChange={(event) => { toggle(run.run_id, event.target.checked); }}
                          aria-label={t("選取 {value}", { value: runDisplayNameWithId(run) })}
                          title={running ? t("執行中的 run 不能封存或刪除：先取消或等它結束") : undefined}
                        />
                      </Td>
                      <Td className="relative">
                        <Link to={runPath(run.run_id)} className="flex min-w-0 items-baseline gap-2" title={run.run_id}>
                          <span className="min-w-0 truncate" title={name}>
                            {name}
                          </span>
                          {name === runIdName(run.run_id) ? null : <code className="machine shrink-0 text-caption text-fg-tertiary">{run.run_id.slice(0, 8)}</code>}
                        </Link>
                        {/* 執行中：列底一條不確定進度的品牌光帶（實際步驟數在「步驟」欄）。 */}
                        {running ? <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand-gradient-soft animate-shimmer" /> : null}
                      </Td>
                      <Td>
                        <code className="machine block truncate text-fg-secondary" title={run.request.pipeline.pipeline_id}>
                          {run.request.pipeline.pipeline_id}
                        </code>
                      </Td>
                      <Td>
                        <StatusBadge kind="run" value={run.state} />
                      </Td>
                      <Td className="truncate">
                        <TimeText iso={run.created_at} />
                      </Td>
                      <Td className="machine truncate text-fg-secondary"><Elapsed start={run.created_at} end={run.finished_at} running={run.state === "running"} /></Td>
                      <Td className="whitespace-nowrap">
                        <span className="machine inline-flex items-center gap-1.5 text-fg-secondary" title={stepProgressText(progress)}>
                          {running && progress.fraction !== null ? (
                            <CircularProgress value={progress.fraction} size={16} label={stepProgressText(progress)} />
                          ) : null}
                          {progress.succeeded}/{progress.total}
                        </span>
                      </Td>
                      <Td>
                        {run.error ? (
                          <span className="machine block truncate text-danger" title={tServer(run.error.message)}>
                            {run.error.code}
                          </span>
                        ) : (
                          <span className="text-fg-tertiary">—</span>
                        )}
                        {(run.request.origin?.source_run_id != null && run.request.origin.source_run_id !== "") ? (
                          <span className="block truncate text-caption text-fg-tertiary">
                            {t("來源")} <IdText value={run.request.origin.source_run_id} copy={false} />
                          </span>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </div>
    </>
  );

  return (
    <>
      <WorkbenchPage
        storageKey="admin.runs"
        center={center}
        centerLabel={t("run 列表")}
        dockLabel={t("輸出面板")}
        dockTabs={[{ id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog /> }]}
      />
      <RunStateOutliner {...stateFilterProps} />
      <RunDeleteDialog
        runIds={deleting ?? []}
        open={deleting !== null}
        onOpenChange={(open) => { if (!(open)) { setDeleting(null); } }}
        labelOf={labelOf}
        outputKind={runOutputKind(items.filter((run) => Boolean(deleting?.includes(run.run_id))))}
        onDone={(deleted) => { setSelected((previous) => new Set([...previous].filter((id) => !deleted.includes(id)))); }}
      />
    </>
  );
}
