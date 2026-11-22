// The shared project table of both Studios (After-Effects-style project panel): a search field with the count, then a
// sortable table — name, shots, rendered progress, updated, created. A click (or ↑/↓) picks a row; a double click or
// Enter opens it. Used by the project manager dialog (ProjectSwitcher) and by the project list page (no project open).
// With `onRequestRemove` a checkbox column selects projects for removal: a click toggles one, Shift+click a range, the
// header checkbox every row the search shows; the open project cannot be selected. The selection always follows what
// is on screen (a new search or a removal drops hidden rows) and 「移除 N 個專案」 hands the selected rows to the caller.
// Look: rows reveal with a short stagger; the picked row carries the brand mark, the current project a check.
import { ArrowDown, ArrowUp, Check, FolderKanban, LoaderCircle, Search, Trash2, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { StudioProjectSummary } from "@/api/generated/contracts";
import { useStudioProjects } from "@/api/studioProjects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { t } from "@/i18n";
import { OUTSIDE_SAVES_POLL_MS } from "./document/useOutsideSaves";
import { NO_SELECTION, pruneSelection, removalTargets, selectAllState, toggleAll, toggleRow, type RowSelection } from "./projectRemovalModel";

type SortKey = "title" | "shots" | "rendered" | "updated" | "created";
// The name column always keeps its room: a narrower table (a phone, a small dialog) first drops 建立, then 更新, and at
// last shows the rendered count without its bar (container widths, so the same table fits wherever it is placed)
const COLUMNS = "grid-cols-[minmax(0,1fr)_4.5rem_8rem_9.5rem_9.5rem] @max-[46rem]:grid-cols-[minmax(0,1fr)_4.5rem_8rem_9.5rem] @max-[32rem]:grid-cols-[minmax(0,1fr)_2.5rem_3.5rem]";
const SELECT_COLUMNS = "grid-cols-[1.75rem_minmax(0,1fr)_4.5rem_8rem_9.5rem_9.5rem] @max-[46rem]:grid-cols-[1.75rem_minmax(0,1fr)_4.5rem_8rem_9.5rem] @max-[32rem]:grid-cols-[1.75rem_minmax(0,1fr)_2.5rem_3.5rem]";
const UPDATED_CELL = "@max-[32rem]:hidden";
const CREATED_CELL = "@max-[46rem]:hidden";
const NO_ITEMS: readonly StudioProjectSummary[] = [];

const CHECKBOX = "size-4 cursor-pointer accent-action disabled:cursor-not-allowed disabled:opacity-40";

/** A project's rendered shots as the Studio counts them (the film on its timeline), with those that need an update. */
export interface RenderProgress {
  ready: number;
  total: number;
  stale: number;
}

/** Reads the progress of the listed projects; called once per render with every listed project. */
export type RenderProgressHook = (items: readonly StudioProjectSummary[]) => (item: StudioProjectSummary) => RenderProgress | null;

const noProgress: RenderProgressHook = () => () => null;

/** The Controller's summary, until (or unless) the Studio's own count is known. */
function summaryProgress(item: StudioProjectSummary): RenderProgress {
  return { ready: item.rendered_shot_count, total: item.shot_count, stale: 0 };
}

function sortValue(item: StudioProjectSummary, key: SortKey, progress: RenderProgress): string | number {
  switch (key) {
    case "title":
      return item.title.toLocaleLowerCase();
    case "shots":
      return item.shot_count;
    case "rendered":
      return progress.total === 0 ? 0 : progress.ready / progress.total;
    case "updated":
      return item.updated_at;
    case "created":
      return item.created_at;
  }
}

export interface ProjectTableProps {
  /** The open project (it carries a check), if any. */
  currentId?: string | null;
  /** Its live title (the list can lag behind a rename that is still saving). */
  currentTitle?: string;
  /** The picked row (null: none). */
  pickedId: string | null;
  onPick: (projectId: string) => void;
  onOpen: (projectId: string) => void;
  /** One-line summary of a project (the row's tooltip). */
  metaOf: (item: StudioProjectSummary) => string;
  /** Extra controls at the right end of the search row (e.g. 「匯入可攜包」). */
  actions?: ReactNode;
  /** Turns on the checkbox column; receives the selected projects (display order, never the open one). */
  onRequestRemove?: (items: StudioProjectSummary[]) => void;
  /** True while a removal runs: search, checkboxes, rows and the removal buttons are all disabled. */
  locked?: boolean;
  /** A short result line (e.g. 「已移除 3 個專案」) shown in place of the count; null: none. */
  notice?: string | null;
  /** The Studio's own rendered count (the same as its status bar); without it the Controller's summary. */
  useProgress?: RenderProgressHook;
}

export function ProjectTable({ currentId = null, currentTitle, pickedId, onPick, onOpen, metaOf, actions, onRequestRemove, locked = false, notice = null, useProgress = noProgress }: ProjectTableProps) {
  // Read again while the table is on screen: a project another tab, an agent (phasynctl) or a sync tool added, renamed or
  // removed shows up without reloading the page (the list is a cached projection on the Controller, so this is cheap)
  const projects = useStudioProjects({ pollMs: OUTSIDE_SAVES_POLL_MS });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "updated", desc: true });
  const listRef = useRef<HTMLDivElement>(null);
  const [storedSelection, setStoredSelection] = useState<RowSelection>(NO_SELECTION);
  // Shift state of the pointer or key that toggles a checkbox (the change event itself does not carry it)
  const shiftRef = useRef(false);
  const selecting = onRequestRemove !== undefined;
  const studioProgress = useProgress(projects.data?.items ?? NO_ITEMS);
  const progressOf = (item: StudioProjectSummary) => studioProgress(item) ?? summaryProgress(item);
  const needle = query.trim().toLocaleLowerCase();
  const rows = (projects.data?.items ?? NO_ITEMS)
    .filter((item) => !needle || item.title.toLocaleLowerCase().includes(needle) || item.project_id.includes(needle))
    .sort((a, b) => {
      const x = sortValue(a, sort.key, progressOf(a));
      const y = sortValue(b, sort.key, progressOf(b));
      const order = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -order : order;
    });
  const selectable = rows.filter((item) => item.project_id !== currentId).map((item) => item.project_id);
  const selection = pruneSelection(storedSelection, selectable);
  const targets = removalTargets(rows, selection, currentId);
  const allState = selectAllState(selection, selectable);
  const columns = selecting ? SELECT_COLUMNS : COLUMNS;
  const header = (key: SortKey, label: string, align: "start" | "end" = "start", className?: string) => {
    const active = sort.key === key;
    return (
      <button
        type="button"
        role="columnheader"
        aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
        onClick={() => { setSort(active ? { key, desc: !sort.desc } : { key, desc: key !== "title" }); }}
        className={cn("flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 text-caption font-medium hover:bg-raised hover:text-fg [&_svg]:size-3", align === "end" && "justify-end", active ? "text-fg" : "text-fg-tertiary", className)}
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
      const id = next.dataset["projectRow"];
      if (id !== undefined) onPick(id);
    }
  };
  return (
    <section aria-label={t("專案列表")} className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 py-3 @max-[32rem]:px-3">
        <div className="relative min-w-48 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input compact type="search" value={query} onChange={(event) => { setQuery(event.target.value); setStoredSelection(NO_SELECTION); }} placeholder={t("搜尋專案名稱")} aria-label={t("搜尋專案名稱")} className="pl-8" disabled={locked} />
        </div>
        {notice !== null && targets.length === 0 ? (
          <span role="status" className="flex shrink-0 items-center gap-1 text-caption text-success animate-fade-in [&_svg]:size-3.5">
            <Check aria-hidden />
            {notice}
          </span>
        ) : null}
        <span className={cn("shrink-0 text-caption text-fg-tertiary", notice !== null && targets.length === 0 && "sr-only")}>
          {targets.length > 0 ? t("已選 {selected}／{count} 個專案", { selected: targets.length, count: rows.length }) : t("{count} 個專案", { count: rows.length })}
        </span>
        {selecting && targets.length > 0 ? (
          <>
            <Button size="sm" variant="quiet" icon={<X aria-hidden />} disabled={locked} onClick={() => { setStoredSelection(NO_SELECTION); }}>
              {t("取消選取")}
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 aria-hidden />} disabled={locked} onClick={() => { onRequestRemove(targets); }}>
              {t("移除 {count} 個專案", { count: targets.length })}
            </Button>
          </>
        ) : null}
        {actions}
      </div>
      <div role="table" aria-label={t("專案列表")} className="flex min-h-0 flex-1 flex-col">
        <div role="row" className={cn("grid shrink-0 items-center gap-2 border-y border-line-subtle bg-sunken/40 px-6 py-1 @max-[32rem]:px-3", columns)}>
          {selecting ? (
            <span role="columnheader" className="grid place-items-center">
              <input
                type="checkbox"
                className={CHECKBOX}
                aria-label={t("全選列出的專案")}
                title={t("全選列出的專案")}
                disabled={locked || selectable.length === 0}
                checked={allState === "all"}
                ref={(element) => { if (element) element.indeterminate = allState === "some"; }}
                onChange={() => { setStoredSelection(toggleAll(selection, selectable)); }}
              />
            </span>
          ) : null}
          {header("title", t("名稱"))}
          {header("shots", t("鏡頭"), "end")}
          {header("rendered", t("已渲染"))}
          {header("updated", t("更新"), "start", UPDATED_CELL)}
          {header("created", t("建立"), "start", CREATED_CELL)}
        </div>
        <div /* eslint-disable-line jsx-a11y-x/no-noninteractive-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */ ref={listRef} role="rowgroup" onKeyDown={onListKey} className="min-h-0 flex-1 overflow-y-auto px-3 py-1.5">
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
            const current = item.project_id === currentId;
            const progress = progressOf(item);
            const ratio = progress.total === 0 ? 0 : progress.ready / progress.total;
            const checked = selection.ids.has(item.project_id);
            const rowButton = (
              <button
                type="button"
                data-project-row={item.project_id}
                disabled={locked}
                onClick={() => { onPick(item.project_id); }}
                onDoubleClick={() => { onOpen(item.project_id); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onOpen(item.project_id);
                  }
                }}
                aria-current={current ? "true" : undefined}
                title={metaOf(item)}
                className={cn(
                  "pressable col-span-5 grid disabled:pointer-events-none disabled:opacity-50 grid-cols-subgrid items-center rounded-md py-2 text-left @max-[46rem]:col-span-4 @max-[32rem]:col-span-3",
                  selecting ? "pr-3" : "px-3",
                )}
              >
                <span role="cell" className="flex min-w-0 items-center gap-2.5">
                  <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-md [&_svg]:size-4", current ? "bg-brand-gradient text-on-accent shadow-glow-sm" : "bg-entity/12 text-entity")}>
                    <FolderKanban />
                  </span>
                  <span className="truncate text-data text-fg">{(current ? currentTitle : undefined) ?? (item.title || t("未命名專案"))}</span>
                  {current ? <Check aria-label={t("目前的專案")} className="size-4 shrink-0 text-brand-cyan" /> : null}
                </span>
                <span role="cell" className="machine text-right text-data text-fg-secondary">
                  {item.shot_count}
                </span>
                {/* Wraps 需更新 under the count when the column is narrow (a phone) instead of cutting it off */}
                <span role="cell" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span aria-hidden className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken @max-[32rem]:hidden">
                    <span className="block h-full rounded-full bg-brand-gradient transition-[width] duration-(--duration-slow)" style={{ width: `${String(Math.round(ratio * 100))}%` }} />
                  </span>
                  <span className="machine shrink-0 text-caption text-fg-tertiary">
                    {progress.ready}/{progress.total}
                  </span>
                  {progress.stale > 0 ? (
                    <span className="shrink-0 text-caption whitespace-nowrap text-warning">{t("需更新 {stale}", { stale: progress.stale })}</span>
                  ) : null}
                </span>
                <span role="cell" className={cn("machine truncate text-caption text-fg-secondary", UPDATED_CELL)}>
                  {formatTimestamp(item.updated_at)}
                </span>
                <span role="cell" className={cn("machine truncate text-caption text-fg-tertiary", CREATED_CELL)}>
                  {formatTimestamp(item.created_at)}
                </span>
              </button>
            );
            return (
              <div
                key={item.project_id}
                ref={reveal(index)}
                role="row"
                aria-selected={item.project_id === pickedId}
                className={cn(
                  "grid w-full items-center gap-2 rounded-lg border transition-colors duration-(--duration-fast)",
                  columns,
                  selecting && "pl-3",
                  item.project_id === pickedId ? "border-brand-blue/60 bg-brand-gradient-soft shadow-glow-sm" : checked ? "border-danger/30 bg-danger/5" : "border-transparent hover:border-line-subtle hover:bg-raised/60 active:bg-sunken",
                )}
              >
                {selecting ? (
                  <span role="cell" className="grid place-items-center">
                    <input
                      type="checkbox"
                      className={CHECKBOX}
                      aria-label={t("選取「{title}」", { title: item.title || t("未命名專案") })}
                      title={current ? t("目前開啟的專案不能在這裡移除") : t("勾選要移除的專案；按住 Shift 可一次選取一段")}
                      disabled={locked || current}
                      checked={checked}
                      onPointerDown={(event) => { shiftRef.current = event.shiftKey; }}
                      onKeyDown={(event) => { shiftRef.current = event.shiftKey; }}
                      onChange={() => {
                        setStoredSelection(toggleRow(selection, selectable, item.project_id, shiftRef.current));
                        shiftRef.current = false;
                      }}
                    />
                  </span>
                ) : null}
                {rowButton}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
