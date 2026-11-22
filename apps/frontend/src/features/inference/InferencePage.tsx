// 推理 Studio・手動執行（/inference/run?pipeline=&run=）：選一個已保存的元件組合，依輸入型別填寫（prompt、上傳媒體、
// ref2va 參考素材、其他型別的 JSON），檢查並啟動需要的元件，送出 POST /api/runs；run 在右側即時顯示狀態與輸出。
// 草稿依 pipeline 保存在記憶體（draftStore）；網址只放選取的元件組合與 run。寫入不自動重送。
import { withOccurrenceKeys } from "@/lib/occurrenceKeys";
import { Activity, ChartGantt, CircleCheck, ExternalLink, FileInput, ListPlus, PencilRuler, Play, Rocket, Type, Workflow } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { componentUsable, useCatalog } from "@/api/catalog";
import type { Catalog, Port } from "@/api/generated/contracts";
import { usePipelines } from "@/api/pipelines";
import { useCreateRun, useRun } from "@/api/runs";
import type { WirePipeline, WireRun, WireTypedValue } from "@/api/types";
import { inferencePath, PATHS, pipelinePath } from "@/app/paths";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { SyntheticNotice } from "@/components/common/SyntheticNotice";
import { IdText } from "@/components/common/values";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/controls";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/variants";
import { DockBody } from "@/components/workbench/DockPanel";
import { DocTabs, type DocTab } from "@/components/workbench/DocTabs";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { ActivityLog } from "@/features/activity";
import { type DescriptorLookup, type GraphSelection, makeLookup, PipelineGraph, validatePipeline } from "@/features/pipelines";
import { RunGantt } from "@/features/runs";
import { hasErrorCode } from "@/lib/errors";
import { runDisplayName } from "@/lib/runName";
import { useNow } from "@/lib/time";
import { cn } from "@/lib/cn";
import { AssetField, GenericField, MediaField, PromptField } from "./components/InputFields";
import { MaterialsBuilder } from "./components/MaterialsBuilder";
import { PipelinePicker } from "./components/PipelinePicker";
import { RequiredComponents } from "./components/RequiredComponents";
import { RunResult } from "./components/RunResult";
import { updateDraft, uploadsInFlight, useDraft, useUploadsInFlight } from "./draftStore";
import { useComponentControl } from "@/features/components";
import { catalogStatus as catalogStatusOf, catalogUnknownText, needsStart, requiredComponents, startTargets, type CatalogStatus } from "./model/components";
import { draftIssues, editorFor, runInputs, submitBlockReason } from "./model/inputs";
import type { MaterialDraft } from "./model/materials";
import { ICON_TILE } from "@/components/ui/look";
import { SubBrandNav } from "@/components/flow/SubBrandNav";
import { t } from "@/i18n";

const EDITOR_HINT: Record<ReturnType<typeof editorFor>, string> = {
  prompt: t("多行文字"),
  media: t("上傳檔案"),
  asset: "Asset",
  materials: t("參考素材"),
  generic: t("JSON／檔案"),
};

function InputRow({ pipelineId, port, value, materials, disabled }: { pipelineId: string; port: Port; value: WireTypedValue | null; materials: readonly MaterialDraft[]; disabled: boolean }) {
  const id = `inference-input-${port.name}`;
  const editor = editorFor(port);
  const setValue = (next: WireTypedValue | null) => { updateDraft(pipelineId, (draft) => ({ ...draft, inputs: { ...draft.inputs, [port.name]: next } })); };
  const updateMaterials = (update: (list: MaterialDraft[]) => MaterialDraft[]) => { updateDraft(pipelineId, (draft) => ({ ...draft, materials: { ...draft.materials, [port.name]: update(draft.materials[port.name] ?? []) } })); };
  return (
    <div className="grid min-w-0 gap-2 border-b border-line-subtle px-4 py-3.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 text-data">
        {editor === "prompt" ? (
          <label id={`${id}-label`} htmlFor={id} className="machine font-semibold text-fg">
            {port.name}
          </label>
        ) : (
          <span id={`${id}-label`} className="machine font-semibold text-fg">
            {port.name}
          </span>
        )}
        <code className="machine rounded-full border border-file/25 bg-file/10 px-1.5 text-caption whitespace-nowrap text-file">{port.type_id}</code>
        <Badge>{port.required ? t("必填") : t("選填")}</Badge>
        <span className="text-caption text-fg-tertiary">{EDITOR_HINT[editor]}</span>
        {port.description ? <span className="min-w-0 text-caption text-fg-secondary">{port.description}</span> : null}
      </div>
      {editor === "prompt" ? (
        <PromptField id={id} port={port} value={value} onChange={setValue} disabled={disabled} />
      ) : (
        <div role="group" aria-labelledby={`${id}-label`} className="min-w-0">
          {editor === "media" ? (
            <MediaField id={id} pipelineId={pipelineId} port={port} value={value} onChange={setValue} disabled={disabled} />
          ) : editor === "asset" ? (
            <AssetField id={id} pipelineId={pipelineId} port={port} value={value} onChange={setValue} disabled={disabled} />
          ) : editor === "materials" ? (
            <MaterialsBuilder id={id} pipelineId={pipelineId} label={t("{name}（h3.materials.v1）", { name: port.name })} materials={materials} update={updateMaterials} disabled={disabled} />
          ) : (
            <GenericField id={id} pipelineId={pipelineId} port={port} value={value} onChange={setValue} disabled={disabled} />
          )}
        </div>
      )}
    </div>
  );
}

/** 表單區段的標題列（捲動時固定在面板頂端）：步驟編號＋圖示磚＋標題＋計數。 */
function SectionHeading({ id, step, icon, title, count, children }: { id: string; step: number; icon: React.ReactNode; title: string; count?: number; children?: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-[2] flex min-h-11 flex-wrap items-center gap-2.5 border-b border-line-subtle bg-surface px-4 py-1.5">
      <span aria-hidden className="machine grid size-5 shrink-0 place-items-center rounded-full border border-line-strong bg-sunken text-[10px] font-semibold text-fg-tertiary">
        {step}
      </span>
      <h2 id={id} className="flex items-center gap-2 text-data font-semibold text-fg">
        <span aria-hidden className={cn(ICON_TILE, "size-6 [&_svg]:size-3.5")}>
          {icon}
        </span>
        {title}
        {count !== undefined ? <span className="machine rounded-full bg-overlay px-1.5 text-caption font-normal text-fg-tertiary">{count}</span> : null}
      </h2>
      {children}
    </div>
  );
}

/** 選定元件組合後的表單：輸入、需要的元件、run 名稱；底部固定送出列。 */
function InferenceForm({
  pipeline,
  catalog,
  catalogStatus,
  activeRunId,
  onCreated,
}: {
  pipeline: WirePipeline;
  catalog: Catalog | undefined;
  /** 目錄還沒讀到或讀取失敗：元件狀態未知（不說未就緒或離線）。 */
  catalogStatus: CatalogStatus;
  /** 右側正在顯示的 run（網址 ?run=）。 */
  activeRunId: string | null;
  onCreated: (runId: string) => void;
}) {
  const draft = useDraft(pipeline.pipeline_id);
  const uploading = useUploadsInFlight(pipeline.pipeline_id);
  const starter = useComponentControl();
  const create = useCreateRun();
  const inFlightRef = useRef(false);
  const lookup = useMemo(() => makeLookup(catalog), [catalog]);
  const required = requiredComponents(pipeline, catalog);
  const wiring = validatePipeline(pipeline, lookup).filter((issue) => issue.severity === "error");
  const problems = draftIssues(pipeline.inputs, draft);
  const unknownCatalog = catalogUnknownText(catalogStatus);
  const notReady = required.filter((item) => item.known && (!item.descriptor || item.nodeStale || !componentUsable(item.descriptor)));
  const testRun = required.some((item) => item.descriptor?.provider_id.startsWith("test.") ?? false);
  const pending = create.isPending;
  const blockReason = pending ? null : submitBlockReason({ wiringErrors: wiring.length, uploading, problems });
  const created = create.data ?? null;

  const submit = () => {
    // 上傳數以 store 的當下值再確認一次（剛選完檔、畫面還沒重繪時也不送出舊值）
    if ((blockReason ?? "") || inFlightRef.current || uploadsInFlight(pipeline.pipeline_id) > 0) return;
    inFlightRef.current = true;
    const label = draft.label.trim();
    create.mutate(
      { pipeline, inputs: runInputs(pipeline.inputs, draft), ...(label ? { label } : {}) },
      {
        onSuccess: (run) => { onCreated(run.run_id); },
        onSettled: () => {
          inFlightRef.current = false;
        },
      },
    );
  };

  return (
    <>
      <DockBody className="relative">
        {testRun ? <SyntheticNotice kind="test" detail={t("此元件組合包含測試元件（test.*）：輸出只驗證流程，不是生成結果。")} className="m-4 mb-0" /> : null}
        {wiring.length > 0 ? (
          <Callout tone="danger" title={t("接線錯誤（伺服器會以 422 拒絕）")} className="m-4 mb-0">
            <ul className="grid gap-1">
              {withOccurrenceKeys(wiring, (issue) => issue.message).map(({ item: issue, key }) => (
                <li key={key}>
                  <span className="machine text-caption text-fg-tertiary">{issue.code}</span> {issue.message}
                </li>
              ))}
            </ul>
            <Link to={pipelinePath(pipeline.pipeline_id)} className="text-data">
              {t("到「元件修改」修正這個元件組合")}
            </Link>
          </Callout>
        ) : null}
        <section aria-labelledby="inference-inputs-title">
          <SectionHeading id="inference-inputs-title" step={1} icon={<FileInput aria-hidden />} title={t("輸入")} count={pipeline.inputs.length} />
          {pipeline.inputs.length === 0 ? (
            <p className="px-4 py-3 text-data text-fg-tertiary">{t("這個元件組合沒有宣告輸入：直接建立 run 即可。")}</p>
          ) : (
            pipeline.inputs.map((port) => (
              <InputRow
                key={port.name}
                pipelineId={pipeline.pipeline_id}
                port={port}
                value={draft.inputs[port.name] ?? null}
                materials={draft.materials[port.name] ?? []}
                disabled={pending}
              />
            ))
          )}
        </section>
        <section aria-labelledby="inference-components-title">
          <SectionHeading id="inference-components-title" step={2} icon={<Rocket aria-hidden />} title={t("需要的元件")} count={required.length} />
          <div className="px-4 py-3">
            <RequiredComponents items={required} phase={starter.phase} failures={starter.failures} onStart={(items) => void starter.run(startTargets(items), "start")} onDismiss={starter.dismiss} catalogStatus={catalogStatus} />
            {starter.dialog}
          </div>
        </section>
        <section aria-labelledby="inference-label-title">
          <SectionHeading id="inference-label-title" step={3} icon={<Type aria-hidden />} title={t("run 名稱（選填）")} />
          <div className="grid gap-1 px-4 py-3">
            <Input
              id="inference-run-label"
              aria-labelledby="inference-label-title"
              compact
              value={draft.label}
              maxLength={200}
              disabled={pending}
              placeholder={pipeline.label || pipeline.pipeline_id}
              onChange={(event) => {
                const label = event.target.value;
                updateDraft(pipeline.pipeline_id, (current) => ({ ...current, label }));
              }}
              className="max-w-xl"
            />
            <p className="text-caption text-fg-tertiary">{t("顯示在執行紀錄與活動中；空白時列表顯示元件組合名稱。")}</p>
          </div>
        </section>
      </DockBody>
      <div className="relative grid shrink-0 gap-2 border-t border-line-subtle bg-surface px-4 py-3 before:pointer-events-none before:absolute before:inset-x-4 before:-top-px before:h-px before:bg-brand-gradient before:opacity-60">
        {create.isError ? (
          <ErrorCallout error={create.error} write title={hasErrorCode(create.error, "RUN_ACTIVE") ? t("已有 run 正在執行：這次沒有送出") : t("建立 run 失敗；輸入內容保留")}>
            {hasErrorCode(create.error, "RUN_ACTIVE") ? (
              <Link to={PATHS.runs} className="text-data">
                {t("查看執行中的 run")}
              </Link>
            ) : null}
          </ErrorCallout>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <ActionButton variant="primary" icon={<Play aria-hidden />} pending={pending} disabledReason={blockReason} onClick={submit}>
            {t("建立 run")}
          </ActionButton>
          <p className="min-w-0 flex-1 text-caption text-fg-tertiary" aria-live="polite">
            {pending ? (
              t("送出中…（不會自動重送）")
            ) : (blockReason != null && blockReason !== "") ? (
              <span className="text-warning">{blockReason}</span>
            ) : (unknownCatalog != null && unknownCatalog !== "") ? (
              <span className={catalogStatus === "error" ? "text-warning" : undefined}>{t("{unknownCatalog}：還不能確認需要的元件是否就緒（不會自動啟動或重試）", { unknownCatalog })}</span>
            ) : notReady.length > 0 ? (
              <span className="text-warning">
                {notReady.some(needsStart)
                  ? t("{notReadyCount} 個元件未就緒：run 會在該步驟失敗（不會自動啟動或重試）；可先按上方「啟動全部需要的元件」", { notReadyCount: notReady.length })
                  : t("{notReadyCount} 個元件未就緒：run 會在該步驟失敗（不會自動啟動或重試）", { notReadyCount: notReady.length })}
              </span>
            ) : (
              t("可以送出：送出時凍結這次的接線與輸入，重新執行就是新的 run。")
            )}
          </p>
        </div>
        {created ? (
          <p key={created.run_id} className="flex flex-wrap items-center gap-1.5 text-caption text-fg-secondary animate-rise-in">
            <CircleCheck aria-hidden className="size-3.5 text-success animate-pop-in" />
            <span>{t("上一次送出的 run：")}</span>
            <IdText value={created.run_id} copy={false} />
            {created.run_id === activeRunId ? (
              <span>{t("（狀態與輸出在右側）")}</span>
            ) : (
              <Link to={inferencePath({ pipeline: pipeline.pipeline_id, run: created.run_id })}>{t("在右側顯示")}</Link>
            )}
          </p>
        ) : null}
      </div>
    </>
  );
}

function GraphDock({
  pipeline,
  lookup,
  run,
  selection,
  onSelect,
  catalog,
}: {
  pipeline: WirePipeline | null;
  lookup: DescriptorLookup;
  run: WireRun | undefined;
  selection: GraphSelection | null;
  onSelect: (next: GraphSelection | null) => void;
  catalog: Catalog | undefined;
}) {
  const shown = run?.request.pipeline ?? pipeline;
  if (!shown) return <EmptyState icon={<Workflow />} size="compact" title={t("還沒有選元件組合")} description={t("選一個元件組合後，這裡顯示它的節點圖；建立 run 後節點會帶步驟狀態。")} />;
  return (
    <div className="relative min-h-0 flex-1">
      <PipelineGraph
        pipeline={shown}
        lookup={lookup}
        run={run ?? null}
        label={run ? t("run「{value}」的節點圖", { value: runDisplayName(run) }) : t("元件組合「{value}」的節點圖", { value: shown.label || shown.pipeline_id })}
        selection={selection}
        onSelect={onSelect}
        nodeLabel={(nodeId) => catalog?.directory.find((entry) => entry.node_id === nodeId)?.label ?? null}
        className="absolute inset-0"
      />
    </div>
  );
}

function GanttDock({
  run,
  lookup,
  selection,
  onSelect,
  catalog,
}: {
  run: WireRun | undefined;
  lookup: DescriptorLookup;
  selection: GraphSelection | null;
  onSelect: (next: GraphSelection | null) => void;
  catalog: Catalog | undefined;
}) {
  // 時鐘只在這個分頁、run 進行中時走（不讓整頁每秒重繪）。
  const now = useNow(run?.state === "running");
  if (!run) return <EmptyState icon={<ChartGantt />} size="compact" title={t("還沒有 run")} description={t("建立或選擇一個 run 後，這裡依資源群組顯示各步驟的實測時間。")} />;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <RunGantt
        run={run}
        lookup={lookup}
        selectedStepId={selection?.kind === "step" ? selection.id : null}
        onSelectStep={(stepId) => { onSelect((stepId != null && stepId !== "") ? { kind: "step", id: stepId } : null); }}
        now={now ?? 0}
        nodeLabel={(nodeId) => catalog?.directory.find((entry) => entry.node_id === nodeId)?.label ?? null}
      />
    </div>
  );
}

export function InferencePage() {
  const [params, setParams] = useSearchParams();
  const pipelineId = params.get("pipeline");
  const runId = params.get("run");
  const pipelines = usePipelines();
  const catalog = useCatalog();
  const lookup = useMemo(() => makeLookup(catalog.data), [catalog.data]);
  const run = useRun(runId);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const items = pipelines.data?.items ?? [];
  const pipeline = (pipelineId != null && pipelineId !== "") ? (items.find((item) => item.pipeline_id === pipelineId) ?? null) : null;

  const setRun = (runToShow: string | null) => { setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (runToShow != null && runToShow !== "") next.set("run", runToShow);
      else next.delete("run");
      return next;
    }); };

  const docTabs: DocTab[] = [{ id: "list", label: t("手動執行"), icon: Play, to: PATHS.inferenceRun, active: !(pipelineId != null && pipelineId !== ""), title: t("已保存的元件組合") }];
  if (pipelineId != null && pipelineId !== "") {
    docTabs.push({
      id: pipelineId,
      label: (pipeline?.label ?? "") || pipelineId,
      icon: Workflow,
      iconTone: "action",
      to: inferencePath({ pipeline: pipelineId, run: runId }),
      active: true,
      title: t("{value}（{pipelineId}）", { value: (pipeline?.label ?? "") || pipelineId, pipelineId }),
      closeTo: PATHS.inferenceRun,
    });
  }

  let body: React.ReactNode;
  if (pipelines.isPending) {
    body = (
      <div role="status" className="grid gap-2 px-4 py-5">
        <span className="sr-only">{t("讀取元件組合…")}</span>
        <Skeleton className="h-9" />
        <Skeleton className="h-9 opacity-75" />
        <Skeleton className="h-9 opacity-50" />
      </div>
    );
  } else if (pipelines.isError && !pipelines.data) {
    body = (
      <div className="p-4">
        <ErrorCallout error={pipelines.error} title={t("無法讀取元件組合列表")} onRetry={() => void pipelines.refetch()} retrying={pipelines.isFetching} />
      </div>
    );
  } else if (!(pipelineId != null && pipelineId !== "")) {
    body = (
      <DockBody className="relative">
        <PipelinePicker pipelines={items} catalog={catalog.data} catalogStatus={catalogStatusOf(catalog)} />
      </DockBody>
    );
  } else if (!pipeline) {
    body = (
      <EmptyState
        illustration="offline"
        title={t("找不到這個元件組合")}
        description={t("{pipelineId} 不存在或已被刪除；已建立的 run 保有自己的流程副本，仍可在執行紀錄查看。", { pipelineId })}
        action={
          <Link to={PATHS.inferenceRun} className={buttonVariants({ variant: "secondary" })}>
            {t("回到元件組合列表")}
          </Link>
        }
      />
    );
  } else {
    body = (
      <InferenceForm key={pipeline.pipeline_id} pipeline={pipeline} catalog={catalog.data} catalogStatus={catalogStatusOf(catalog)} activeRunId={runId} onCreated={(created) => { setRun(created); }} />
    );
  }

  const center = (
    <>
      <SubBrandNav current="run" />
      <DocTabs label={t("開啟的文件")} tabs={docTabs} />
      <PageHeader
        icon={<Play />}
        title={pipeline ? pipeline.label || pipeline.pipeline_id : t("手動執行")}
        description={pipeline ? t("填寫輸入、確認需要的元件，再建立 run；結果在右側即時更新。") : t("選一個已保存的元件組合，上傳輸入後執行；結果在右側即時更新。")}
        meta={
          pipeline ? (
            <>
              <IdText value={pipeline.pipeline_id} length={40} />
              <span className="text-caption text-fg-tertiary">{t("{stepsCount} 個步驟 · {inputsCount} 個輸入", { stepsCount: pipeline.steps.length, inputsCount: pipeline.inputs.length })}</span>
            </>
          ) : null
        }
        className="shrink-0 border-b border-line-subtle px-4 py-3"
        actions={
          pipeline ? (
            <>
              <Link to={pipelinePath(pipeline.pipeline_id)} className={buttonVariants({ variant: "quiet", size: "sm" })}>
                <PencilRuler aria-hidden />
                {t("編輯元件組合")}
              </Link>
              <Link to={`${PATHS.runs}?q=${encodeURIComponent(pipeline.pipeline_id)}`} className={buttonVariants({ variant: "quiet", size: "sm" })}>
                <ExternalLink aria-hidden />
                {t("這個元件組合的執行紀錄")}
              </Link>
            </>
          ) : (
            <Link to={PATHS.newPipeline} className={buttonVariants({ variant: "quiet", size: "sm" })}>
              <ListPlus aria-hidden />
              {t("新增元件組合")}
            </Link>
          )
        }
      />
      {body}
    </>
  );

  return (
    <WorkbenchPage
      storageKey="inference"
      centerLabel={t("手動執行")}
      center={center}
      inspector={<RunResult runId={runId} pipelineId={pipelineId} lookup={lookup} onSelectRun={setRun} />}
      inspectorLabel={t("執行結果")}
      dockLabel={t("輸出面板")}
      dockTabs={[
        {
          id: "graph",
          label: t("節點圖"),
          icon: Workflow,
          render: () => <GraphDock pipeline={pipeline} lookup={lookup} run={run.data} selection={selection} onSelect={setSelection} catalog={catalog.data} />,
        },
        {
          id: "gantt",
          label: t("步驟時間軸"),
          icon: ChartGantt,
          render: () => <GanttDock run={run.data} lookup={lookup} selection={selection} onSelect={setSelection} catalog={catalog.data} />,
        },
        { id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog /> },
      ]}
    />
  );
}
