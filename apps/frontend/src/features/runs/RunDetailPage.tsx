import { Activity, Archive, ArchiveRestore, Ban, ChartGantt, ExternalLink, GitCompareArrows, ListVideo, LoaderCircle, RotateCcw, SearchX, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { nodeLabel, useCatalog } from "@/api/catalog";
import type { Asset } from "@/api/generated/contracts";
import { useArchiveRun, useRun } from "@/api/runs";
import { asTypedValueMap, runSteps, type WireRun } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { AssetPlayer } from "@/components/common/AssetPlayer";
import { CancelRunDialog } from "@/components/common/CancelRunDialog";
import { pageFocusTarget } from "@/components/common/routeFocus";
import { CircularProgress } from "@/components/common/CircularProgress";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { GeneratingFrame } from "@/components/common/GeneratingFrame";
import { JsonView } from "@/components/common/JsonView";
import { NativeRunRecipePanel } from "@/features/inference-presets";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SyntheticNotice } from "@/components/common/SyntheticNotice";
import { IdText, TimeText } from "@/components/common/values";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { returnFocusOr } from "@/components/ui/focusReturn";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/variants";
import { DocTabs } from "@/components/workbench/DocTabs";
import { DockBody } from "@/components/workbench/DockPanel";
import { providerKind } from "@/components/workbench/kinds";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { TEXT_TONE } from "@/components/workbench/tones";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { cn } from "@/lib/cn";
import { hasErrorCode } from "@/lib/errors";
import { runDisplayName } from "@/lib/runName";
import { useNow } from "@/lib/time";
import { ActivityLog } from "@/features/activity";
import { makeLookup, PipelineGraph, RunFormDialog, type RunFormSeed, wiringEdges, WiringSummary } from "@/features/pipelines";
import { useRunRecordingIndex } from "@/features/recordings";
import { Elapsed } from "./Elapsed";
import { RunGantt } from "./gantt/RunGantt";
import type { RunGanttProps } from "./gantt/ganttModel";
import { NodeHistoryPanel } from "./NodeHistoryPanel";
import { RunDeleteDialog } from "./RunDeleteDialog";
import { RunFacts, StepInspector } from "./RunInspector";
import { findAsset, runAssets, runErrorTitle, runOutputKind, runValues, stepProgress, stepProgressText, stepsMissingRecording } from "./runModel";
import { RunStepsOutliner } from "./RunStepsOutliner";
import { SourceBadge, TypedValueView } from "./TypedValueView";
import { comparisonPath, PATHS, recordingsPath, runPath } from "@/app/paths";
import { tServer, t } from "@/i18n";
import { T } from "@/i18n/T";

/** What an interrupted run leaves behind (shown with its error, or alone when the run carries none). */
const interruptedNote = () => t("沒有恢復功能：已完成的輸出仍可用，需要時以相同設定建立新 run。主控沒收到的紀錄可在「Node 本機紀錄」補抓。");

type ViewId = "overview" | "steps" | "outputs" | "request" | "recipe";
const VIEWS: readonly { id: ViewId; label: string }[] = [
  { id: "overview", label: t("總覽") },
  { id: "steps", label: t("步驟") },
  { id: "outputs", label: t("輸出") },
  { id: "request", label: t("請求") },
  { id: "recipe", label: t("推論配方") },
];

function ComparePair({ preview, final, previewRunId }: { preview: Asset; final: Asset; previewRunId: string }) {
  return (
    <section className="panel grid gap-3 p-4" aria-label={t("草稿與正式版對照")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-section font-semibold text-fg">
          <GitCompareArrows aria-hidden className="size-4 text-fg-tertiary" />
          {t("草稿 vs 正式版")}
        </h3>
        <SourceBadge a={preview} b={final} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid gap-1">
          <AssetPlayer file={preview.file} label="preview" title={t("草稿 asset {asset_id}（run {previewRunId}）", { asset_id: preview.asset_id.slice(0, 8), previewRunId: previewRunId.slice(0, 8) })} width={preview.width} height={preview.height} />
        </div>
        <div className="grid gap-1">
          <AssetPlayer file={final.file} label="final" title={t("正式 asset {asset_id}", { asset_id: final.asset_id.slice(0, 8) })} width={final.width} height={final.height} />
        </div>
      </div>
      <p className="text-caption text-fg-tertiary">{t("兩路保持來源時間軸、contain 不裁畫面。畫質是否可接受由你判斷，沒有自動品質門檻。")}</p>
    </section>
  );
}

/** 來自草稿的正式解碼 run：載入來源 run，把指定的草稿 asset 與本 run 的正式 asset 並排。 */
function OriginComparison({ run }: { run: WireRun }) {
  const origin = run.request.origin;
  const sourceRun = useRun(origin?.source_run_id ?? null);
  if (!(origin?.source_run_id != null && origin.source_run_id !== "") || !(origin.preview_asset_id != null && origin.preview_asset_id !== "")) return null;
  const finals = runAssets(run).filter((asset) => asset.kind === "final");
  if (sourceRun.isPending) return <p className="text-caption text-fg-tertiary">{t("讀取來源 run 以對照草稿…")}</p>;
  if (sourceRun.isError) return <ErrorCallout error={sourceRun.error} title={t("無法讀取來源 run（無法並排草稿）")} />;
  const preview = findAsset(sourceRun.data, origin.preview_asset_id);
  if (!preview) return <p className="text-caption text-warning">{t("來源 run 中找不到草稿 asset {preview_asset_id}。", { preview_asset_id: origin.preview_asset_id.slice(0, 8) })}</p>;
  if (finals.length === 0) return <p className="text-caption text-fg-tertiary">{t("本 run 尚無正式 asset 可與草稿對照。")}</p>;
  return (
    <>
      {finals.map((final) => (
        <ComparePair key={final.asset_id} preview={preview} final={final} previewRunId={origin.source_run_id ?? ""} />
      ))}
    </>
  );
}

function RunDetail({ run }: { run: WireRun }) {
  const catalog = useCatalog();
  const lookup = useMemo(() => makeLookup(catalog.data), [catalog.data]);
  // The Cancel button that asked (non-null while confirming); it leaves with the running state
  const [cancelOpener, setCancelOpener] = useState<HTMLElement | null>(null);
  const archive = useArchiveRun();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [rerun, setRerun] = useState<RunFormSeed | null>(null);
  const [params, setParams] = useSearchParams();
  const running = run.state === "running";
  const steps = runSteps(run);
  const progress = stepProgress(steps);
  const outputs = Object.entries(asTypedValueMap(run.outputs));
  const values = runValues(run);
  const assets = runAssets(run);
  const previews = assets.filter((asset) => asset.kind === "preview");
  const finals = assets.filter((asset) => asset.kind === "final");
  const testRun = run.request.pipeline.steps.some((step) => lookup(step.node_id, step.component_id)?.provider_id.startsWith("test.") ?? false);
  const title = runDisplayName(run);
  const requestedView = params.get("view");
  const view: ViewId = VIEWS.find((item) => item.id === requestedView)?.id ?? "overview";
  const selectedStep = steps.find((step) => step.step_id === params.get("step")) ?? null;
  // What the Controller index holds for this run (deleting a recording keeps its id in the run): unknown until read
  const index = useRunRecordingIndex(run.run_id, !running && (run.recording_ids.length > 0 || steps.some((step) => step.recording_id !== null)));
  const indexed = index.data ?? null;
  const missing = running ? [] : stepsMissingRecording(steps, indexed);
  // The Nodes asked about stay listed after backfills fill every gap, so their results stay on the page (per run)
  const [history, setHistory] = useState<{ runId: string; nodeIds: readonly string[] } | null>(null);
  const historyNodes = history?.runId === run.run_id ? history.nodeIds : null;
  const showHistory = !running && (missing.length > 0 || historyNodes !== null);
  const comparable = indexed ? run.recording_ids.filter((id) => indexed.has(id)) : run.recording_ids;
  const setParam = (key: string, value: string | null) => { setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value != null && value !== "") next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    ); };
  const selectStep = (stepId: string | null) => { setParam("step", stepId); };

  const notices =
    testRun || run.state === "interrupted" || run.error || showHistory || archive.isError ? (
      <div className="grid gap-2 border-b border-line-subtle p-3">
        {archive.isError ? <ErrorCallout error={archive.error} write title={t("封存狀態沒有變更")} /> : null}
        {testRun ? <SyntheticNotice kind="test" detail={t("此 run 使用測試元件（test.*）：輸出只驗證流程，不是生成結果，也不代表 GPU 效能。")} /> : null}
        {/* One box for how the run ended, named after its state; an interrupted run's box also says what that means */}
        {run.error ? (
          <ErrorCallout error={run.error} title={runErrorTitle(run)}>
            {run.state === "interrupted" ? <p>{interruptedNote()}</p> : null}
          </ErrorCallout>
        ) : run.state === "interrupted" ? (
          <Callout tone="warning" title={t("run 已中斷（Controller 曾重新啟動）")}>
            <p>{interruptedNote()}</p>
          </Callout>
        ) : null}
        {showHistory ? (
          <NodeHistoryPanel
            run={run}
            missing={missing}
            indexed={indexed}
            requestedNodes={historyNodes}
            onRequest={(nodeIds) => { setHistory({ runId: run.run_id, nodeIds }); }}
            labelOf={(nodeId) => nodeLabel(catalog.data, nodeId)}
          />
        ) : null}
      </div>
    ) : null;

  const stepsView = (
    <TableScroll label={t("步驟清單")}>
      <Table className="min-w-[60rem] table-fixed [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]">
        <colgroup>
          <col />
          <col className="w-40" />
          <col className="w-44" />
          <col className="w-28" />
          <col className="w-46" />
          <col className="w-24" />
          <col className="w-40" />
        </colgroup>
        <thead>
          <tr>
            <Th scope="col">{t("步驟")}</Th>
            <Th scope="col">{t("元件")}</Th>
            <Th scope="col">Node</Th>
            <Th scope="col">{t("狀態")}</Th>
            <Th scope="col">{t("開始")}</Th>
            <Th scope="col">{t("耗時")}</Th>
            <Th scope="col">{t("錯誤")}</Th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => {
            const kind = providerKind((step.node_id != null && step.node_id !== "") && (step.component_id != null && step.component_id !== "") ? lookup(step.node_id, step.component_id)?.provider_id : null);
            const selected = step.step_id === selectedStep?.step_id;
            return (
              <Tr key={step.step_id} selected={selected} className="cursor-pointer [&>td]:align-middle" onClick={() => { selectStep(step.step_id); }}>
                <Td className="py-1">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectStep(step.step_id);
                    }}
                    className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left"
                  >
                    <kind.icon aria-hidden className={cn("size-4 shrink-0", TEXT_TONE[kind.tone])} />
                    <code className="machine truncate text-fg" title={step.step_id}>
                      {step.step_id}
                    </code>
                  </button>
                </Td>
                <Td>
                  <code className="machine block truncate text-fg-secondary" title={step.component_id ?? undefined}>
                    {step.component_id ?? "—"}
                  </code>
                </Td>
                <Td className="truncate text-fg-secondary" title={nodeLabel(catalog.data, step.node_id)}>
                  {nodeLabel(catalog.data, step.node_id)}
                </Td>
                <Td>
                  <StatusBadge kind="step" value={step.state} />
                </Td>
                <Td className="truncate">
                  <TimeText iso={step.started_at} />
                </Td>
                <Td className="machine truncate text-fg-secondary">
                  <Elapsed start={step.started_at} end={step.finished_at} running={step.state === "running"} />
                </Td>
                <Td>
                  {step.error ? (
                    <span className="machine block truncate text-danger" title={tServer(step.error.message)}>
                      {step.error.code}
                    </span>
                  ) : (
                    <span className="text-fg-tertiary">—</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroll>
  );

  const outputsView = (
    <div className="grid gap-4 p-4">
      <section className="grid gap-3" aria-labelledby="run-outputs-title">
        <h2 id="run-outputs-title" className="text-section font-semibold text-fg">
          {t("run 輸出（{outputsCount}）", { outputsCount: outputs.length })}
        </h2>
        {outputs.length === 0 && running ? (
          // 生成中只畫外框與狀態文字，不放任何假的輸出或預覽。
          <GeneratingFrame active className="grid min-h-32 place-items-center bg-sunken px-4 py-6">
            <p role="status" className="flex items-center gap-2 text-data text-fg-secondary">
              <LoaderCircle aria-hidden className="size-4 shrink-0 text-info animate-spin" />
              {t("執行中：輸出完成後顯示在這裡。")}
            </p>
          </GeneratingFrame>
        ) : outputs.length === 0 ? (
          <p className="text-data text-fg-tertiary">{t("此 run 沒有 pipeline 層級的輸出；各步驟輸出在步驟的檢視器。")}</p>
        ) : (
          outputs.map(([name, value]) => <TypedValueView key={name} name={name} value={value} run={run} usage="output" />)
        )}
      </section>
      {previews.length > 0 && finals.length > 0 ? (
        <section className="grid gap-3" aria-label={t("本 run 的草稿與正式版")}>
          {previews.flatMap((preview) => finals.map((final) => <ComparePair key={`${preview.asset_id}-${final.asset_id}`} preview={preview} final={final} previewRunId={run.run_id} />))}
        </section>
      ) : null}
      <OriginComparison run={run} />
      {values.length === 0 && !running ? <Badge>{t("此 run 沒有任何輸出")}</Badge> : null}
    </div>
  );

  const requestView = (
    <div className="grid gap-4 p-4">
      <div className="grid gap-2">
        <h2 className="text-section font-semibold text-fg">{t("輸入")}</h2>
        {Object.entries(asTypedValueMap(run.request.inputs)).map(([name, value]) => (
          <TypedValueView key={name} name={name} value={value} run={run} usage="input" />
        ))}
        {Object.keys(run.request.inputs).length === 0 ? <p className="text-data text-fg-tertiary">{t("沒有輸入。")}</p> : null}
      </div>
      <WiringSummary edges={wiringEdges(run.request.pipeline, lookup)} />
      <div className="grid gap-2">
        <h2 className="text-section font-semibold text-fg">{t("完整請求 JSON")}</h2>
        <JsonView value={run.request} label="RunRequest" fileName={`run-${run.run_id.slice(0, 8)}-request.json`} maxHeightClass="max-h-[32rem]" />
      </div>
    </div>
  );

  const center = (
    <>
      <DocTabs
        label={t("開啟的文件")}
        tabs={[
          { id: "runs", label: t("執行紀錄"), icon: ListVideo, to: PATHS.runs, active: false },
          { id: run.run_id, label: title, icon: ListVideo, iconTone: "action", to: runPath(run.run_id), active: true, title: t("{title}（{run_id}）", { title, run_id: run.run_id }), closeTo: PATHS.runs },
        ]}
      />
      <PageHeader
        icon={<ListVideo />}
        title={title}
        className="shrink-0 border-b border-line-subtle px-4 py-3"
        meta={
          <>
            <StatusBadge kind="run" value={run.state} />
            {progress.fraction !== null ? (
              <span className="inline-flex items-center gap-1.5 text-caption text-fg-secondary">
                {running ? <CircularProgress value={progress.fraction} size={18} label={t("run 的步驟進度")} /> : null}
                <span className="machine">{stepProgressText(progress)}</span>
              </span>
            ) : null}
            {(run.archived_at != null && run.archived_at !== "") ? (
              <span className="inline-flex items-center gap-1 rounded-sm border border-line bg-raised px-1.5 text-caption text-fg-secondary" title={t("封存於 {archived_at}", { archived_at: run.archived_at })}>
                <Archive aria-hidden className="size-3" />
                {t("已封存")}
              </span>
            ) : null}
            <IdText value={run.run_id} length={12} />
            <span className="text-caption text-fg-tertiary">
              <T source={"建立 <0/> · 耗時 {elapsedMs}{value}"} values={{ elapsedMs: <Elapsed start={run.created_at} end={run.finished_at} running={running} />, value: running ? t(" · 每 2 秒自動更新") : "" }} slots={[<TimeText key="slot-0" iso={run.created_at} />]} />
            </span>
          </>
        }
        actions={
          <>
            {running ? (
              <ActionButton size="sm" variant="danger" icon={<Ban aria-hidden />} onClick={(event) => { setCancelOpener(event.currentTarget); }} title={t("中止進行中的步驟（只結束這個 run 呼叫的元件程序）；不會自動重跑")}>
                {t("取消 run…")}
              </ActionButton>
            ) : null}
            <ActionButton
              size="sm"
              icon={<RotateCcw aria-hidden />}
              onClick={() => { setRerun({
                  pipeline: run.request.pipeline,
                  inputs: asTypedValueMap(run.request.inputs),
                  ...(run.state === "succeeded" ? { measuredRunId: run.run_id } : {}),
                  ...(run.request.label === undefined ? {} : { label: run.request.label }),
                  ...(run.request.origin === undefined ? {} : { origin: run.request.origin }),
                  title: t("以相同設定建立新 run"),
                }); }
              }
            >
              {t("以相同設定建立新 run")}
            </ActionButton>
            <Link to={recordingsPath({ run_id: run.run_id })} className={buttonVariants({ variant: "quiet", size: "sm" })}>
              <ExternalLink aria-hidden />
              {t("此 run 的紀錄")}
            </Link>
            {comparable.length >= 2 ? (
              <Link to={comparisonPath(comparable.slice(0, 8))} className={buttonVariants({ variant: "quiet", size: "sm" })}>
                <GitCompareArrows aria-hidden />
                {t("比較紀錄（{min}）", { min: Math.min(comparable.length, 8) })}
              </Link>
            ) : null}
            <ActionButton
              size="sm"
              variant="quiet"
              icon={(run.archived_at != null && run.archived_at !== "") ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
              pending={archive.isPending}
              disabledReason={running ? t("執行中的 run 不能封存") : null}
              onClick={() => { archive.mutate({ runId: run.run_id, archived: !(run.archived_at != null && run.archived_at !== "") }); }}
              title={(run.archived_at != null && run.archived_at !== "") ? t("取消封存：回到一般清單") : t("封存：從一般清單隱藏，檔案與紀錄都保留")}
            >
              {(run.archived_at != null && run.archived_at !== "") ? t("取消封存") : t("封存")}
            </ActionButton>
            <ActionButton
              size="sm"
              variant="danger"
              icon={<Trash2 aria-hidden />}
              disabledReason={running ? t("執行中的 run 不能刪除：先取消或等它結束") : null}
              onClick={() => { setDeleteOpen(true); }}
            >
              {t("永久刪除")}
            </ActionButton>
          </>
        }
      />
      {running && progress.fraction !== null ? (
        // 執行中：頁首下緣的實測進度線（成功步驟／全部步驟），以品牌漸層填色並掃過 shimmer；數字在頁首。
        <div aria-hidden className="relative h-0.5 shrink-0 overflow-hidden bg-line-subtle">
          <span
            className="absolute inset-y-0 left-0 rounded-r-full bg-brand-gradient transition-[width] duration-(--duration-slow) ease-linear animate-shimmer"
            style={{ width: `${String(Math.max(progress.fraction, 0.02) * 100)}%` }}
          />
        </div>
      ) : null}
      <PanelTabs
        tabs={VIEWS.map((item) => ({ ...item, count: item.id === "steps" ? steps.length : item.id === "outputs" ? outputs.length : null }))}
        value={view}
        onChange={(id) => { setParam("view", id === "overview" ? null : id); }}
        idPrefix="run-view"
        label={t("run 檢視")}
        variant="underline"
      />
      {view === "overview" ? (
        <div role="tabpanel" id="run-view-panel-overview" aria-labelledby="run-view-tab-overview" className="flex min-h-0 flex-1 flex-col">
          {notices ? <div className="max-h-[40%] shrink-0 overflow-auto">{notices}</div> : null}
          {/* 畫布自己處理滾輪（平移／縮放），放在固定高度的區塊，不放進會捲動的容器 */}
          <div className="relative min-h-64 flex-[3]">
            <PipelineGraph
              pipeline={run.request.pipeline}
              lookup={lookup}
              run={run}
              label={t("run「{title}」的節點圖", { title })}
              selection={selectedStep ? { kind: "step", id: selectedStep.step_id } : null}
              onSelect={(next) => { selectStep(next?.kind === "step" ? next.id : null); }}
              nodeLabel={(nodeId) => catalog.data?.directory.find((entry) => entry.node_id === nodeId)?.label ?? null}
              className="absolute inset-0"
            />
          </div>
          <section aria-labelledby="run-gantt-title" className="flex min-h-0 flex-[2] flex-col border-t border-line-subtle">
            <div className="flex h-8 shrink-0 items-center gap-2 px-3">
              <ChartGantt aria-hidden className="size-4 text-fg-tertiary" />
              <h2 id="run-gantt-title" className="text-data font-semibold text-fg">
                {t("步驟時間軸")}
              </h2>
              <span className="text-caption text-fg-tertiary">{t("依資源群組分軌，只畫有實測開始時間的步驟")}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <LiveRunGantt
                running={running}
                run={run}
                lookup={lookup}
                selectedStepId={selectedStep?.step_id ?? null}
                onSelectStep={(stepId) => { selectStep(stepId); }}
                nodeLabel={(nodeId) => catalog.data?.directory.find((entry) => entry.node_id === nodeId)?.label ?? null}
              />
            </div>
          </section>
        </div>
      ) : (
        <DockBody role="tabpanel" id={`run-view-panel-${view}`} aria-labelledby={`run-view-tab-${view}`}>
          {notices}
          {view === "recipe" ? <NativeRunRecipePanel runId={run.run_id} running={running} /> : view === "steps" ? stepsView : view === "outputs" ? outputsView : requestView}
        </DockBody>
      )}
      <RunFormDialog seed={rerun} onOpenChange={(open) => { if (!(open)) { setRerun(null); } }} />
      {/* Mounted only while confirming, so every confirmation starts fresh (the same dialog as the top bar). It stays
          with its answer when the run ends; focus then goes to the page title, the Cancel button having left. */}
      {cancelOpener ? (
        <CancelRunDialog
          run={run}
          open
          onOpenChange={(open) => { if (!(open)) { setCancelOpener(null); } }}
          onCloseAutoFocus={(event) => { returnFocusOr(event, cancelOpener, pageFocusTarget()); }}
        />
      ) : null}
      <RunDeleteDialog
        runIds={[run.run_id]}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        labelOf={() => title}
        outputKind={runOutputKind([run])}
        onDone={(deleted) => {
          if (deleted.includes(run.run_id)) void navigate(PATHS.runs, { replace: true });
        }}
      />
    </>
  );

  const inspector = selectedStep ? (
    <StepInspector key={selectedStep.step_id} step={selectedStep} run={run} nodeLabel={nodeLabel(catalog.data, selectedStep.node_id)} lookup={lookup} />
  ) : (
    <RunFacts run={run} title={title} />
  );

  return (
    <>
      <WorkbenchPage
        storageKey="admin.run"
        center={center}
        centerLabel={t("run 明細")}
        inspector={inspector}
        inspectorLabel={t("步驟檢視器")}
        dockLabel={t("輸出面板")}
        dockTabs={[{ id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog runId={run.run_id} /> }]}
      />
      <RunStepsOutliner steps={steps} lookup={lookup} selectedStepId={selectedStep?.step_id ?? null} onSelect={(stepId) => { selectStep(stepId); }} />
    </>
  );
}

function RunMessage({ children }: { children: React.ReactNode }) {
  return (
    <WorkbenchPage
      storageKey="admin.run"
      centerLabel={t("run 明細")}
      center={
        <>
          <DocTabs label={t("開啟的文件")} tabs={[{ id: "runs", label: t("執行紀錄"), icon: ListVideo, to: PATHS.runs, active: false }]} />
          <PageHeader icon={<ListVideo />} title={t("run 明細")} className="shrink-0 border-b border-line-subtle px-4 py-3" />
          <DockBody className="p-4">{children}</DockBody>
        </>
      }
    />
  );
}

/** run 明細：凍結的請求、每步狀態／時間／call／紀錄／完整錯誤、輸出與草稿→正式動作；沒有恢復按鈕。 */
export function RunDetailPage() {
  const { runId } = useParams();
  const query = useRun(runId ?? null);
  if (query.isPending) {
    return (
      <RunMessage>
        <div role="status" className="grid gap-3">
          <p className="text-body text-fg-secondary"><T source={"讀取 run {runId}…"} values={{ runId }} /></p>
          <div aria-hidden className="skeleton h-48 animate-shimmer" />
          <div aria-hidden className="skeleton h-8 animate-shimmer" />
          <div aria-hidden className="skeleton h-8 w-2/3 animate-shimmer" />
        </div>
      </RunMessage>
    );
  }
  if (query.isError) {
    return (
      <RunMessage>
        {hasErrorCode(query.error, "NOT_FOUND") ? (
          <EmptyState
            icon={<SearchX />}
            title={t("找不到這個 run")}
            description={
              <T source={"<0>{runId}</0> 不存在或已被清理。"} values={{ runId }} slots={[<code key="slot-0" className="machine" />]} />
            }
          />
        ) : (
          <ErrorCallout error={query.error} title={t("無法讀取 run")} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        )}
      </RunMessage>
    );
  }
  return <RunDetail run={query.data} />;
}

/** The step timeline with its own clock: while the run is running only the chart redraws every second, not the page. */
function LiveRunGantt({ running, ...props }: Omit<RunGanttProps, "now"> & { running: boolean }) {
  const now = useNow(running);
  return <RunGantt {...props} now={now ?? 0} />;
}
