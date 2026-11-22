// Video Studio's provider: the project document (the shell's autosave document), the shell value (save state, conflict
// actions, notices, engine sheet), the workspace value (project, engine, shot selection, playhead, render actions) and,
// inside them, the running render's progress (RenderActivityProvider) and the one editor instance every workspace
// shares (EditorProvider). The contexts are separate and memoized, so saving or a notice re-renders only the shell
// parts and a render's ticking clock only what shows it.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useStableCatalog } from "@/api/catalog";
import type { StudioProject, StudioTimelineCommand } from "@/api/generated/contracts";
import { usePipelines } from "@/api/pipelines";
import { usePluginRegistry } from "@/features/plugins";
import { useArchiveRun, useRunList } from "@/api/runs";
import { fetchProject, runTimelineCommands as postTimelineCommands } from "@/api/studioProjects";
import { RunDeleteDialog } from "@/features/runs";
import { StudioShellContext, useOutsideSaves, useStudioShellValue } from "@/features/studio-shell";
import { runIdName } from "@/lib/runName";
import { postAdoptedMedia, postRunTake } from "./attach/api";
import { EditorProvider } from "./editor/EditorProvider";
import { createPlayheadStore } from "./hooks/playhead";
import { useCostProfileEstimator } from "./hooks/useCostProfileEstimator";
import { SegmentEtaContext } from "./hooks/usePlanEta";
import { useProjectDocument } from "./hooks/useProjectDocument";
import { useRenderTracker } from "./hooks/useRenderTracker";
import { useRunSlots } from "./hooks/useRunSlots";
import { useStudioRender } from "./hooks/useStudioRender";
import { continuedShotFields, newShot } from "./model/project";
import { defaultRouteFor, resolveEngine } from "./model/routes";
import { RenderActivityProvider } from "./RenderActivityProvider";
import { StudioContext, type MonitorMode, type ShotListener, type StudioContextValue } from "./studioContext";
import { errorText } from "./swap/errors";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

interface DeleteTarget {
  runIds: string[];
  removeShotId?: string;
  nextShotId?: string | null;
}

export function StudioProvider({ initial, children }: { initial: StudioProject; children: ReactNode }) {
  const document = useProjectDocument(initial);
  const { state, dispatch, flush, reload, transact } = document;
  // Video Studio does not offer "keep both": reorder, split and join are not safe to replay on another version.
  const shell = useStudioShellValue(document, { offerRebase: false });
  const { notify, setEngineOpen } = shell;
  // A version saved elsewhere (another tab, an AI agent) replaces this one while nothing here is unsaved
  useOutsideSaves(document, notify);
  const project = state.draft;
  useRenderTracker(project, dispatch);

  const catalog = useStableCatalog();
  const pipelines = usePipelines();
  const loadError = pipelines.data ? catalog.error : (pipelines.error ?? catalog.error);
  const loadErrorText = loadError ? errorText(loadError) : null;
  const engine = useMemo(
    () => resolveEngine({ pipelines: pipelines.data?.items, catalog: catalog.data, error: loadErrorText }),
    [pipelines.data, catalog.data, loadErrorText],
  );
  // The Controller's plugin registry: in the context value so every panel re-renders when it is read or changes
  const plugins = usePluginRegistry();
  // Render-time estimates (render buttons, queue, running renders, swap wizard) from the routes' cost profiles
  const estimator = useCostProfileEstimator(engine.routes);
  const { busy, renderShots, renderVariants, renderVariantBatch, renderVariations, exportSequence, createProxy } = useStudioRender({ project, dispatch, transact, engine, catalog: catalog.data, notify, estimator });

  const { activeRunIds, blockedReason: runBlockedReason } = useRunSlots();
  // 這個專案已封存的 run（摘要）：只讀第一頁（最多 200 個，伺服器上限）；更早的封存在這裡會當成未封存顯示
  const archivedList = useRunList(200, "only", { related_project_id: project.project_id }, "summary");
  const archivedRunIds = useMemo(() => new Set(archivedList.data?.pages.flatMap((page) => page.items.map((run) => run.run_id)) ?? []), [archivedList.data]);
  const { mutateAsync: archiveRun } = useArchiveRun();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const [params, setParams] = useSearchParams();
  const [playhead] = useState(createPlayheadStore);
  const [monitorModeState, setMonitorModeState] = useState<MonitorMode>("source");
  const [sourceTakeId, setSourceTakeId] = useState<string | null>(null);
  const [compareTakeId, setCompareTakeId] = useState<string | null>(null);

  const requested = params.get("shot");
  const selectedShotId = (requested != null && requested !== "") && project.shots.some((shot) => shot.shot_id === requested) ? requested : (project.shots[0]?.shot_id ?? null);

  const shotListenerRef = useRef<ShotListener | null>(null);
  const listenShots = useCallback((listener: ShotListener) => {
    shotListenerRef.current = listener;
    return () => {
      if (shotListenerRef.current === listener) shotListenerRef.current = null;
    };
  }, []);
  const selectShot = useCallback(
    (shotId: string | null, options: { fromClip?: boolean } = {}) => {
      setSourceTakeId(null);
      setCompareTakeId(null);
      if (!(options.fromClip === true)) shotListenerRef.current?.selected(shotId);
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (shotId != null && shotId !== "") next.set("shot", shotId);
          else next.delete("shot");
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const setMonitorMode = useCallback(
    (mode: MonitorMode) => {
      // 回到鏡頭畫面時停止序列播放：序列的播放迴圈只在監看器顯示序列時存在
      if (mode === "source") playhead.setPlaying(false);
      setMonitorModeState(mode);
    },
    [playhead],
  );

  const addShot = useCallback(
    (afterShotId?: string | null) => {
      const after = afterShotId ?? selectedShotId;
      // The new shot continues the one it follows (the same characters and length); without one, the last shot
      const previous = project.shots.find((item) => item.shot_id === after) ?? project.shots.at(-1);
      const shot = newShot(project, { ...continuedShotFields(previous), ...(engine.status === "ready" ? { route: defaultRouteFor(project, engine.routes) } : {}) });
      dispatch({ type: "addShot", shot, afterShotId: after });
      shotListenerRef.current?.added(shot);
      selectShot(shot.shot_id, { fromClip: true });
    },
    [dispatch, engine, project, selectShot, selectedShotId],
  );

  const attachRunTake = useCallback(
    (shotId: string, runId: string, output: string) =>
      transact(async (saved) => {
        await postRunTake(saved.project_id, shotId, saved.revision, runId, output);
        return fetchProject(saved.project_id);
      }),
    [transact],
  );

  const adoptMedia = useCallback(
    (shotId: string, runId: string, output: string, parent: string | null) =>
      transact(async (saved) => {
        await postAdoptedMedia(saved.project_id, shotId, saved.revision, runId, output, parent);
        return fetchProject(saved.project_id);
      }),
    [transact],
  );

  const runTimelineCommands = useCallback(
    (commands: StudioTimelineCommand[]) => transact(async (saved) => (await postTimelineCommands(saved.project_id, { revision: saved.revision, commands })).project),
    [transact],
  );

  const setRunArchived = useCallback(
    async (runId: string, archived: boolean) => {
      try {
        await archiveRun({ runId, archived });
        notify({ tone: "success", title: archived ? t("已封存這次渲染") : t("已取消封存"), ...(archived ? { detail: t("檔案與紀錄都保留；在佇列打開「顯示已封存」可以再看到它。") } : {}) });
      } catch (error) {
        notify({ tone: "danger", title: archived ? t("封存失敗") : t("取消封存失敗"), detail: errorText(error) });
      }
    },
    [archiveRun, notify],
  );

  const deleteRuns = useCallback(
    (runIds: string[], options: { removeShotId?: string; nextShotId?: string | null } = {}) => { setDeleteTarget(runIds.length > 0 ? { runIds: [...new Set(runIds)], ...options } : null); },
    [],
  );

  /** 刪除確認框裡的名稱：這個專案中用到該 run 的鏡頭名稱，或「序列匯出」。 */
  const runLabel = (runId: string) => {
    const titles = project.shots.filter((shot) => shot.takes.some((take) => take.run_id === runId)).map((shot) => shot.title || shot.shot_id);
    if (titles.length > 0) return formatList([...new Set(titles)]);
    if (project.exports.some((record) => record.run_id === runId)) return t("序列匯出");
    return runIdName(runId);
  };

  const onDeleted = (deleted: string[]) => {
    if (deleted.length === 0) return;
    const target = deleteTarget;
    // 伺服器已從專案移除這些 run 的 take／匯出並遞增 revision：重新載入，避免下一次保存發生衝突
    reload()
      .then(() => {
        // 「刪除鏡頭與影片」：影片都刪掉之後才移除鏡頭；有任何 run 沒刪成，鏡頭保留讓使用者之後再試
        if (!(target?.removeShotId != null && target.removeShotId !== "")) return;
        if (!target.runIds.every((runId) => deleted.includes(runId))) {
          notify({ tone: "warning", title: t("鏡頭沒有移除"), detail: t("有些影片沒有刪除成功（例如 Node 離線）；鏡頭保留，之後可以再刪一次。") });
          return;
        }
        dispatch({ type: "removeShot", shotId: target.removeShotId });
        if (selectedShotId === target.removeShotId) selectShot(target.nextShotId ?? null);
      })
      .catch((error: unknown) => { notify({ tone: "danger", title: t("重新載入專案失敗"), detail: errorText(error) }); });
  };

  const value = useMemo<StudioContextValue>(
    () => ({
      project,
      createProxy,
      dispatch,
      documentGeneration: state.generation,
      flush,
      runTimelineCommands,
      adoptMedia,
      attachRunTake,
      catalog: catalog.data,
      engine,
      plugins,
      selectedShotId,
      selectShot,
      listenShots,
      playhead,
      monitorMode: monitorModeState,
      setMonitorMode,
      sourceTakeId,
      setSourceTakeId,
      compareTakeId,
      setCompareTakeId,
      busy,
      activeRunIds,
      runBlockedReason,
      setEngineOpen,
      renderShots,
      renderVariants,
      renderVariantBatch,
      renderVariations,
      exportSequence,
      addShot,
      archivedRunIds,
      setRunArchived,
      deleteRuns,
      notify,
    }),
    [
      project,
      createProxy,
      dispatch,
      state.generation,
      flush,
      runTimelineCommands,
      adoptMedia,
      attachRunTake,
      catalog.data,
      engine,
      plugins,
      selectedShotId,
      selectShot,
      listenShots,
      playhead,
      monitorModeState,
      setMonitorMode,
      sourceTakeId,
      compareTakeId,
      busy,
      activeRunIds,
      runBlockedReason,
      setEngineOpen,
      renderShots,
      renderVariants,
      renderVariantBatch,
      renderVariations,
      exportSequence,
      addShot,
      archivedRunIds,
      setRunArchived,
      deleteRuns,
      notify,
    ],
  );

  return (
    <StudioShellContext value={shell}>
      <StudioContext value={value}>
        <SegmentEtaContext value={estimator}>
          <RenderActivityProvider>
            <EditorProvider>{children}</EditorProvider>
          </RenderActivityProvider>
        </SegmentEtaContext>
        <RunDeleteDialog
          runIds={deleteTarget?.runIds ?? []}
          open={deleteTarget !== null}
          onOpenChange={(open) => { if (!(open)) { setDeleteTarget(null); } }}
          labelOf={runLabel}
          outputKind="video"
          beforeDelete={flush}
          onDone={onDeleted}
        />
      </StudioContext>
    </StudioShellContext>
  );
}
