import { ChevronRight, Clapperboard, FolderKanban, FolderPlus, FolderX, LoaderCircle } from "lucide-react";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import type { StudioProject, StudioProjectSummary } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import { useProjectQuery, useStudioProjects } from "@/api/studioProjects";
import { AreaIcon } from "@/components/common/AreaIcon";
import { AuroraBackdrop } from "@/components/common/AuroraBackdrop";
import { BrandMark } from "@/components/common/BrandMark";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { LIFT, RISE_IN } from "@/components/ui/look";
import { reveal, useContentSwapMotion } from "@/components/ui/motion";
import { ConflictBanner, LoadingPanels, SaveFailureBanner, StudioNotices } from "@/features/studio-shell";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { VideoProjectForm } from "./components/chrome/ProjectMenu";
import { StatusBar } from "./components/chrome/StatusBar";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { StudioToolbar } from "./components/chrome/StudioToolbar";
import { VideoEngineSheet } from "./components/chrome/VideoEngineSheet";
import { StudioProvider } from "./StudioProvider";
import { fallbackWorkspace, findWorkspace, projectHref, type StudioWorkspace } from "./workspaces";
import { t, tServer } from "@/i18n";
import { T } from "@/i18n/T";
import { LazyBoundary } from "@/components/common/LazyBoundary";

type Workspace = StudioWorkspace["id"];

/**
 * 專案首頁與開啟畫面（App 的首頁、品牌時刻）的底：先是深空漸層，再疊上 three.js 極光（AuroraBackdrop），內容是一欄可捲動的區塊。
 * 不在編輯區使用。
 */
function Landing({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="relative isolate h-full">
      <AuroraBackdrop />
      <div className={cn("h-full overflow-y-auto p-6", className)}>{children}</div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <Landing className="grid place-items-center">{children}</Landing>;
}

function Welcome({ workspace, focusNew }: { workspace: Workspace; focusNew: boolean }) {
  const navigate = useNavigate();
  return (
    <Centered>
      <div className={cn("panel panel-raised grid w-full max-w-md gap-2 p-6 pt-2", RISE_IN)}>
        <EmptyState
          illustration="frames"
          size="compact"
          title={<span className="block text-section">{t("建立第一個專案")}</span>}
          description={t("專案是一組鏡頭與一條時間軸：寫 prompt、渲染、挑 take、排序裁切，再匯出成一支影片。Image Studio 用同一個專案與素材庫生成圖片。")}
          className="px-0"
        />
        {/* This card appears once the list has loaded: unless the user asked for a new project (?new=1), the title field
            takes focus only if nothing else has been focused in the meantime */}
        <VideoProjectForm initialFocus={focusNew ? "always" : "unless-focused"} onCreated={(projectId) => void navigate(projectHref(workspace, projectId), { replace: true })} />
      </div>
    </Centered>
  );
}

function ProjectRow({ item, workspace, index }: { item: StudioProjectSummary; workspace: Workspace; index: number }) {
  return (
    <li ref={reveal(index)} className={cn(LIFT, "rounded-lg")}>
      <Link
        to={projectHref(workspace, item.project_id)}
        className="group pressable grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border border-line-subtle bg-canvas/60 px-3 py-2.5 text-left no-underline hover:border-brand-blue/45 hover:bg-raised/60 active:bg-sunken focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
      >
        <span aria-hidden className="grid size-8 place-items-center rounded-md bg-entity/12 text-entity ring-1 ring-entity/25 ring-inset">
          <FolderKanban className="size-4" />
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-data text-fg">{item.title || t("未命名專案")}</span>
          <span className="truncate text-caption text-fg-tertiary">
            <T source={"{shot_count} 個鏡頭・已渲染 {rendered_shot_count}・更新 {updated_at}<0>・{project_id}</0>"} values={{ shot_count: item.shot_count, rendered_shot_count: item.rendered_shot_count, updated_at: formatTimestamp(item.updated_at), project_id: item.project_id }} slots={[<span className="machine" />]} />
          </span>
        </span>
        <ChevronRight aria-hidden className="size-4 text-fg-tertiary transition-colors duration-(--duration-fast) group-hover:text-brand-cyan" />
      </Link>
    </li>
  );
}

/**
 * /studio（沒有指定專案）：專案列表＋新增專案。不會自動開啟最近的專案——開啟專案會讀取並自動儲存它
 * （例如把舊的路由 ID 對應到目前的元件組合），只在使用者選了它之後才發生。
 */
function ProjectHome({ workspace, focusNew }: { workspace: Workspace; focusNew: boolean }) {
  const navigate = useNavigate();
  const projects = useStudioProjects();
  if (projects.isPending) {
    return (
      <Centered>
        <p role="status" className="flex items-center gap-2 text-data text-fg-secondary">
          <LoaderCircle aria-hidden className="size-4 text-brand-cyan animate-spin" />
          {t("讀取專案…")}
        </p>
      </Centered>
    );
  }
  if (projects.isError && !projects.data) {
    return (
      <Centered>
        <div className="w-full max-w-md">
          <ErrorCallout error={projects.error} title={t("無法讀取專案列表")} onRetry={() => void projects.refetch()} retrying={projects.isFetching} />
        </div>
      </Centered>
    );
  }
  const items = projects.data?.items ?? [];
  if (items.length === 0) return <Welcome workspace={workspace} focusNew={focusNew} />;
  return (
    <Landing>
      <div className={cn("mx-auto grid w-full max-w-4xl gap-4", RISE_IN)}>
        <header className="flex items-center gap-3 px-1">
          <AreaIcon area="video" size={40} />
          <div className="grid">
            <p className="text-caption font-medium tracking-[0.24em] text-fg-tertiary uppercase">Phasyn Studio</p>
            <p className="text-page font-semibold text-fg">Video Studio</p>
          </div>
        </header>
        <div className="grid w-full gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
          <section aria-labelledby="studio-projects-title" className="panel panel-raised grid content-start gap-3 p-4">
            <div className="grid gap-1">
              <h1 id="studio-projects-title" className="flex items-center gap-2 text-section font-semibold text-fg">
                <Clapperboard aria-hidden className="size-4 text-brand-cyan" />
                <T source={"專案<0>{itemsCount}</0>"} values={{ itemsCount: items.length }} slots={[<span className="machine text-caption font-normal text-fg-tertiary" />]} />
              </h1>
              <p className="text-caption text-fg-tertiary">{t("選一個專案在 Video Studio 開啟（依最近更新排序；Image Studio 共用同一份專案）。開啟後才會讀取並自動儲存它；這裡不會自動開啟任何專案。")}</p>
            </div>
            {projects.isError ? <p className="text-caption text-warning">{t("重新讀取專案列表失敗；顯示的是上一次讀到的列表。")}</p> : null}
            <ul aria-label={t("專案列表")} className="grid gap-2">
              {items.map((item, index) => (
                <ProjectRow key={item.project_id} item={item} index={index} workspace={workspace} />
              ))}
            </ul>
          </section>
          <section aria-labelledby="studio-new-project" className="panel grid content-start gap-3 p-4">
            <h2 id="studio-new-project" className="flex items-center gap-2 text-data font-semibold text-fg">
              <FolderPlus aria-hidden className="size-4 text-brand-cyan" />
              {t("新增專案")}
            </h2>
            {/* 從命令面板「新增 Studio 專案」（?new=1）進來時聚焦名稱欄；已在這頁時換 key 重新掛載才會聚焦 */}
            <VideoProjectForm key={focusNew ? "focus" : "plain"} initialFocus={focusNew ? "always" : undefined} onCreated={(projectId) => void navigate(projectHref(workspace, projectId))} />
          </section>
        </div>
      </div>
    </Landing>
  );
}

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
          <Suspense fallback={<LoadingPanels label={t("載入「{label}」工作區…", { label: workspace.label })} panels={workspace.id === "edit" ? 3 : 2} />}>
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

/** 開啟專案的等待畫面：通常只有一次讀取的時間，200 ms 內完成就不顯示文字（避免畫面閃一下）；之後顯示「開啟專案…」。 */
function OpeningProject() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <Centered>
      {visible ? (
        <div className="grid justify-items-center gap-3 animate-fade-in">
          <BrandMark size={44} glow breathing />
          <p role="status" className="flex items-center gap-2 text-data text-fg-secondary">
            <LoaderCircle aria-hidden className="size-4 text-brand-cyan animate-spin" />
            {t("開啟專案…")}
          </p>
        </div>
      ) : null}
    </Centered>
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
    if (!project.isError) return <OpeningProject />;
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
  if (project.isFetching && !project.isFetchedAfterMount) return <OpeningProject />;
  return <LoadedProject project={project.data} workspace={workspace} />;
}

export function StudioPage() {
  const params = useParams();
  const location = useLocation();
  const [search] = useSearchParams();
  const projectId = search.get("project");
  const spec = findWorkspace(params.workspace);

  // An unknown or removed workspace (the old /studio/effects) opens its successor and keeps project=, shot= and the rest
  if (!spec) return <Navigate to={`/studio/${fallbackWorkspace(params.workspace)}${location.search}${location.hash}`} replace />;
  if (!projectId) return <ProjectHome workspace={spec.id} focusNew={search.get("new") === "1"} />;
  return <ProjectOpener key={projectId} projectId={projectId} workspace={spec} />;
}
