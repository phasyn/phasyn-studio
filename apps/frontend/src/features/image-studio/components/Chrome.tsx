// Image Studio's frame, composed like Video Studio's: a 56 px toolbar with no badges — left the project manager (the
// project list Video Studio uses: switching or creating a project here is the same list) and the asset library; right
// the switch to Video Studio, the main action「生成圖片」(the toolbar's only gradient) and the engine button, whose
// route summary stays in its tooltip and accessible name. Narrower than its content (measured, so it holds for any
// language and project title; useFitLevel), the toolbar first shows only the icon of the Video Studio switch, then lets
// the project title truncate. Saving shows nothing while it works (the shell's failure banner speaks when it does not).
// The status bar counts the images and their state; the route's state is on the engine button.
import { Clapperboard, Images, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { StudioProjectSummary } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { newProject } from "@/features/studio";
import { NewProjectForm, ProjectSwitcher, type NewProjectFormProps } from "@/features/studio-shell";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { useFitLevel } from "@/lib/useFitLevel";
import { useImageStudio } from "../imageStudioContext";
import { engineSummary } from "../model/engine";
import { changedSinceTake } from "../model/params";
import { findImageRoute, pickImageRoute } from "../model/routes";
import { imageRunsInProgress, imageShots, imageShotStatus } from "../model/shots";
import { imagePath } from "../support";
import { GenerateControl } from "./GenerateControl";
import { ImageLibrary } from "./LibraryDialog";
import { ReadyDot } from "./marks";
import { t } from "@/i18n";

const TOOLBAR_FIT_LEVELS = 2;

/** 建立新專案（與 Video Studio 同一份專案清單；影片格式用 Video Studio 的預設，圖片尺寸各自設定）。 */
export function ImageProjectForm({ onCreated, initialFocus }: { onCreated: (projectId: string) => void; initialFocus?: NewProjectFormProps["initialFocus"] }) {
  return <NewProjectForm build={(title) => newProject(title)} onCreated={onCreated} initialFocus={initialFocus} placeholder={t("例如：角色設定與換角")} />;
}

const projectMeta = (item: StudioProjectSummary) => t("{shot_count} 個影片鏡頭・{updated_at}", { shot_count: item.shot_count, updated_at: formatTimestamp(item.updated_at) });

function ProjectMenu() {
  const { project, openVideoStudio } = useImageStudio();
  const navigate = useNavigate();
  const open = (projectId: string) => void navigate(imagePath(projectId));
  return (
    <ProjectSwitcher
      description={t("Image Studio 與 Video Studio 共用同一個專案與素材庫：在這裡生成的圖片，可以直接用在同一個專案的影片鏡頭。")}
      // The pill truncates a long title: the tooltip gives it in full
      hint={t("{title}\n切換專案或新增專案（與 Video Studio 共用）", { title: project.title })}
      metaOf={projectMeta}
      onSelect={open}
      renderDetails={(_item, current, close) =>
        current ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Clapperboard aria-hidden />}
            onClick={() => {
              close();
              void openVideoStudio();
            }}
          >
            {t("在 Video Studio 開啟這個專案")}
          </Button>
        ) : null
      }
      renderCreate={(close) => (
        <ImageProjectForm
          onCreated={(projectId) => {
            close();
            open(projectId);
          }}
        />
      )}
    />
  );
}

/**
 * 目前圖片的路由與引擎摘要；沒有選取圖片時是新圖片會用的那個（同模式第一個，就緒的優先），讓按鈕上的狀態點有意義。
 */
function useCurrentImageRoute() {
  const { project, selectedShotId, engine } = useImageStudio();
  const shot = imageShots(project).find((item) => item.image_shot_id === selectedShotId) ?? null;
  const route = shot ? findImageRoute(engine.routes, shot.route) : (pickImageRoute(engine.routes, "t2i") ?? null);
  const routeId = shot?.route ?? route?.id ?? "";
  return { route, summary: engineSummary(engine.status, engine.error, route, routeId, engine.routes.length === 0) };
}

/** 先保存再切到同一個專案的 Video Studio（保存失敗或衝突時留在這裡，原因由通知說明）。 */
function VideoStudioSwitch({ iconOnly }: { iconOnly: boolean }) {
  const { openVideoStudio } = useImageStudio();
  const [leaving, setLeaving] = useState(false);
  return (
    <Button
      size="sm"
      variant="quiet"
      icon={<Clapperboard aria-hidden />}
      pending={leaving}
      aria-label={iconOnly ? "Video Studio" : undefined}
      title={t("先保存，再切到同一個專案的 Video Studio")}
      className={iconOnly ? "w-8 px-0" : undefined}
      onClick={() => {
        if (leaving) return;
        setLeaving(true);
        void openVideoStudio().finally(() => setLeaving(false));
      }}
    >
      {iconOnly ? null : "Video Studio"}
    </Button>
  );
}

function EngineButton() {
  const { setEngineOpen } = useImageStudio();
  const { route, summary } = useCurrentImageRoute();
  return (
    <Button size="sm" variant="secondary" onClick={() => setEngineOpen(true)} title={t("查看與啟動目前圖片的元件組合需要的元件\n{title}", { title: summary.title })} className="min-w-0 shrink">
      <ReadyDot ready={summary.ready} />
      <span className="truncate">{t("生成引擎")}</span>
      <span className="sr-only">
        {route ? t("{label}・", { label: route.label }) : ""}
        {summary.text}
      </span>
    </Button>
  );
}

export function Toolbar() {
  const { project, selectedShotId } = useImageStudio();
  const batch = imageShots(project).find((item) => item.image_shot_id === selectedShotId)?.batch ?? 0;
  const toolbarRef = useRef<HTMLDivElement>(null);
  const fit = useFitLevel(toolbarRef, TOOLBAR_FIT_LEVELS, `${project.title}\u0000${batch}`);
  const tight = fit >= TOOLBAR_FIT_LEVELS;
  return (
    <div ref={toolbarRef} data-fit={fit} className="flex h-14 shrink-0 items-center justify-between gap-3 px-3">
      {/* 第 2 級之前兩邊都不縮（不夠寬時才量得到並進到下一級；那時專案名稱才可以截斷） */}
      <div className={cn("flex items-center gap-3", tight ? "min-w-0" : "*:shrink-0")}>
        <ProjectMenu />
        <span aria-hidden className="h-6 w-px shrink-0 bg-line-subtle" />
        <ImageLibrary />
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2.5">
        <VideoStudioSwitch iconOnly={fit >= 1} />
        <GenerateControl />
        <EngineButton />
      </div>
    </div>
  );
}

export function StatusBar() {
  const { project } = useImageStudio();
  const shots = imageShots(project);
  const takes = shots.reduce((sum, item) => sum + item.takes.filter((take) => take.state === "succeeded").length, 0);
  const running = imageRunsInProgress(project).length;
  const stale = shots.filter((item) => imageShotStatus(item, (take) => changedSinceTake(take, item)) === "stale").length;
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 px-3 text-caption text-fg-tertiary">
      <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
        <Images aria-hidden className="size-3 shrink-0 text-brand-cyan/70" />
        {t("圖片 {shotsCount}・完成 {takes} 張", { shotsCount: shots.length, takes })}
      </span>
      {stale > 0 || running > 0 ? <span aria-hidden className="h-3 w-px bg-line-subtle" /> : null}
      {stale > 0 ? <span className="text-warning">{t("設定已變更 {stale}", { stale })}</span> : null}
      {running > 0 ? (
        <span className="inline-flex items-center gap-1 text-info">
          <LoaderCircle aria-hidden className="size-3 animate-spin" />
          {t("生成中 {running} 個 run", { running })}
        </span>
      ) : null}
    </footer>
  );
}
