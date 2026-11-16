// Image Studio（路由 /image?project=&shot=&take=）：與影片 Studio 共用同一個專案與素材庫。沒有指定專案時開啟最近的
// 專案；開啟時一律重新讀取一次專案（影片 Studio 剛保存的版本才不會被舊的快取蓋過），讀到才建立文件。
import { FolderX, Images, LoaderCircle, RotateCcw } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { isApiError } from "@/api/http";
import { useProjectQuery, useStudioProjects } from "@/api/studioProjects";
import { AuroraBackdrop } from "@/components/common/AuroraBackdrop";
import { BrandMark } from "@/components/common/BrandMark";
import { EmptyState } from "@/components/common/EmptyState";
import { EN_LABEL } from "@/components/ui/look";
import { useContentSwapMotion } from "@/components/ui/motion";
import { buttonVariants } from "@/components/ui/variants";
import { ConflictBanner, SaveFailureBanner, StudioNotices } from "@/features/studio-shell";
import { ImageProjectForm, StatusBar, Toolbar } from "./components/Chrome";
import { ImageEngineSheet } from "./components/EngineSheet";
import { Workspace } from "./components/Workspace";
import { useImageStudio } from "./imageStudioContext";
import { ImageStudioProvider } from "./ImageStudioProvider";
import { imagePath } from "./support";
import { t, tServer } from "@/i18n";
import { LazyBoundary } from "@/components/common/LazyBoundary";

// "Use in a video shot" loads when it is first opened and then stays mounted (so it can animate closed)
const SendToVideoDialog = lazy(() => import("./components/SendToVideoDialog").then((m) => ({ default: m.SendToVideoDialog })));

function SendToVideo() {
  const { sendTarget } = useImageStudio();
  const [wanted, setWanted] = useState(false);
  if (sendTarget !== null && !wanted) setWanted(true);
  return wanted ? (
    <LazyBoundary className="fixed bottom-4 right-4 z-50 max-w-sm">
      <Suspense fallback={null}>
        <SendToVideoDialog />
      </Suspense>
    </LazyBoundary>
  ) : null;
}

/** 置中的品牌時刻（讀取、第一次使用、找不到專案）：深空底與 three.js 極光（與 Video Studio 的開啟畫面相同；不在工作區內）。 */
function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate h-full">
      <AuroraBackdrop />
      <div className="grid h-full place-items-center overflow-y-auto p-6">{children}</div>
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <Centered>
      <div className="grid justify-items-center gap-3 animate-fade-in">
        <BrandMark size={44} glow breathing />
        <p role="status" className="flex items-center gap-2 text-data text-fg-secondary">
          <LoaderCircle aria-hidden className="size-4 text-brand-cyan animate-spin" />
          {text}
        </p>
      </div>
    </Centered>
  );
}

function Welcome() {
  const navigate = useNavigate();
  return (
    <Centered>
      <div className="panel panel-raised border-brand-gradient grid w-full max-w-md gap-5 p-6 animate-rise-in">
        <div className="grid justify-items-center gap-3 text-center">
          <BrandMark size={56} glow />
          <p aria-hidden className={`${EN_LABEL} inline-flex items-center gap-1.5 text-brand-cyan/85`}>
            <Images className="size-3.5" />
            Image Studio
          </p>
          <h1 className="text-page font-semibold text-fg">{t("建立第一個專案")}</h1>
          <p className="max-w-[40ch] text-data text-fg-secondary">{t("專案同時包含圖片與影片鏡頭：先在這裡生成角色圖，再一鍵用在影片鏡頭（ref2va 參考圖）。")}</p>
        </div>
        {/* This card appears once the list has loaded: the title field takes focus only if nothing else has been focused */}
        <ImageProjectForm initialFocus="unless-focused" onCreated={(projectId) => void navigate(imagePath(projectId), { replace: true })} />
      </div>
    </Centered>
  );
}

function Frame() {
  const swap = useContentSwapMotion<HTMLDivElement>();
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      <Toolbar />
      <ConflictBanner />
      <SaveFailureBanner />
      <div ref={swap} className="flex min-h-0 flex-1 flex-col">
        <Workspace />
      </div>
      <StatusBar />
      <StudioNotices />
      <ImageEngineSheet />
      <SendToVideo />
    </div>
  );
}

export function ImageStudioPage() {
  const [search] = useSearchParams();
  const projectId = search.get("project");
  const projects = useStudioProjects();
  // 與影片 Studio 同一個 query key；開啟時一定重新讀取一次，讀到之後才建立文件（不用可能過時的快取當起點）
  const project = useProjectQuery(projectId);

  if (!projectId) {
    if (projects.isPending) return <Loading text={t("讀取專案…")} />;
    const latest = projects.data?.items[0];
    if (latest) return <Navigate to={imagePath(latest.project_id)} replace />;
    if (projects.isError) {
      return (
        <Centered>
          <div role="alert" className="panel grid w-full max-w-md justify-items-center gap-3 p-6 text-center animate-rise-in">
            <span aria-hidden className="grid size-11 place-items-center rounded-xl border border-danger/40 bg-danger/12 text-danger">
              <FolderX className="size-5" />
            </span>
            <p className="text-section font-semibold text-fg">{t("讀取專案列表失敗")}</p>
            <p className="text-data text-fg-secondary [overflow-wrap:anywhere]">{isApiError(projects.error) ? tServer(projects.error.message) : t("請稍後重試")}</p>
            <button type="button" onClick={() => void projects.refetch()} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              <RotateCcw aria-hidden />
              {t("重新讀取")}
            </button>
          </div>
        </Centered>
      );
    }
    return <Welcome />;
  }
  // 已經有資料時，背景重新讀取失敗不卸載文件（未保存的編輯還在）；只有完全讀不到時才顯示錯誤
  if (!project.data) {
    if (project.isError) {
      const missing = isApiError(project.error) && project.error.status === 404;
      return (
        <Centered>
          <div className="panel w-full max-w-md">
            <EmptyState
              icon={<FolderX />}
              title={missing ? t("找不到這個專案") : t("無法讀取專案")}
              description={missing ? t("它可能已被刪除。") : isApiError(project.error) ? tServer(project.error.message) : t("請稍後重試。")}
              action={
                <a href="/image" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  {t("回到最近的專案")}
                </a>
              }
            />
          </div>
        </Centered>
      );
    }
    return <Loading text={t("開啟專案…")} />;
  }
  // 第一次開啟：等這次重新讀取完成（快取可能比影片 Studio 剛保存的版本舊）
  if (project.isFetching && !project.isFetchedAfterMount) return <Loading text={t("開啟專案…")} />;
  return (
    <ImageStudioProvider key={project.data.project_id} initial={project.data}>
      <Frame />
    </ImageStudioProvider>
  );
}
