// The project list page (/studio/<workspace> with no ?project=): the same project table as the project manager
// (search, sortable columns: name, shots, rendered, updated, created) on the left; on the right the picked project's
// facts with 「開啟專案」, or the new-project form when nothing is picked. 「匯入可攜包」 sits with the search row. It never
// opens a project by itself — opening reads and autosaves it, which happens only after the person chooses it. With no
// project at all it is the welcome card (create, or import a package). Look: the Aurora backdrop (a brand moment), one
// raised panel that fits the window, the table scrolling inside it.
import { FolderPlus, LoaderCircle, PackageOpen } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { StudioProjectSummary } from "@/api/generated/contracts";
import { useStudioProjects } from "@/api/studioProjects";
import { AreaIcon } from "@/components/common/AreaIcon";
import { AuroraBackdrop } from "@/components/common/AuroraBackdrop";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { RISE_IN } from "@/components/ui/look";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ProjectPreview, ProjectRemovalPanel, ProjectTable } from "@/features/studio-shell";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { VideoProjectForm } from "../components/chrome/ProjectMenu";
import { PortableImportDialog } from "../components/PortableProject";
import { projectHref, type StudioWorkspace } from "../workspaces";
import { useFilmProgress } from "../hooks/useFilmProgress";

type Workspace = StudioWorkspace["id"];

/**
 * 專案首頁與開啟畫面（App 的首頁、品牌時刻）的底：先是深空漸層，再疊上 three.js 極光（AuroraBackdrop），內容是一欄可捲動的區塊。
 * 不在編輯區使用。
 */
export function Landing({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="relative isolate h-full">
      <AuroraBackdrop />
      <div className={cn("h-full overflow-y-auto p-6", className)}>{children}</div>
    </div>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <Landing className="grid place-items-center">{children}</Landing>;
}

const projectMeta = (item: StudioProjectSummary) =>
  // The rendered count is the table's 已渲染 column (the Studio's own count); the tooltip does not repeat the summary's
  t("{shot_count} 個鏡頭・{updated_at}", { shot_count: item.shot_count, updated_at: formatTimestamp(item.updated_at) });

function ImportButton({ onImported, size = "sm" }: { onImported: (projectId: string) => void; size?: "sm" | "md" }) {
  return (
    <PortableImportDialog
      onImported={onImported}
      trigger={
        <Button size={size} variant="secondary" icon={<PackageOpen aria-hidden />}>
          {t("匯入可攜包")}
        </Button>
      }
    />
  );
}

function Welcome({ workspace, focusNew }: { workspace: Workspace; focusNew: boolean }) {
  const navigate = useNavigate();
  const open = (projectId: string) => void navigate(projectHref(workspace, projectId), { replace: true });
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
        <VideoProjectForm initialFocus={focusNew ? "always" : "unless-focused"} onCreated={open} />
        <div className="flex items-center gap-2 border-t border-line-subtle pt-3 text-caption text-fg-tertiary">
          <span className="min-w-0 flex-1">{t("從另一個工作站帶來專案？")}</span>
          <ImportButton onImported={open} />
        </div>
      </div>
    </Centered>
  );
}

/**
 * /studio（沒有指定專案）：專案表格＋新增專案。不會自動開啟最近的專案——開啟專案會讀取並自動儲存它
 * （例如把舊的路由 ID 對應到目前的元件組合），只在使用者選了它之後才發生。
 */
export function ProjectHome({ workspace, focusNew }: { workspace: Workspace; focusNew: boolean }) {
  const navigate = useNavigate();
  const projects = useStudioProjects();
  const [picked, setPicked] = useState<string | null>(null);
  const [removing, setRemoving] = useState<StudioProjectSummary[] | null>(null);
  const [removalRunning, setRemovalRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return undefined;
    const timer = window.setTimeout(() => { setNotice(null); }, 8000);
    return () => { window.clearTimeout(timer); };
  }, [notice]);
  const open = (projectId: string) => void navigate(projectHref(workspace, projectId));
  if (projects.isPending) {
    return (
      <Centered>
        <p role="status" className="flex items-center gap-2 text-data text-fg-secondary">
          <LoaderCircle aria-hidden className="size-4 animate-spin text-brand-cyan" />
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
  const items = projects.data.items;
  if (items.length === 0) return <Welcome workspace={workspace} focusNew={focusNew} />;
  const selected = items.find((item) => item.project_id === picked) ?? null;
  return (
    <Landing className="flex flex-col">
      <div className={cn("mx-auto flex min-h-0 w-full max-w-[min(76rem,100%)] flex-1 flex-col gap-4", RISE_IN)}>
        <header className="flex shrink-0 items-center gap-3 px-1">
          <AreaIcon area="video" size={40} />
          <div className="grid min-w-0 flex-1">
            <p className="text-caption font-medium tracking-[0.24em] text-fg-tertiary uppercase">Phasyn Studio</p>
            <h1 className="text-page font-semibold text-fg">{t("專案")}</h1>
          </div>
          <Button variant="primary" size="sm" icon={<FolderPlus aria-hidden />} aria-pressed={selected === null} onClick={() => { setPicked(null); }}>
            {t("新增專案")}
          </Button>
        </header>
        <div className="panel panel-raised grid min-h-[28rem] flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-h-0 min-w-0 flex-col border-line-subtle lg:border-r">
            {projects.isError ? <p className="px-6 pt-3 text-caption text-warning">{t("重新讀取專案列表失敗；顯示的是上一次讀到的列表。")}</p> : null}
            <ProjectTable pickedId={selected?.project_id ?? null} onPick={setPicked} onOpen={open} metaOf={projectMeta} useProgress={useFilmProgress} actions={<ImportButton onImported={open} />} onRequestRemove={(next) => { setNotice(null); setRemoving(next); }} locked={removalRunning} notice={notice} />
          </div>
          <aside aria-label={selected ? t("專案資訊") : t("新增專案")} className="grid min-h-0 content-start gap-4 overflow-y-auto px-5 py-4">
            {selected ? (
              <ProjectPreview key={selected.project_id} item={selected} current={false} title={selected.title || t("未命名專案")} onOpen={() => { open(selected.project_id); }} />
            ) : (
              <>
                <h2 className="flex items-center gap-2 text-section font-semibold text-fg">
                  <FolderPlus aria-hidden className="size-4 text-brand-cyan" />
                  {t("新增專案")}
                </h2>
                {/* 從命令面板「新增 Studio 專案」（?new=1）進來時聚焦名稱欄；已在這頁時換 key 重新掛載才會聚焦 */}
                <VideoProjectForm key={focusNew ? "focus" : "plain"} initialFocus={focusNew ? "always" : undefined} onCreated={open} />
                <p className="text-caption text-fg-tertiary">{t("在左側點一下專案查看資訊，按兩下直接開啟。")}</p>
              </>
            )}
          </aside>
        </div>
      </div>
      {/* 多選移除的確認（只有一層對話框）；移除進行中不能關閉 */}
      <Dialog open={removing !== null} onOpenChange={(next) => { if (!next && !removalRunning) setRemoving(null); }}>
        <DialogContent closeDisabled={removalRunning}>
          {removing ? <ProjectRemovalPanel items={removing} layout="dialog" onClose={() => { setRemoving(null); }} onRunningChange={setRemovalRunning} onRemoved={(message) => { setRemoving(null); setPicked(null); setNotice(message); }} /> : null}
        </DialogContent>
      </Dialog>
    </Landing>
  );
}
