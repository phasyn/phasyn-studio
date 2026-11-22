import { hasSlotContent } from "@/lib/dom";
import { matchesReply } from "@/api/http";
import { wireDefinitions } from "@/lib/contractSchemas";
import { Activity, CircleAlert, CopyPlus, Play, Plus, Save, Trash2, Undo2, Workflow } from "lucide-react";
import { use, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker, useNavigate } from "react-router";
import { useCatalog, useProviderIndex } from "@/api/catalog";
import { useSavePipeline } from "@/api/pipelines";
import type { WirePipeline } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { CommitInput } from "@/components/common/CommitInput";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { JsonEditor } from "@/components/common/JsonEditor";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFlipList } from "@/components/ui/motion";
import { DocTabs, type DocTab } from "@/components/workbench/DocTabs";
import { DockBody } from "@/components/workbench/DockPanel";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { StatusChip } from "@/components/workbench/StatusChip";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { localIdError, uniqueName } from "@/lib/ids";
import { cloneJson } from "@/lib/json";
import { ActivityLog } from "@/features/activity";
import { componentOptions, makeLookup } from "./catalogIndex";
import { PipelineGraph } from "./graph/PipelineGraph";
import { DeletePipelineDialog, LeaveDraftDialog, SaveWithErrorsDialog, type ListLeaveState } from "./PipelineEditorDialogs";
import { PipelineInspector, type StepBinding } from "./PipelineInspector";
import { PipelineInputsEditor, PipelineOutputsEditor, WiringSummary } from "./PipelineIOEditors";
import { exportsOfStep, validatePipeline, wiringEdges } from "./pipelineModel";
import { IssuesPanel, PipelineOutline } from "./PipelinePanels";
import { RunFormDialog, type RunFormSeed } from "./RunFormDialog";
import { StepEditor } from "./StepEditor";
import { useEditorView, VIEWS } from "./useEditorView";
import { usePipelineDraft } from "./usePipelineDraft";
import { t } from "@/i18n";

/**
 * 元件組合編輯器（工作台）：中間＝節點圖／步驟與接線／JSON，右側 Inspector＝選取的步驟（可直接編輯、換 instance）、
 * 流程輸入、流程輸出（標在接點上的徽章）或元件組合屬性，左下＝大綱，底部＝接線問題。
 * 儲存前／執行前先做前端檢查，伺服器 422 為準。草稿只存在此頁；離開前若未儲存會確認。
 */
export function PipelineEditor({
  initial,
  isNew,
  existingIds,
  tabs,
  notice,
}: {
  initial: WirePipeline;
  isNew: boolean;
  existingIds: ReadonlySet<string>;
  tabs: readonly DocTab[];
  /** 頁面層級的提醒（例如範本有無法自動接線的輸入）。 */
  notice?: ReactNode;
}) {
  const definitions = use(wireDefinitions());
  const navigate = useNavigate();
  const catalog = useCatalog();
  // 圖的版面依 lookup 計算：目錄資料不變時保持同一個函式，避免每次重繪都重新排版
  const lookup = useMemo(() => makeLookup(catalog.data), [catalog.data]);
  const nodeIds = (catalog.data?.nodes ?? []).map((node) => node.node_id);
  const providers = useProviderIndex(nodeIds);
  const options = componentOptions(catalog.data, providers);
  const save = useSavePipeline();
  const editor = usePipelineDraft(initial, isNew);
  const { draft, setDraft, baseline, dirty, stepKeys } = editor;
  const { view, setView, selection, select } = useEditorView(isNew);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 有錯誤時按儲存：先確認（草稿可以儲存，但建立 run 時伺服器會以 422 拒絕）。 */
  const [confirmSave, setConfirmSave] = useState(false);
  const [runSeed, setRunSeed] = useState<RunFormSeed | null>(null);
  const allowLeaveRef = useRef(false);
  // 「步驟與接線」：上移／下移後，步驟卡從舊位置平滑移到新位置（FLIP，只用 transform）
  const stepListRef = useRef<HTMLOListElement>(null);
  useFlipList(stepListRef, stepKeys.keys.join("␟"));

  const issues = validatePipeline(draft, lookup);
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning" && !(issue.stepId != null && issue.stepId !== ""));
  const edges = wiringEdges(draft, lookup);
  const idTaken = isNew && existingIds.has(draft.pipeline_id);
  const typeSuggestions = options.flatMap((option) => [...option.descriptor.inputs, ...option.descriptor.outputs].map((port) => port.type_id));
  const labelOfNode = (nodeId: string) => catalog.data?.directory.find((entry) => entry.node_id === nodeId)?.label ?? null;

  const blocker = useBlocker(({ currentLocation, nextLocation }) => !allowLeaveRef.current && dirty && currentLocation.pathname !== nextLocation.pathname);

  const saveReason = save.isPending
    ? null
    : !dirty
      ? t("沒有變更")
      : localIdError(draft.pipeline_id, "pipeline_id ") ?? (draft.steps.length === 0 ? t("至少需要一個步驟") : null);

  const doSave = (confirmed = false) => {
    if ((saveReason ?? "") || save.isPending) return;
    if (errors.length > 0 && !confirmed) {
      setConfirmSave(true);
      return;
    }
    setConfirmSave(false);
    save.mutate(draft, {
      onSuccess: (saved) => {
        editor.markSaved(saved);
        if (isNew) {
          allowLeaveRef.current = true;
          void navigate(`/admin/pipelines/${encodeURIComponent(saved.pipeline_id)}`, { replace: true });
        }
      },
    });
  };

  /**
   * 刪除後回到清單：同步提交導覽（不等 transition），避免清單快取更新時這頁先閃出「讀取中／找不到」。
   * state：要在清單上顯示的說明（例如伺服器上已經沒有這個元件組合）。
   */
  const leaveToList = (state?: ListLeaveState) => {
    allowLeaveRef.current = true;
    setConfirmDelete(false);
    void navigate("/admin/pipelines", { replace: true, flushSync: true, state: state ?? undefined });
  };

  const runReason = errors.length > 0 ? t("有 {errorsCount} 個錯誤（接線或參數），伺服器會以 422 拒絕", { errorsCount: errors.length }) : draft.steps.length === 0 ? t("至少需要一個步驟") : null;
  const selectedIndex = selection?.kind === "step" ? draft.steps.findIndex((step) => step.step_id === selection.id) : -1;

  /** 步驟清單與 Inspector 共用同一份 StepEditor 接線。 */
  const stepBinding = (index: number): StepBinding | null => {
    const step = draft.steps[index];
    if (!step) return null;
    return {
      step,
      index,
      count: draft.steps.length,
      pipeline: draft,
      lookup,
      options,
      issues,
      onChange: (next) => { editor.updateStep(index, next); },
      onRename: (next) => {
        const error = editor.renameAt(index, step.step_id, next);
        if (!(error != null && error !== "") && selection?.kind === "step" && selection.id === step.step_id) select({ kind: "step", id: next });
        return error;
      },
      onMove: (to) => { editor.moveAt(index, to); },
      onRemove: () => {
        const removed = editor.removeAt(index);
        if ((removed != null && removed !== "") && selection?.kind === "step" && selection.id === removed) select(null);
      },
      onAddInput: editor.addInputFor,
      // 步驟輸出埠上的流程輸出
      exports: {
        byPort: exportsOfStep(draft, step.step_id),
        onAdd: (port) => { editor.exportPort(step.step_id, port); },
        onSelect: (name) => { select({ kind: "output", id: name }); },
      },
      nodeLabel: labelOfNode,
    };
  };
  const addStep = () => { select({ kind: "step", id: editor.addStep() }); };

  const idField = isNew ? (
    <CommitInput
      id="pipeline-id"
      label="pipeline_id"
      value={draft.pipeline_id}
      onCommit={(next) => {
        const error = localIdError(next, "pipeline_id ");
        if (error != null && error !== "") return error;
        setDraft({ ...draft, pipeline_id: next });
        return null;
      }}
    />
  ) : (
    <code id="pipeline-id" className="machine flex min-h-8 items-center text-fg">
      {draft.pipeline_id}
    </code>
  );

  const stepsView = (
    <div className="grid min-w-0 gap-5 p-4">
      <PipelineInputsEditor pipeline={draft} onChange={setDraft} typeSuggestions={typeSuggestions} />
      <section className="grid gap-3" aria-labelledby="pipeline-steps-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="pipeline-steps-title" className="text-section font-semibold text-fg">
            {t("步驟（{stepsCount}）", { stepsCount: draft.steps.length })}
          </h3>
          <Button size="sm" icon={<Plus aria-hidden />} onClick={addStep}>
            {t("新增步驟")}
          </Button>
        </div>
        {catalog.isError ? <ErrorCallout error={catalog.error} title={t("無法讀取元件目錄：連接埠與型別無法檢查")} onRetry={() => void catalog.refetch()} /> : null}
        {draft.steps.length === 0 ? <p className="text-data text-fg-tertiary">{t("還沒有步驟。新增步驟後從元件庫選擇 instance。")}</p> : null}
        <ol ref={stepListRef} className="grid gap-3">
          {draft.steps.map((_step, index) => {
            const binding = stepBinding(index);
            return binding ? <StepEditor key={stepKeys.keys[index]} appear={index} {...binding} /> : null;
          })}
        </ol>
      </section>
      <PipelineOutputsEditor pipeline={draft} lookup={lookup} onChange={setDraft} />
      <WiringSummary edges={edges} />
    </div>
  );

  const jsonView = (
    <div className="grid gap-2 p-4">
      <JsonEditor
        id="pipeline-json"
        label="pipeline JSON"
        value={draft}
        accept={(next) =>
          matchesReply(next, "WirePipeline", definitions)
            ? null
            : t("需要 pipeline_id、label、inputs[]、steps[]、outputs{}")
        }
        onChange={(next) => { if (matchesReply(next, "WirePipeline", definitions)) setDraft(next); }}
        rows={24}
      />
      <Badge className="w-fit">{t("伺服器以 contracts Pipeline schema 驗證；與節點圖、「步驟與接線」是同一份草稿")}</Badge>
    </div>
  );

  // 開啟中的分頁標題跟著草稿的名稱即時更新（不用等儲存）；未儲存時在提示中註明
  const liveTabs = tabs.map((tab) =>
    tab.active ? { ...tab, label: draft.label || draft.pipeline_id || tab.label, title: `${draft.label || draft.pipeline_id}${dirty ? t("（有未儲存的修改）") : ""}` } : tab,
  );
  const center = (
    <>
      <DocTabs label={t("開啟的文件")} tabs={liveTabs} />
      <PageHeader
        icon={<Workflow />}
        title={draft.label || draft.pipeline_id}
        className="shrink-0 border-b border-line-subtle px-4 py-3"
        description={
          <span className="machine text-caption text-fg-tertiary">
            {t("{pipeline_id} · {stepsCount} 步 · 輸入 {inputsCount} · 輸出 {outputsCount}", { pipeline_id: draft.pipeline_id, stepsCount: draft.steps.length, inputsCount: draft.inputs.length, outputsCount: Object.keys(draft.outputs).length })}
          </span>
        }
        meta={
          <>
            <StatusChip
              tone={isNew && baseline === null ? "action" : dirty ? "warning" : "success"}
              label={isNew && baseline === null ? t("尚未儲存的新元件組合") : dirty ? t("有未儲存的修改") : t("與已保存版本一致")}
            />
            {errors.length > 0 ? <StatusChip tone="danger" label={t("{errorsCount} 個錯誤", { errorsCount: errors.length })} title={t("接線或呼叫參數的問題：執行時伺服器會以 422 拒絕（詳見底部「問題」）")} /> : null}
            {warnings.length > 0 ? <StatusChip tone="warning" label={t("{warningsCount} 個提醒", { warningsCount: warnings.length })} /> : null}
            <span className="text-caption text-fg-tertiary">{t("執行不需先儲存：run 會凍結當下的草稿。")}</span>
          </>
        }
        actions={
          <>
            <ActionButton
              size="sm"
              variant="primary"
              icon={<Save aria-hidden />}
              pending={save.isPending}
              disabledReason={saveReason}
              title={errors.length > 0 ? t("有 {errorsCount} 個錯誤：儲存前會先確認", { errorsCount: errors.length }) : undefined}
              onClick={() => { doSave(); }}
            >
              {t("儲存元件組合")}
            </ActionButton>
            <ActionButton size="sm" icon={<Play aria-hidden />} disabledReason={runReason} onClick={() => { setRunSeed({ pipeline: draft, label: draft.label, title: t("以目前草稿建立 run") }); }}>
              {t("執行")}
            </ActionButton>
            {!isNew ? (
              <Button
                size="sm"
                variant="quiet"
                icon={<CopyPlus aria-hidden />}
                onClick={() => {
                  allowLeaveRef.current = true;
                  const copy = { ...cloneJson(draft), pipeline_id: uniqueName(`${draft.pipeline_id}-copy`, existingIds), label: t("{label}（複製）", { label: draft.label }) };
                  void navigate("/admin/pipelines/new", { state: { draft: copy } });
                }}
              >
                {t("另存新元件組合")}
              </Button>
            ) : null}
            <Button size="sm" variant="quiet" icon={<Undo2 aria-hidden />} disabled={!dirty || baseline === null} onClick={editor.discard}>
              {t("捨棄修改")}
            </Button>
            {!isNew ? (
              <Button size="sm" variant="danger" icon={<Trash2 aria-hidden />} onClick={() => { setConfirmDelete(true); }}>
                {t("刪除元件組合")}
              </Button>
            ) : null}
          </>
        }
      />
      {hasSlotContent(notice) || save.isError || (save.isSuccess && !dirty) ? (
        <div className="grid shrink-0 gap-2 border-b border-line-subtle px-4 py-2">
          {notice}
          {save.isError ? <ErrorCallout error={save.error} write title={t("儲存失敗；草稿仍保留")} /> : null}
          {save.isSuccess && !dirty ? (
            <p className="text-caption text-success animate-rise-in" role="status">
              {t("已儲存元件組合 {pipeline_id}（只保存，不會執行）。", { pipeline_id: save.data.pipeline_id })}
            </p>
          ) : null}
        </div>
      ) : null}
      <PanelTabs tabs={VIEWS} value={view} onChange={setView} idPrefix="pipeline-view" label={t("元件組合檢視")} variant="underline" />
      {view === "graph" ? (
        // 畫布自己處理滾輪（平移／縮放），不能放在會捲動的容器裡
        <div role="tabpanel" id="pipeline-view-panel-graph" aria-labelledby="pipeline-view-tab-graph" className="relative min-h-0 flex-1">
          <PipelineGraph
            pipeline={draft}
            lookup={lookup}
            issues={issues}
            selection={selection}
            onSelect={select}
            label={t("元件組合「{value}」的節點圖", { value: draft.label || draft.pipeline_id })}
            nodeLabel={labelOfNode}
            className="absolute inset-0"
          />
        </div>
      ) : (
        <DockBody role="tabpanel" id={`pipeline-view-panel-${view}`} aria-labelledby={`pipeline-view-tab-${view}`}>
          {view === "steps" ? stepsView : jsonView}
        </DockBody>
      )}
    </>
  );

  const selectedBinding = selectedIndex >= 0 ? stepBinding(selectedIndex) : null;
  const inspector = (
    <PipelineInspector
      pipeline={draft}
      selection={selection}
      select={select}
      lookup={lookup}
      issues={issues}
      errors={errors}
      warnings={warnings}
      selectedStep={selectedBinding ? { key: stepKeys.keys[selectedIndex] ?? String(selectedIndex), binding: selectedBinding } : null}
      isNew={isNew}
      idField={idField}
      idTaken={idTaken}
      onChange={setDraft}
    />
  );

  return (
    <>
      <WorkbenchPage
        storageKey="admin.pipeline"
        center={center}
        centerLabel={t("元件組合編輯器")}
        inspector={inspector}
        inspectorLabel={t("元件組合檢視器")}
        dockLabel={t("元件組合輸出面板")}
        dockTabs={[
          {
            id: "issues",
            label: t("問題"),
            icon: CircleAlert,
            count: issues.length,
            countTone: errors.length > 0 ? "danger" : issues.length > 0 ? "warning" : "neutral",
            render: () => <IssuesPanel issues={issues} onSelectStep={(stepId) => { select({ kind: "step", id: stepId }); }} />,
          },
          { id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog /> },
        ]}
      />
      <PipelineOutline pipeline={draft} lookup={lookup} issues={issues} selection={selection} onSelect={select} />
      <RunFormDialog seed={runSeed} onOpenChange={(open) => { if (!(open)) { setRunSeed(null); } }} />

      <DeletePipelineDialog open={confirmDelete} onOpenChange={setConfirmDelete} pipeline={draft} dirty={dirty} onDeleted={leaveToList} />
      <SaveWithErrorsDialog open={confirmSave} onOpenChange={setConfirmSave} errors={errors} pending={save.isPending} onConfirm={() => { doSave(true); }} />
      <LeaveDraftDialog blocker={blocker} />
    </>
  );
}
