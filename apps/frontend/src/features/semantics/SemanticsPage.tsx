// 語意與資料集：反推語意（video.describe）→ 編修 Scene → caption.compile → dataset.export。沒有 reviewed／approved 旗標。
// 工作台版面：中欄＝文件分頁、頁首、步驟分頁與目前步驟的工作區（唯一 scroll owner）；檢視器＝目前步驟的 run 事實、元件與參數，
// 底部固定該步驟的主要動作。網址保存各步驟的 run（describe_run／caption_run／export_run）；步驟分頁是畫面狀態。
import { Activity, ScanText } from "lucide-react";
import { useState } from "react";
import { useBlocker, useLocation, useSearchParams } from "react-router";
import { useRun } from "@/api/runs";
import { asCaptionPair } from "@/api/types";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DockBody } from "@/components/workbench/DockPanel";
import { DocTabs } from "@/components/workbench/DocTabs";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { ActivityLog } from "@/features/activity";
import { FlowTabs, type FlowTabItem } from "@/components/flow/FlowTabs";
import { SubBrandNav } from "@/components/flow/SubBrandNav";
import { CaptionInspector, CaptionWorkspace } from "./CaptionPanel";
import { DatasetInspector, DatasetWorkspace } from "./DatasetPanel";
import { DescribeInspector, DescribeWorkspace } from "./DescribeStep";
import { SceneInspector, SceneWorkspace } from "./SceneStep";
import { StepPane } from "./StepFrame";
import { findRunValue, type DatasetRow } from "./sceneModel";
import { initialStep, semanticsFlow, STEPS, type StepId } from "./stepModel";
import { useCaptionStep, useDatasetStep, useDescribeStep, useSceneStep } from "./useSemanticsSteps";
import { PATHS } from "@/app/paths";
import { t } from "@/i18n";

const TAB_PREFIX = "semantics-step";

/** 步驟列的英文副標（裝飾）。 */
const STEP_EN: Record<StepId, string> = { describe: "Describe", scene: "Scene", caption: "Caption", dataset: "Dataset" };

export function SemanticsPage() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const describeRunId = params.get("describe_run");
  const captionRunId = params.get("caption_run");
  const exportRunId = params.get("export_run");
  const describeRun = useRun(describeRunId);
  const captionRun = useRun(captionRunId);
  const exportRun = useRun(exportRunId);
  const [step, setStep] = useState<StepId>(() => initialStep({ describeRun: describeRunId, captionRun: captionRunId, exportRun: exportRunId }));
  const [rows, setRows] = useState<DatasetRow[]>([]);

  const setRunParams = (changes: Record<string, string | null>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );

  const scene = useSceneStep(describeRun.data, describeRunId);
  const describe = useDescribeStep(describeRun.data, (runId) => {
    scene.revert();
    setRunParams({ describe_run: runId, caption_run: null });
  });
  const caption = useCaptionStep(scene.captionScene, scene.captionSceneBlock, (runId) => setRunParams({ caption_run: runId }));
  const dataset = useDatasetStep(rows, (runId) => setRunParams({ export_run: runId }));

  const pairValue = findRunValue(captionRun.data, "caption.pair.v1");
  const currentPair = pairValue && "value" in pairValue ? asCaptionPair(pairValue.value) : null;

  const blocker = useBlocker(({ currentLocation, nextLocation }) => (rows.length > 0 || scene.unsavedEdits) && currentLocation.pathname !== nextLocation.pathname);

  /**
   * 切換步驟。四個步驟都保持掛載（只隱藏），所以上傳中的檔案、JSON 草稿、編修中的輸入都不會因切換而遺失；
   * 離開的步驟裡正在播放的影音先暫停（隱藏的 <video> 仍會繼續出聲）。
   */
  const selectStep = (next: StepId) => {
    if (next !== step) {
      for (const media of document.getElementById(`${TAB_PREFIX}-panel-${step}`)?.querySelectorAll<HTMLMediaElement>("video, audio") ?? []) media.pause();
    }
    setStep(next);
  };

  /** 「下一步」：切換分頁並把焦點交給該分頁（鍵盤使用者知道自己在哪一步）。 */
  const goTo = (next: StepId) => {
    selectStep(next);
    window.requestAnimationFrame(() => document.getElementById(`${TAB_PREFIX}-tab-${next}`)?.focus());
  };

  const flow = semanticsFlow({
    describeRun: describeRunId ? (describeRun.data?.state ?? null) : null,
    captionRun: captionRunId ? (captionRun.data?.state ?? null) : null,
    exportRun: exportRunId ? (exportRun.data?.state ?? null) : null,
    hasScene: scene.draft !== null,
    sceneIssues: scene.draft ? scene.issues.length : 0,
    sceneUnsaved: scene.unsavedEdits,
    sceneReady: scene.captionScene !== null,
    hasPair: currentPair !== null,
    rows: rows.length,
  });
  const stepTabs: FlowTabItem[] = STEPS.map((item) => ({
    id: item.id,
    label: item.label,
    en: STEP_EN[item.id],
    status: flow[item.id].status,
    detail: flow[item.id].detail,
    ...(item.id === "scene" && scene.draft && scene.issues.length > 0 ? { count: scene.issues.length, countTone: "danger" as const } : item.id === "dataset" && rows.length > 0 ? { count: rows.length } : {}),
  }));

  const center = (
    <>
      <SubBrandNav current="semantics" />
      <DocTabs
        label={t("開啟的文件")}
        tabs={[{ id: "semantics", label: t("反推（語意與資料集）"), icon: ScanText, to: `${PATHS.semantics}${location.search}`, active: true, title: t("影片反推：Scene、caption、資料集匯出") }]}
        trailing={
          scene.unsavedEdits || rows.length > 0 ? (
            <>
              {scene.unsavedEdits ? <Badge tone="warning">{t("Scene 未另存")}</Badge> : null}
              {rows.length > 0 ? <Badge title={t("資料列只存在這個頁面；離開前會確認")}>{t("資料集草稿 {rowsCount} 列", { rowsCount: rows.length })}</Badge> : null}
            </>
          ) : null
        }
      />
      <PageHeader
        icon={<ScanText />}
        title={t("反推：語意與資料集")}
        description={t("原片 → video.describe（依真實 PTS 抽樣）→ 編修 Scene → caption.compile → dataset.export；不需要審核旗標。")}
        className="shrink-0 border-b border-line-subtle px-4 py-3"
      />
      <FlowTabs tabs={stepTabs} value={step} onChange={(id) => selectStep(id as StepId)} idPrefix={TAB_PREFIX} label={t("工作流程步驟")} />
      {STEPS.map((item) => (
        <DockBody key={item.id} role="tabpanel" id={`${TAB_PREFIX}-panel-${item.id}`} aria-labelledby={`${TAB_PREFIX}-tab-${item.id}`} hidden={item.id !== step}>
          {item.id === "describe" ? (
            <DescribeWorkspace step={describe} describeRunId={describeRunId} describeRun={describeRun} hasScene={scene.sceneValue !== null} onNext={() => goTo("scene")} />
          ) : item.id === "scene" ? (
            <SceneWorkspace scene={scene} describeRunId={describeRunId} describeRun={describeRun} />
          ) : item.id === "caption" ? (
            <CaptionWorkspace captionRunId={captionRunId} captionRun={captionRun} pair={currentPair} sceneBlock={scene.captionSceneBlock} onNext={() => goTo("dataset")} />
          ) : (
            <DatasetWorkspace rows={rows} onRowsChange={setRows} currentPair={currentPair} />
          )}
        </DockBody>
      ))}
    </>
  );

  const inspector = (
    <>
      <StepPane active={step === "describe"}>
        <DescribeInspector step={describe} describeRunId={describeRunId} describeRun={describeRun} />
      </StepPane>
      <StepPane active={step === "scene"}>
        <SceneInspector scene={scene} describeRunId={describeRunId} describeRun={describeRun} />
      </StepPane>
      <StepPane active={step === "caption"}>
        <CaptionInspector step={caption} scene={scene} captionRunId={captionRunId} captionRun={captionRun} />
      </StepPane>
      <StepPane active={step === "dataset"}>
        <DatasetInspector step={dataset} rowCount={rows.length} exportRunId={exportRunId} exportRun={exportRun} />
      </StepPane>
    </>
  );

  return (
    <>
      <WorkbenchPage
        storageKey="admin.semantics"
        centerLabel={t("語意工作區")}
        center={center}
        inspector={inspector}
        inspectorLabel={t("步驟檢視器")}
        dockLabel={t("輸出面板")}
        dockTabs={[{ id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog /> }]}
      />

      <Dialog open={blocker.state === "blocked"} onOpenChange={(open) => (open ? undefined : blocker.reset?.())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("離開語意頁？")}</DialogTitle>
            <DialogDescription>
              {scene.unsavedEdits && rows.length > 0
                ? t("Scene 有未另存的修改，資料集有 {rowsCount} 列尚未匯出。離開會捨棄這些內容。", { rowsCount: rows.length })
                : scene.unsavedEdits
                  ? t("Scene 有未另存的修改。離開會捨棄這些內容。")
                  : t("資料集有 {rowsCount} 列尚未匯出。離開會捨棄這些內容。", { rowsCount: rows.length })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-data text-fg-secondary">{t("已建立的 run 與已上傳的檔案不受影響。")}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="quiet" onClick={() => blocker.reset?.()}>
              {t("留在此頁")}
            </Button>
            <Button variant="danger" onClick={() => blocker.proceed?.()}>
              {t("捨棄並離開")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
