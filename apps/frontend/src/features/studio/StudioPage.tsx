import { FolderX } from "lucide-react";
import { Suspense, useEffect } from "react";
import { Link, Navigate, useLocation, useParams, useSearchParams } from "react-router";
import type { StudioProject } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import { useProjectQuery } from "@/api/studioProjects";
import { EmptyState } from "@/components/common/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { useContentSwapMotion } from "@/components/ui/motion";
import { ConflictBanner, LoadingPanels, SaveFailureBanner, StudioNotices } from "@/features/studio-shell";
import { Centered, ProjectHome } from "./work/ProjectHome";
import { StatusBar } from "./components/chrome/StatusBar";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { StudioToolbar } from "./components/chrome/StudioToolbar";
import { VideoEngineSheet } from "./components/chrome/VideoEngineSheet";
import { StudioProvider } from "./StudioProvider";
import { fallbackWorkspace, findWorkspace, type StudioWorkspace } from "./workspaces";
import { t, tServer } from "@/i18n";
import { LazyBoundary } from "@/components/common/LazyBoundary";

function StudioFrame({ workspace }: { workspace: StudioWorkspace }) {
  const { Component } = workspace;
  const workspaceSwap = useContentSwapMotion<HTMLDivElement>();
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      <StudioToolbar workspace={workspace.id} />
      <ConflictBanner />
      <SaveFailureBanner />
      <div ref={workspaceSwap} className="flex min-h-0 flex-1 flex-col">
        <LazyBoundary className="m-4">
          <Suspense fallback={<LoadingPanels immediate label={t("載入「{label}」工作區…", { label: workspace.label })} panels={workspace.id === "edit" ? 3 : 2} />}>
            <Component />
          </Suspense>
        </LazyBoundary>
      </div>
      <StatusBar />
      <StudioNotices />
      <VideoEngineSheet />
      <ShortcutsDialog />
    </div>
  );
}

function LoadedProject({ project, workspace }: { project: StudioProject; workspace: StudioWorkspace }) {
  return (
    <StudioProvider key={project.project_id} initial={project}>
      <StudioFrame workspace={workspace} />
    </StudioProvider>
  );
}

/**
 * 開啟專案的第一個畫面：與載入後同形的工具列、工作區面板與狀態列骨架，從第一幀就出現（主畫面不會先空白），
 * 專案讀到後由真正的版面原位取代。
 */
function OpeningProject({ workspace }: { workspace: StudioWorkspace }) {
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      <div aria-hidden className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3">
        <Skeleton className="h-6 w-full max-w-48" />
        <Skeleton className="hidden h-10 w-72 rounded-full md:block" />
        <div className="flex justify-end gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="hidden h-8 w-24 sm:block" />
        </div>
      </div>
      <LoadingPanels immediate label={t("開啟專案…")} panels={workspace.id === "edit" ? 3 : 2} />
      <div aria-hidden className="flex h-7 shrink-0 items-center px-3">
        <Skeleton className="h-3 w-40" />
      </div>
    </div>
  );
}

/**
 * 開啟一個專案（每個專案一個實例：換專案時重新掛載）。每次開啟都重新讀取一次再建立文件：快取可能比 Image Studio
 * 或其他分頁剛保存的版本舊（讀取會先等這個分頁對同一個專案在途的保存，見 api.ts）。已經有資料時重新讀取失敗不擋開啟。
 */
function ProjectOpener({ projectId, workspace }: { projectId: string; workspace: StudioWorkspace }) {
  const project = useProjectQuery(projectId);
  // 工作區的 chunk 與專案一起讀（不等專案讀完才開始下載）
  useEffect(() => {
    void workspace.preload();
  }, [workspace]);
  if (!project.data) {
    if (!project.isError) return <OpeningProject workspace={workspace} />;
    const missing = isApiError(project.error) && project.error.status === 404;
    return (
      <Centered>
        <div className="panel w-full max-w-md">
          <EmptyState
            icon={<FolderX className="text-warning" />}
            title={missing ? t("找不到這個專案") : t("無法讀取專案")}
            description={missing ? t("它可能已被刪除。") : isApiError(project.error) ? tServer(project.error.message) : t("請稍後重試。")}
            action={<Link to={`/studio/${workspace.id}`}>{t("回到專案列表")}</Link>}
          />
        </div>
      </Centered>
    );
  }
  if (project.isFetching && !project.isFetchedAfterMount) return <OpeningProject workspace={workspace} />;
  return <LoadedProject project={project.data} workspace={workspace} />;
}

export function StudioPage() {
  const params = useParams();
  const location = useLocation();
  const [search] = useSearchParams();
  const projectId = search.get("project");
  const spec = findWorkspace(params["workspace"]);

  // An unknown or removed workspace (the old /studio/effects) opens its successor and keeps project=, shot= and the rest
  if (!spec) return <Navigate to={`/studio/${fallbackWorkspace(params["workspace"])}${location.search}${location.hash}`} replace />;
  if (!(projectId != null && projectId !== "")) return <ProjectHome workspace={spec.id} focusNew={search.get("new") === "1"} />;
  return <ProjectOpener key={projectId} projectId={projectId} workspace={spec} />;
}
