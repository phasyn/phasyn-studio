// Project manager of both Studios (the pill in the toolbar opens it): an After-Effects-style project panel with the
// shared project list (the same projects in Video Studio and Image Studio) as a sortable, searchable table on the left
// — name, shots, rendered progress, updated, created. A click (or ↑/↓) only selects a project: the right column
// previews it (facts, and the Studio's settings when it is the current one) with an "Open project" button; a double
// click or Enter opens it. "New project" in the header switches the right column to the Studio's creation form.
// Look: a large sheet; rows reveal with a short stagger; the current project carries the brand mark and a check.
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, FolderInput, FolderKanban, FolderPlus, LoaderCircle, Search } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { StudioProjectSummary } from "@/api/generated/contracts";
import { useStudioProjects } from "@/api/studioProjects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
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
}

type SortKey = "title" | "shots" | "rendered" | "updated" | "created";
const COLUMNS = "grid-cols-[minmax(0,1fr)_4.5rem_8rem_9.5rem_9.5rem]";

function sortValue(item: StudioProjectSummary, key: SortKey): string | number {
  switch (key) {
    case "title":
      return item.title.toLocaleLowerCase();
    case "shots":
      return item.shot_count;
    case "rendered":
      return item.shot_count === 0 ? 0 : item.rendered_shot_count / item.shot_count;
    case "updated":
      return item.updated_at;
    case "created":
      return item.created_at;
  }
}

export function ProjectSwitcher({ description, hint, metaOf, onSelect, renderDetails, renderCreate }: ProjectSwitcherProps) {
  const { projectId, projectTitle } = useStudioShell();
  const projects = useStudioProjects();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "updated", desc: true });
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setPicked(null);
      setCreating(false);
    }
  };
  const go = (id: string) => {
    close();
    if (id !== projectId) onSelect(id);
  };
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const items = (projects.data?.items ?? []).filter((item) => !needle || item.title.toLocaleLowerCase().includes(needle) || item.project_id.includes(needle));
    return [...items].sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      const order = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -order : order;
    });
  }, [projects.data, query, sort]);
  const selectedId = picked ?? projectId;
  const selected = (projects.data?.items ?? []).find((item) => item.project_id === selectedId) ?? null;
  const header = (key: SortKey, label: string, align: "start" | "end" = "start") => {
    const active = sort.key === key;
    return (
      <button
        type="button"
        role="columnheader"
        aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
        onClick={() => setSort(active ? { key, desc: !sort.desc } : { key, desc: key !== "title" })}
        className={cn("flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-caption font-medium hover:bg-raised hover:text-fg [&_svg]:size-3", align === "end" && "justify-end", active ? "text-fg" : "text-fg-tertiary")}
      >
        <span className="truncate">{label}</span>
        {active ? sort.desc ? <ArrowDown aria-hidden /> : <ArrowUp aria-hidden /> : null}
      </button>
    );
  };
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-project-row]") ?? []);
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      event.preventDefault();
      next.focus();
      setPicked(next.dataset.projectRow ?? null);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="group/project pressable inline-flex h-10 max-w-64 min-w-0 shrink items-center gap-2 rounded-full border border-line-subtle bg-surface/80 pr-2.5 pl-1 text-data text-fg shadow-edge hover:border-line-strong hover:bg-raised active:bg-sunken aria-expanded:border-brand-blue/60 [&_svg]:size-3.5"
          title={hint}
        >
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-entity/15 text-entity">
            <FolderKanban />
          </span>
          <span className="truncate font-medium">{projectTitle}</span>
          <ChevronDown aria-hidden className="shrink-0 text-fg-tertiary transition-[rotate] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) group-aria-expanded/project:rotate-180" />
        </button>
      </DialogTrigger>
      <DialogContent className="h-[min(48rem,90vh)] max-w-[min(76rem,96vw)]">
        <DialogHeader>
          <div className="flex flex-wrap items-start gap-3">
            <div className="grid min-w-0 flex-1 gap-1">
              <DialogTitle>{t("專案")}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </div>
            {renderCreate ? (
              <Button variant="primary" size="sm" icon={<FolderPlus aria-hidden />} onClick={() => setCreating(true)} aria-pressed={creating}>
                {t("新增專案")}
              </Button>
            ) : null}
          </div>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section aria-label={t("專案列表")} className="flex min-h-0 min-w-0 flex-col border-line-subtle lg:border-r">
            <div className="flex shrink-0 items-center gap-2 px-6 py-3">
              <label className="relative min-w-0 flex-1">
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
                <Input compact type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜尋專案名稱")} aria-label={t("搜尋專案名稱")} className="pl-8" />
              </label>
              <span className="shrink-0 text-caption text-fg-tertiary">{t("{count} 個專案", { count: rows.length })}</span>
            </div>
            <div role="table" aria-label={t("專案列表")} className="flex min-h-0 flex-1 flex-col">
              <div role="row" className={cn("grid shrink-0 items-center gap-2 border-y border-line-subtle bg-sunken/40 px-6 py-1", COLUMNS)}>
                {header("title", t("名稱"))}
                {header("shots", t("鏡頭"), "end")}
                {header("rendered", t("已渲染"))}
                {header("updated", t("更新"))}
                {header("created", t("建立"))}
              </div>
              <div ref={listRef} role="rowgroup" onKeyDown={onListKey} className="min-h-0 flex-1 overflow-y-auto px-3 py-1.5">
                {projects.isError ? (
                  <p role="alert" className="px-3 py-2 text-caption text-danger">
                    {t("讀取專案列表失敗")}
                  </p>
                ) : null}
                {projects.isPending ? (
                  <p role="status" className="flex items-center gap-1.5 px-3 py-2 text-caption text-fg-tertiary">
                    <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
                    {t("讀取專案列表…")}
                  </p>
                ) : null}
                {projects.data && rows.length === 0 ? <p className="px-3 py-2 text-caption text-fg-tertiary">{t("沒有符合的專案")}</p> : null}
                {rows.map((item, index) => {
                  const current = item.project_id === projectId;
                  const ratio = item.shot_count === 0 ? 0 : item.rendered_shot_count / item.shot_count;
                  return (
                    <button
                      key={item.project_id}
                      ref={reveal(index)}
                      type="button"
                      role="row"
                      data-project-row={item.project_id}
                      onClick={() => {
                        setPicked(item.project_id);
                        setCreating(false);
                      }}
                      onDoubleClick={() => go(item.project_id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          go(item.project_id);
                        }
                      }}
                      aria-current={current ? "true" : undefined}
                      aria-selected={item.project_id === selectedId}
                      title={metaOf(item)}
                      className={cn(
                        "pressable grid w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors duration-(--duration-fast)",
                        COLUMNS,
                        item.project_id === selectedId ? "border-brand-blue/60 bg-brand-gradient-soft shadow-glow-sm" : "border-transparent hover:border-line-subtle hover:bg-raised/60 active:bg-sunken",
                      )}
                    >
                      <span role="cell" className="flex min-w-0 items-center gap-2.5">
                        <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-md [&_svg]:size-4", current ? "bg-brand-gradient text-on-accent shadow-glow-sm" : "bg-entity/12 text-entity")}>
                          <FolderKanban />
                        </span>
                        <span className="truncate text-data text-fg">{current ? projectTitle : item.title}</span>
                        {current ? <Check aria-label={t("目前的專案")} className="size-4 shrink-0 text-brand-cyan" /> : null}
                      </span>
                      <span role="cell" className="machine text-right text-data text-fg-secondary">
                        {item.shot_count}
                      </span>
                      <span role="cell" className="flex min-w-0 items-center gap-2">
                        <span aria-hidden className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken">
                          <span className="block h-full rounded-full bg-brand-gradient transition-[width] duration-(--duration-slow)" style={{ width: `${Math.round(ratio * 100)}%` }} />
                        </span>
                        <span className="machine shrink-0 text-caption text-fg-tertiary">
                          {item.rendered_shot_count}/{item.shot_count}
                        </span>
                      </span>
                      <span role="cell" className="machine truncate text-caption text-fg-secondary">
                        {formatTimestamp(item.updated_at)}
                      </span>
                      <span role="cell" className="machine truncate text-caption text-fg-tertiary">
                        {formatTimestamp(item.created_at)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
          <aside aria-label={creating ? t("新增專案") : t("專案資訊")} className="grid min-h-0 content-start gap-4 overflow-y-auto px-5 py-4">
            {creating && renderCreate ? (
              <>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="quiet" icon={<ArrowLeft aria-hidden />} onClick={() => setCreating(false)}>
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
              <ProjectPreview item={selected} current={selected.project_id === projectId} title={selected.project_id === projectId ? projectTitle : selected.title} onOpen={() => go(selected.project_id)}>
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
function ProjectPreview({ item, current, title, onOpen, children }: { item: StudioProjectSummary; current: boolean; title: string; onOpen: () => void; children?: ReactNode }) {
  const ratio = item.shot_count === 0 ? 0 : item.rendered_shot_count / item.shot_count;
  return (
    <div className="grid gap-4 animate-fade-in">
      <div className="grid gap-3 rounded-xl border border-line-subtle bg-canvas/60 p-4">
        <div className="flex items-start gap-3">
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-lg bg-brand-gradient text-on-accent shadow-glow-sm [&_svg]:size-5">
            <FolderKanban />
          </span>
          <div className="grid min-w-0 gap-0.5">
            <h3 className="text-section font-semibold [overflow-wrap:anywhere] text-fg">{title}</h3>
            <code className="machine truncate text-caption text-fg-tertiary">{item.project_id}</code>
          </div>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-data">
          <dt className="text-fg-tertiary">{t("鏡頭")}</dt>
          <dd className="machine text-fg">{item.shot_count}</dd>
          <dt className="text-fg-tertiary">{t("已渲染")}</dt>
          <dd className="flex items-center gap-2">
            <span aria-hidden className="h-1.5 w-28 overflow-hidden rounded-full bg-sunken">
              <span className="block h-full rounded-full bg-brand-gradient" style={{ width: `${Math.round(ratio * 100)}%` }} />
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
