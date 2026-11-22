// Project manager of both Studios (the pill in the toolbar opens it): an After-Effects-style project panel with the
// shared project list (the same projects in Video Studio and Image Studio) as a sortable, searchable table on the left
// — name, shots, rendered progress, updated, created. A click (or ↑/↓) only selects a project: the right column
// previews it (facts, and the Studio's settings when it is the current one) with an "Open project" button; a double
// click or Enter opens it. "New project" in the header switches the right column to the Studio's creation form; the
// table's checkboxes and 「移除 N 個專案」 switch it to the removal confirmation (no second dialog level; the open project
// cannot be selected, and the dialog stays open while the removal runs).
// Look: a large sheet; rows reveal with a short stagger; the current project carries the brand mark and a check.
import { ArrowLeft, Check, ChevronDown, FolderInput, FolderKanban, FolderPlus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { StudioProjectSummary } from "@/api/generated/contracts";
import { useStudioProjects } from "@/api/studioProjects";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatTimestamp } from "@/lib/format";
import { ProjectRemovalPanel } from "./ProjectRemoval";
import { ProjectTable, type RenderProgressHook } from "./ProjectTable";
import { useStudioShell } from "./StudioShellContext";
import { t } from "@/i18n";

export interface ProjectSwitcherProps {
  /** Dialog description (what a project is in this Studio). */
  description: string;
  /** Tooltip of the toolbar pill. */
  hint: string;
  /** One-line summary of a project (the row's tooltip). */
  metaOf: (item: StudioProjectSummary) => string;
  onSelect: (projectId: string) => void;
  /** Extra sections under the preview of the selected project (`current`: it is the open project, e.g. its settings). */
  renderDetails?: (item: StudioProjectSummary, current: boolean, close: () => void) => ReactNode;
  /** The Studio's project-creation form (shown after "New project"); `close` closes the dialog before navigating. */
  renderCreate?: (close: () => void) => ReactNode;
  /** The Studio's own rendered count for the 已渲染 column (see ProjectTable). */
  useProgress?: RenderProgressHook;
}

export function ProjectSwitcher({ description, hint, metaOf, onSelect, renderDetails, renderCreate, useProgress }: ProjectSwitcherProps) {
  const { projectId, projectTitle } = useStudioShell();
  const projects = useStudioProjects();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<StudioProjectSummary[] | null>(null);
  const [removalRunning, setRemovalRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return undefined;
    const timer = window.setTimeout(() => { setNotice(null); }, 8000);
    return () => { window.clearTimeout(timer); };
  }, [notice]);
  const close = () => { setOpen(false); };
  const onOpenChange = (next: boolean) => {
    if (!next && removalRunning) return;
    setOpen(next);
    if (next) {
      setPicked(null);
      setCreating(false);
      setRemoving(null);
      setNotice(null);
    }
  };
  const go = (id: string) => {
    close();
    if (id !== projectId) onSelect(id);
  };
  const selectedId = picked ?? projectId;
  const selected = (projects.data?.items ?? []).find((item) => item.project_id === selectedId) ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          // On a phone the pill is narrow enough to end with its ellipsis before the pinned render buttons
          className="group/project pressable inline-flex h-10 max-w-64 min-w-0 shrink items-center max-md:max-w-40 gap-2 rounded-full border border-line-subtle bg-surface/80 pr-2.5 pl-1 text-data text-fg shadow-edge hover:border-line-strong hover:bg-raised active:bg-sunken aria-expanded:border-brand-blue/60 [&_svg]:size-3.5"
          title={hint}
        >
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-entity/15 text-entity">
            <FolderKanban />
          </span>
          <span className="truncate font-medium">{projectTitle}</span>
          <ChevronDown aria-hidden className="shrink-0 text-fg-tertiary transition-[rotate] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) group-aria-expanded/project:rotate-180" />
        </button>
      </DialogTrigger>
      <DialogContent className="h-[min(48rem,90vh)] max-w-[min(76rem,96vw)]" closeDisabled={removalRunning}>
        <DialogHeader>
          <div className="flex flex-wrap items-start gap-3">
            <div className="grid min-w-0 flex-1 gap-1">
              <DialogTitle>{t("專案")}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </div>
            {renderCreate ? (
              <Button variant="primary" size="sm" icon={<FolderPlus aria-hidden />} onClick={() => { setCreating(true); setRemoving(null); }} aria-pressed={creating} disabled={removalRunning}>
                {t("新增專案")}
              </Button>
            ) : null}
          </div>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-h-0 min-w-0 flex-col border-line-subtle lg:border-r">
            <ProjectTable
              currentId={projectId}
              currentTitle={projectTitle}
              pickedId={selectedId}
              onPick={(id) => {
                setPicked(id);
                setCreating(false);
                if (!removalRunning) setRemoving(null);
              }}
              onOpen={go}
              metaOf={metaOf}
              {...(useProgress ? { useProgress } : {})}
              onRequestRemove={(items) => {
                setCreating(false);
                setNotice(null);
                setRemoving(items);
              }}
              locked={removalRunning}
              notice={notice}
            />
          </div>
          <aside aria-label={removing ? t("移除專案") : creating ? t("新增專案") : t("專案資訊")} className="grid min-h-0 content-start gap-4 overflow-y-auto px-5 py-4">
            {removing ? (
              <ProjectRemovalPanel key={removing.map((item) => item.project_id).join(",")} items={removing} layout="inline" onClose={() => { setRemoving(null); }} onRunningChange={setRemovalRunning} onRemoved={(message) => { setRemoving(null); setPicked(null); setNotice(message); }} />
            ) : creating && renderCreate ? (
              <>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="quiet" icon={<ArrowLeft aria-hidden />} onClick={() => { setCreating(false); }}>
                    {t("返回")}
                  </Button>
                  <h3 className="flex items-center gap-2 text-section font-semibold text-fg">
                    <FolderPlus aria-hidden className="size-4 text-brand-cyan" />
                    {t("新增專案")}
                  </h3>
                </div>
                {renderCreate(close)}
              </>
            ) : selected ? (
              <ProjectPreview item={selected} current={selected.project_id === projectId} title={selected.project_id === projectId ? projectTitle : selected.title} onOpen={() => { go(selected.project_id); }}>
                {renderDetails?.(selected, selected.project_id === projectId, close)}
              </ProjectPreview>
            ) : (
              <p className="text-caption text-fg-tertiary">{t("在左側選一個專案查看資訊。")}</p>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The selected project's facts and the button that opens it. */
export function ProjectPreview({ item, current, title, onOpen, children }: { item: StudioProjectSummary; current: boolean; title: string; onOpen: () => void; children?: ReactNode }) {
  const ratio = item.shot_count === 0 ? 0 : item.rendered_shot_count / item.shot_count;
  return (
    <div className="grid gap-4 animate-fade-in">
      <div className="grid gap-3 rounded-xl border border-line-subtle bg-canvas/60 p-4">
        <div className="flex items-start gap-3">
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-lg bg-brand-gradient text-on-accent shadow-glow-sm [&_svg]:size-5">
            <FolderKanban />
          </span>
          <div className="grid min-w-0 gap-0.5">
            {/* The project's id stays in the tooltip (the main UI shows no raw ids) */}
            <h3 className="text-section font-semibold [overflow-wrap:anywhere] text-fg" title={item.project_id}>{title}</h3>
          </div>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-data">
          <dt className="text-fg-tertiary">{t("鏡頭")}</dt>
          <dd className="machine text-fg">{item.shot_count}</dd>
          <dt className="text-fg-tertiary">{t("已渲染")}</dt>
          <dd className="flex items-center gap-2">
            <span aria-hidden className="h-1.5 w-28 overflow-hidden rounded-full bg-sunken">
              <span className="block h-full rounded-full bg-brand-gradient" style={{ width: `${String(Math.round(ratio * 100))}%` }} />
            </span>
            <span className="machine text-fg">
              {item.rendered_shot_count}/{item.shot_count}
            </span>
          </dd>
          <dt className="text-fg-tertiary">{t("更新")}</dt>
          <dd className="machine text-fg-secondary">{formatTimestamp(item.updated_at)}</dd>
          <dt className="text-fg-tertiary">{t("建立")}</dt>
          <dd className="machine text-fg-secondary">{formatTimestamp(item.created_at)}</dd>
        </dl>
        {current ? (
          <p className="flex items-center gap-1.5 text-caption text-brand-cyan">
            <Check aria-hidden className="size-3.5" />
            {t("目前開啟的專案")}
          </p>
        ) : (
          <Button variant="primary" icon={<FolderInput aria-hidden />} onClick={onOpen}>
            {t("開啟專案")}
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}
