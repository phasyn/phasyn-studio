// 一個研究的工作區：文件分頁、頁首（封存、下載 JSON、刪除）、保存狀態與衝突、四個步驟分頁（都保持掛載，只隱藏）、
// 執行狀態列、各分頁的檢視器，以及底部「任務」「活動」。網址：?study=&tab=。
// 場景草稿、生成設定、seed 與搜尋設定是畫面狀態（建立任務時凍結進研究文件）；離開前有未儲存的修改或正在執行時會確認。
import { Activity, Archive, ArchiveRestore, Download, ListChecks, ListTree, RefreshCw, ScanSearch, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate, useSearchParams } from "react-router";
import { useCatalog } from "@/api/catalog";
import { usePipelines } from "@/api/pipelines";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DockBody } from "@/components/workbench/DockPanel";
import { DocTabs } from "@/components/workbench/DocTabs";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { ActivityLog } from "@/features/activity";
import { deriveImageRoutes as deriveImageStudioRoutes, shotRouteProblem } from "@/features/image-studio";
import { FlowTabs, type FlowTabItem } from "@/components/flow/FlowTabs";
import { SubBrandNav } from "@/components/flow/SubBrandNav";
import { downloadJson } from "@/lib/download";
import { useStudyDocument } from "../hooks/useStudyDocument";
import { useImageSize } from "../hooks/useImageSize";
import { useRenderController } from "../hooks/useRenderController";
import { useSceneController } from "../hooks/useSceneController";
import { useSearchController } from "../hooks/useSearchController";
import { useTaskRunner } from "../hooks/useTaskRunner";
import { chooseComponent, componentChoices, ROLE_PROVIDER, type ComponentRole } from "../model/components";
import { studyFlow } from "../model/flowStatus";
import { defaultRouteId, initialComponents, initialSettings } from "../model/initialState";
import { deriveImageRoutes } from "../model/routes";
import { LANGUAGE_LABELS } from "../model/sections";
import { acceptedRef, findTask, openTask, TASK_LABELS, versionLabel } from "../model/study";
import type { CandidateRef, GenerationSettings, PromptStudy, PromptStudyTask, TaskComponents } from "../types";
import { AcceptDialog, ApplyDialog } from "./CandidateActions";
import { DeleteStudyDialog } from "./DeleteStudyDialog";
import { RenderCenter, RenderInspector } from "./RenderTab";
import { RunnerStrip } from "./RunnerStrip";
import { SceneCenter, SceneInspector } from "./SceneTab";
import { SearchCenter, SearchInspector } from "./SearchTab";
import { SourceCenter, SourceInspector } from "./SourceTab";
import { LeaveStudyDialog, VersionSwitchDialog } from "./StudyWorkspaceDialogs";
import { TaskLog } from "./TaskLog";
import { TABS, tabOf, type TabId, type Workspace } from "./workspace";
import { t } from "@/i18n";

const TAB_PREFIX = "prompt-study-step";

function SaveBadge({ state, revision }: { state: ReturnType<typeof useStudyDocument>["saveState"]; revision: number }) {
  if (state === "saving") return <Badge tone="info">{t("保存中…")}</Badge>;
  if (state === "error") return <Badge tone="danger">{t("保存失敗")}</Badge>;
  if (state === "conflict") return <Badge tone="warning">{t("版本衝突")}</Badge>;
  return <Badge title={t("研究文件已保存到主控")}>{t("已保存 r{revision}", { revision })}</Badge>;
}

export function StudyWorkspace({ initial }: { initial: PromptStudy }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const doc = useStudyDocument(initial);
  const study = doc.study;
  const catalog = useCatalog();
  const pipelines = usePipelines();
  const routes = useMemo(() => deriveImageRoutes(pipelines.data?.items, catalog.data), [pipelines.data, catalog.data]);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [measured] = useImageSize(study.source.file);

  // 元件選擇（生成與搜尋任務建立時凍結進 request.settings）
  const [componentKeys, setComponentKeys] = useState<TaskComponents>(() => initialComponents(initial));
  const choices = useMemo(
    () => ({
      vision: componentChoices(catalog.data, ROLE_PROVIDER.vision),
      compile: componentChoices(catalog.data, ROLE_PROVIDER.compile),
      score: componentChoices(catalog.data, ROLE_PROVIDER.score),
    }),
    [catalog.data],
  );
  const chosen = {
    vision: chooseComponent(choices.vision, componentKeys.vision),
    compile: chooseComponent(choices.compile, componentKeys.compile),
    score: chooseComponent(choices.score, componentKeys.score),
  };
  const components: TaskComponents = { vision: chosen.vision?.key ?? null, compile: chosen.compile?.key ?? null, score: chosen.score?.key ?? null };
  const runner = useTaskRunner({ doc, catalog: catalog.data, routes, components });

  // 生成設定：元件組合沒選時用第一個能用的 t2i 元件組合（Image Studio judges text-to-image, as "Apply to Image Studio" does）
  const [settingsDraft, setSettings] = useState<GenerationSettings>(() => initialSettings(initial));
  const imageStudioRoutes = useMemo(() => deriveImageStudioRoutes(pipelines.data?.items, catalog.data), [pipelines.data, catalog.data]);
  const defaultRoute = defaultRouteId(routes, (routeId) => shotRouteProblem(imageStudioRoutes, routeId, "t2i") === null);
  const settings = settingsDraft.route && routes.some((route) => route.id === settingsDraft.route) ? settingsDraft : { ...settingsDraft, route: defaultRoute };

  // 分頁
  const tab: TabId = tabOf(params.get("tab")) ?? (study.versions.length === 0 ? "source" : "scene");
  const goTab = (next: TabId) =>
    setParams(
      (previous) => {
        const query = new URLSearchParams(previous);
        query.set("tab", next);
        return query;
      },
      { replace: true },
    );

  /** 建立任務時一起存進研究 settings 的內容（目前的生成設定與元件選擇；下次開啟沿用）。 */
  const persistSettings = () => ({ ...doc.latest().settings, generation: settings, components });
  const sceneState = useSceneController({ doc, runner, components, persistSettings });
  const { scene, dirty } = sceneState;
  const render = useRenderController({ doc, runner, settings, components, persistSettings });
  const search = useSearchController({ initial, doc, runner, settings, components, persistSettings });

  // 對話框
  const [accepting, setAccepting] = useState<{ ref: CandidateRef; taskId: string | null } | null>(null);
  const [applying, setApplying] = useState<{ ref: CandidateRef; settings: GenerationSettings } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const busy = runner.state.busy;
  const open = openTask(study);
  /** 研究已刪除：離開時不再確認。 */
  const deleted = useRef(false);
  const readOnly = study.archived;
  const accepted = acceptedRef(study);

  const ws: Workspace = {
    study,
    doc,
    runner,
    catalog: catalog.data,
    routes,
    routesLoading: pipelines.isPending || catalog.isPending,
    catalogLoading: catalog.isPending,
    choices,
    chosen,
    setComponent: (role: ComponentRole, key: string) => setComponentKeys((current) => ({ ...current, [role]: key })),
    components,
    sourceSize: sourceSize ?? measured,
    setSourceSize,
    settings,
    setSettings,
    persistSettings,
    readOnly,
    open,
    goTab,
    showCandidate: (ref) => {
      sceneState.setVariant(ref.variant);
      sceneState.selectVersion(ref.version_id);
      goTab("scene");
    },
    requestAccept: (ref, taskId) => setAccepting({ ref, taskId }),
    requestApply: (ref, applied) => setApplying({ ref, settings: applied }),
  };

  const openTaskTab = (task: PromptStudyTask) => {
    if (task.kind === "render") {
      render.setTaskId(task.task_id);
      goTab("render");
    } else if (task.kind === "reconstruct") {
      search.setTaskId(task.task_id);
      goTab("search");
    } else if (task.kind === "refine") {
      goTab("scene");
    } else {
      goTab("source");
    }
  };

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !deleted.current && (dirty || busy) && (currentLocation.pathname !== nextLocation.pathname || new URLSearchParams(nextLocation.search).get("study") !== study.study_id),
  );
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  const listPath = location.pathname;
  const runningKind = runner.state.mode === "compile" ? "compile" : (findTask(study, runner.state.taskId)?.kind ?? null);
  const flow = studyFlow({ study, dirty, sceneIssues: scene.issues.length, busy: busy ? runningKind : null });
  const tabs: FlowTabItem[] = TABS.map((item) => {
    const base = { id: item.id, label: item.label, en: item.en, status: flow[item.id].status, detail: flow[item.id].detail };
    if (item.id === "scene" && dirty) return { ...base, count: scene.issues.length > 0 ? scene.issues.length : null, countTone: "danger" as const };
    if (item.id === "render") return { ...base, count: study.tasks.filter((task) => task.kind === "render").length || null };
    if (item.id === "search") return { ...base, count: study.tasks.filter((task) => task.kind === "reconstruct").length || null };
    return base;
  });

  const center = (
    <>
      <SubBrandNav current="prompt-studies" />
      <DocTabs
        label={t("開啟的文件")}
        tabs={[
          { id: "list", label: t("研究清單"), icon: ListTree, to: listPath, active: false },
          { id: study.study_id, label: study.title || t("未命名研究"), icon: ScanSearch, iconTone: "info", to: `${listPath}${location.search}`, active: true, closeTo: listPath },
        ]}
        trailing={
          <>
            {dirty ? <Badge tone="warning">{t("場景未儲存")}</Badge> : null}
            <SaveBadge state={doc.saveState} revision={study.revision} />
          </>
        }
      />
      <PageHeader
        icon={<ScanSearch />}
        title={study.title || t("未命名研究")}
        description={t("{language} · {versionsCount} 個版本 · {tasksCount} 個任務{value}{value2}", { language: LANGUAGE_LABELS[study.language], versionsCount: study.versions.length, tasksCount: study.tasks.length, value: accepted ? t(" · 已接受 {versionLabel} {variant}", { versionLabel: versionLabel(study, accepted.version_id), variant: accepted.variant }) : "", value2: study.archived ? t(" · 已封存") : "" })}
        className="shrink-0 border-b border-line-subtle px-4 py-3"
        actions={
          <>
            <ActionButton
              size="sm"
              icon={study.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
              disabledReason={busy ? t("正在執行") : !study.archived && open ? t("「{kind}」任務尚未結束：先完成或結束它再封存", { kind: TASK_LABELS[open.kind] }) : null}
              title={study.archived ? t("取消封存：可以再編修與執行") : t("封存：從清單收起，內容全部保留")}
              onClick={() => void doc.update((current) => ({ ...current, archived: !current.archived })).catch(() => undefined)}
            >
              {study.archived ? t("取消封存") : t("封存")}
            </ActionButton>
            <Button size="sm" variant="quiet" icon={<Download aria-hidden />} onClick={() => downloadJson(`${study.study_id}.json`, study)}>
              {t("下載 JSON")}
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 aria-hidden />} disabled={busy} title={busy ? t("執行中不能刪除") : undefined} onClick={() => setDeleting(true)}>
              {t("刪除…")}
            </Button>
          </>
        }
      />
      {doc.saveState === "conflict" ? (
        <div className="shrink-0 border-b border-line-subtle px-4 py-2">
          <Callout tone="warning" title={t("研究已在其他地方更新：本頁停止保存")}>
            <p>{t("重新載入會讀取主控上的最新版本；編修中的場景草稿只要版本還在就會保留。")}</p>
            <Button size="sm" icon={<RefreshCw aria-hidden />} disabled={busy} onClick={() => void doc.reload().catch(() => undefined)}>
              {t("重新載入")}
            </Button>
          </Callout>
        </div>
      ) : doc.saveState === "error" ? (
        <div className="shrink-0 border-b border-line-subtle px-4 py-2">
          <ErrorCallout error={doc.saveError} write title={t("研究文件沒有保存（不會自動重送）")} onRetry={() => void doc.reload().catch(() => undefined)} retryLabel={t("重新讀取研究")} />
        </div>
      ) : null}
      <FlowTabs tabs={tabs} value={tab} onChange={(id) => goTab(tabOf(id) ?? "source")} idPrefix={TAB_PREFIX} label={t("圖片反推步驟")} />
      <RunnerStrip runner={runner} />
      {TABS.map((item) => (
        <DockBody key={item.id} role="tabpanel" id={`${TAB_PREFIX}-panel-${item.id}`} aria-labelledby={`${TAB_PREFIX}-tab-${item.id}`} hidden={item.id !== tab}>
          {item.id === "source" ? <SourceCenter ws={ws} /> : item.id === "scene" ? <SceneCenter ws={ws} scene={scene} /> : item.id === "render" ? <RenderCenter ws={ws} render={render} /> : <SearchCenter ws={ws} search={search} />}
        </DockBody>
      ))}
    </>
  );

  const inspector = (
    <>
      {TABS.map((item) => (
        <div key={item.id} hidden={item.id !== tab} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {item.id === "source" ? <SourceInspector ws={ws} /> : item.id === "scene" ? <SceneInspector ws={ws} scene={scene} /> : item.id === "render" ? <RenderInspector ws={ws} render={render} /> : <SearchInspector ws={ws} search={search} />}
        </div>
      ))}
    </>
  );

  const acceptTarget = accepting?.ref ?? null;
  return (
    <>
      <WorkbenchPage
        storageKey="inference.promptStudies"
        centerLabel={t("圖片反推工作區")}
        center={center}
        inspector={inspector}
        inspectorLabel={t("步驟檢視器")}
        dockLabel={t("輸出面板")}
        dockTabs={[
          { id: "tasks", label: t("任務"), icon: ListChecks, count: study.tasks.length || null, render: () => <TaskLog study={study} onOpen={openTaskTab} /> },
          { id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog /> },
        ]}
      />
      <AcceptDialog
        study={study}
        candidate={acceptTarget}
        taskId={accepting?.taskId ?? null}
        open={accepting !== null}
        onOpenChange={(next) => (next ? undefined : setAccepting(null))}
        onAccept={async (versionId, acceptance) => {
          await doc.update((current) => ({ ...current, accepted_version_id: versionId, acceptance }));
        }}
      />
      <ApplyDialog
        study={study}
        candidate={applying?.ref ?? null}
        settings={applying?.settings ?? settings}
        pipelines={pipelines.data?.items}
        catalog={catalog.data}
        routesLoading={ws.routesLoading}
        open={applying !== null}
        onOpenChange={(next) => (next ? undefined : setApplying(null))}
      />
      <DeleteStudyDialog
        study={deleting ? { study_id: study.study_id, title: study.title, revision: study.revision } : null}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => {
          deleted.current = true;
          void navigate(listPath, { replace: true });
        }}
      />
      <VersionSwitchDialog study={study} switchTo={sceneState.switchTo} onCancel={sceneState.cancelSwitch} onConfirm={sceneState.confirmSwitch} />
      <LeaveStudyDialog blocker={blocker} dirty={dirty} busy={busy} />
    </>
  );
}
