// Image Studio's provider: the project document (the shell's autosave document; "keep both" is offered after a conflict
// because the image actions are incremental), the shell value (save state, conflict actions, notices, engine sheet)
// and the workspace value (project, engine, selection, generate). The two contexts are separate and both memoized, so
// saving or a notice re-renders only the shell parts. Generating is one function (useGenerate), shared by the toolbar's
// main action and the inspector's Ctrl+Enter, so both send the same request once and show the same pending state.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useStableCatalog } from "@/api/catalog";
import { usePipelines } from "@/api/pipelines";
import { useArchiveRun, useRunList } from "@/api/runs";
import { notePanelToggle } from "@/components/ui/motion";
import { RunDeleteDialog } from "@/features/runs";
import { catalogLookup, deriveStudioRoutes, UNASSIGNED_ROUTE, useRunSlots } from "@/features/studio";
import { StudioShellContext, useOutsideSaves, useStudioShellValue } from "@/features/studio-shell";
import { runIdName } from "@/lib/runName";
import { usePersistentFlag } from "@/lib/usePersistentSize";
import { PANEL_NAMES } from "./components/panels";
import { useGenerate } from "./hooks/useGenerate";
import { useImageDocument } from "./hooks/useImageDocument";
import { useImageRunTracker } from "./hooks/useImageRunTracker";
import { ImageStudioContext, type ImageEngine, type ImageStudioContextValue, type SendTarget } from "./imageStudioContext";
import { deriveImageRoutes, pickImageRoute } from "./model/routes";
import { videoShotUrl } from "./model/sendToVideo";
import { activeImageTake, imageShots, newImageShot } from "./model/shots";
import { errorText } from "./support";
import type { ImageStudioProject } from "./types";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export function ImageStudioProvider({ initial, children }: { initial: ImageStudioProject; children: ReactNode }) {
  const navigate = useNavigate();
  const document = useImageDocument(initial);
  const { state, dispatch, flush, reload } = document;
  const shell = useStudioShellValue(document, { offerRebase: true });
  const { notify, setEngineOpen } = shell;
  // A version saved elsewhere (another tab, an AI agent) replaces this one while nothing here is unsaved
  useOutsideSaves(document, notify);
  const project = state.draft;
  const projectRef = useRef(project);
  useLayoutEffect(() => {
    projectRef.current = project;
  });
  const runs = useImageRunTracker(project, dispatch);

  const catalog = useStableCatalog();
  const pipelines = usePipelines();
  const loadError = pipelines.data ? catalog.error : (pipelines.error ?? catalog.error);
  const loadErrorText = loadError ? errorText(loadError) : null;
  const engine = useMemo<ImageEngine>(() => {
    const status = pipelines.data && catalog.data ? "ready" : loadErrorText ? "error" : "loading";
    return {
      status,
      error: status === "error" ? loadErrorText : null,
      routes: deriveImageRoutes(pipelines.data?.items, catalog.data),
      videoRoutes: deriveStudioRoutes(pipelines.data?.items, catalog.data),
    };
  }, [pipelines.data, catalog.data, loadErrorText]);
  const lookup = useMemo(() => catalogLookup(catalog.data), [catalog.data]);

  const { blockedReason: runBlockedReason } = useRunSlots();
  const archivedList = useRunList(200, "only");
  const archivedRunIds = useMemo(() => new Set(archivedList.data?.pages.flatMap((page) => page.items.map((run) => run.run_id)) ?? []), [archivedList.data]);
  const { mutateAsync: archiveRun } = useArchiveRun();

  const [params, setParams] = useSearchParams();
  const [compareTakeId, setCompareTakeId] = useState<string | null>(null);
  const [sendTarget, setSendTarget] = useState<SendTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string[] | null>(null);
  const [autoLibrary, setAutoLibrary] = usePersistentFlag("imageStudio.autoLibrary", true);

  const shots = imageShots(project);
  const requestedShot = params.get("shot");
  const selectedShot = shots.find((shot) => shot.image_shot_id === requestedShot) ?? shots[0] ?? null;
  const selectedShotId = selectedShot?.image_shot_id ?? null;
  const requestedTake = params.get("take");
  const selectedTakeId =
    (selectedShot?.takes.some((take) => take.take_id === requestedTake) ? requestedTake : null) ??
    (selectedShot ? (activeImageTake(selectedShot)?.take_id ?? selectedShot.takes.at(-1)?.take_id ?? null) : null);

  const setSearch = useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const selectShot = useCallback(
    (shotId: string | null, takeId: string | null = null) => {
      setCompareTakeId(null);
      setSearch({ shot: shotId, take: takeId });
    },
    [setSearch],
  );

  const selectTake = useCallback((takeId: string | null) => setSearch({ take: takeId }), [setSearch]);

  const addShot = useCallback(() => {
    const current = projectRef.current;
    // The first text-to-image pipeline (a ready one first); none → unassigned, and the Basic tab offers the template
    const route = (engine.status === "ready" ? pickImageRoute(engine.routes, "t2i")?.id : undefined) ?? UNASSIGNED_ROUTE;
    const shot = newImageShot(current, { route });
    // The first image brings the settings panel and the take strip: they slide in from their edge
    if (imageShots(current).length === 0) {
      notePanelToggle(PANEL_NAMES.inspector, { refocus: false });
      notePanelToggle(PANEL_NAMES.takes, { refocus: false });
    }
    dispatch({ type: "addImageShot", shot, afterShotId: selectedShotId });
    setCompareTakeId(null);
    setSearch({ shot: shot.image_shot_id, take: null });
    return shot.image_shot_id;
  }, [dispatch, engine, selectedShotId, setSearch]);

  const onStarted = useCallback((shotId: string, takeId: string | null) => setSearch({ shot: shotId, take: takeId }), [setSearch]);
  const [notSent, setNotSent] = useState<ReadonlyMap<string, string>>(() => new Map());
  const markNotSent = useCallback((shotId: string, reason: string | null) => {
    setNotSent((current) => {
      if (reason === null ? !current.has(shotId) : current.get(shotId) === reason) return current;
      const next = new Map(current);
      if (reason === null) next.delete(shotId);
      else next.set(shotId, reason);
      return next;
    });
  }, []);
  const { busy, generate } = useGenerate({ engine, projectRef, dispatch, notify, autoLibrary, runBlockedReason, markNotSent, onStarted });

  const setRunArchived = useCallback(
    async (runId: string, archived: boolean) => {
      try {
        await archiveRun({ runId, archived });
        notify({ tone: "success", title: archived ? t("已封存這次生成") : t("已取消封存"), detail: archived ? t("檔案與紀錄都保留；勾選「顯示已封存」可以再看到它。") : undefined });
      } catch (error) {
        notify({ tone: "danger", title: archived ? t("封存失敗") : t("取消封存失敗"), detail: errorText(error) });
      }
    },
    [archiveRun, notify],
  );

  const deleteRuns = useCallback((runIds: string[]) => setDeleteTarget(runIds.length > 0 ? [...new Set(runIds)] : null), []);

  const openVideoStudio = useCallback(
    async (shotId?: string | null) => {
      const id = projectRef.current.project_id;
      try {
        await flush();
      } catch (error) {
        notify({ tone: "warning", title: t("沒有切到 Video Studio"), detail: errorText(error) });
        return;
      }
      await navigate(shotId ? videoShotUrl(id, shotId) : `/studio/generate?project=${encodeURIComponent(id)}`);
    },
    [flush, navigate, notify],
  );

  /** 刪除確認框裡的名稱：用到該 run 的圖片名稱與張數。 */
  const runLabel = (runId: string) => {
    const titles = shots.filter((shot) => shot.takes.some((take) => take.run_id === runId));
    const count = shots.reduce((sum, shot) => sum + shot.takes.filter((take) => take.run_id === runId).length, 0);
    if (titles.length === 0) return runIdName(runId);
    return `${formatList(titles.map((shot) => shot.title || shot.image_shot_id))}${count > 1 ? t("（{count} 張）", { count }) : ""}`;
  };

  const onDeleted = (deleted: string[]) => {
    if (deleted.length === 0) return;
    // 主控會移除影片鏡頭中的引用並遞增 revision：重新載入；圖片的 take 若主控沒有移除，這裡補移除（已移除時沒有效果）
    reload()
      .then(() => dispatch({ type: "removeImageTakes", runIds: deleted }))
      .catch((error: unknown) => notify({ tone: "danger", title: t("重新載入專案失敗"), detail: errorText(error) }));
  };

  const getProject = useCallback(() => projectRef.current, []);

  const value = useMemo<ImageStudioContextValue>(
    () => ({
      project,
      getProject,
      dispatch,
      flush,
      catalog: catalog.data,
      engine,
      lookup,
      selectedShotId,
      selectShot,
      selectedTakeId,
      selectTake,
      compareTakeId,
      setCompareTakeId,
      busy,
      runBlockedReason,
      notSent,
      runs,
      setEngineOpen,
      generate,
      addShot,
      autoLibrary,
      setAutoLibrary,
      archivedRunIds,
      setRunArchived,
      deleteRuns,
      sendTarget,
      setSendTarget,
      openVideoStudio,
      notify,
    }),
    [
      project,
      getProject,
      dispatch,
      flush,
      catalog.data,
      engine,
      lookup,
      selectedShotId,
      selectShot,
      selectedTakeId,
      selectTake,
      compareTakeId,
      busy,
      runBlockedReason,
      notSent,
      runs,
      setEngineOpen,
      generate,
      addShot,
      autoLibrary,
      setAutoLibrary,
      archivedRunIds,
      setRunArchived,
      deleteRuns,
      sendTarget,
      openVideoStudio,
      notify,
    ],
  );

  return (
    <StudioShellContext.Provider value={shell}>
      <ImageStudioContext.Provider value={value}>
        {children}
        <RunDeleteDialog
          runIds={deleteTarget ?? []}
          open={deleteTarget !== null}
          onOpenChange={(open) => (open ? undefined : setDeleteTarget(null))}
          labelOf={runLabel}
          outputKind="image"
          beforeDelete={flush}
          onDone={onDeleted}
        />
      </ImageStudioContext.Provider>
    </StudioShellContext.Provider>
  );
}
