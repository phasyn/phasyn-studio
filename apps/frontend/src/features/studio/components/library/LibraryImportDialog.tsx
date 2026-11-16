// 「從其他專案加入…」（素材庫標題列）：把另一個專案素材庫裡的參考素材加進這個專案，不重新上傳——新的素材使用同一個檔案
// （檔案一直在主控／Node 的檔案庫，見 ./libraryImport）。
// 版型：左＝其他專案（名稱、素材數、更新時間；專案多時有搜尋欄），右＝選到的專案的素材（類型篩選、全選、縮圖磚可以勾選），
// 底部＝已選數量與「加入 N 個」。對話框窄的時候專案清單疊在素材上方（看對話框自己的寬度，不看視窗）。
// 已在這個專案素材庫的檔案（同一個 node_id＋file_id）標「已在素材庫」，不能勾選。加入的是複本：新的 item_id、同一個檔案
// 參照、名稱與媒體資訊，一次 addLibraryItems（model/project），與其他素材庫編輯一樣自動保存；超過素材庫上限時不能加入。
// 鍵盤：專案清單 ↑↓ 換專案、→ 或 Enter 到素材；素材 ↑↓←→ 移動、空白鍵或 Enter 勾選、Shift＋方向鍵連著勾選、Shift＋空白鍵
// 勾選一段、Ctrl／⌘＋A 全選（都選了再按一次＝取消）；Ctrl／⌘＋Enter 加入；Esc 關閉（搜尋欄有字時先清掉）。
// 動作：專案列依序進場，選到的專案有滑動的品牌底；素材磚依序進場（換專案或類型時重新進場，捲動後新掛上的不再播放），勾選時
// 角落的勾號彈出；讀取中是掃光的骨架；空狀態與錯誤上升淡入；底部的狀態文字換內容時淡入。
import { AudioLines, Check, Film, FolderKanban, Image as ImageIcon, Import, Library, LoaderCircle, Plus, RotateCcw, Search, TriangleAlert, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { StudioLibraryItem, StudioProjectSummary } from "@/api/generated/contracts";
import { useStudioProjects } from "@/api/studioProjects";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/controls";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HUD_CHIP, ICON_TILE_BRAND, LIFT, THUMB_ZOOM } from "@/components/ui/look";
import { motionTransition, reveal } from "@/components/ui/motion";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatTimestamp } from "@/lib/format";
import type { LibraryKindFilter } from "../../model/library";
import { MAX_LIBRARY_ITEMS } from "../../model/project";
import { KindIcon } from "../../references/KindIcon";
import { KIND_LABEL } from "../../references/materials";
import { LibraryThumb } from "../../references/ReferenceRow";
import { useStudio } from "../../studioContext";
import { itemDimensions, itemDuration, itemSize } from "./display";
import { checkRange, existingItem, importedCopies, libraryFiles, projectMatches, tileLayout, type TileLayout } from "./libraryImport";
import { useLibrarySources, type LibrarySource } from "./useLibrarySources";
import { useViewport, virtualRows, type VirtualViewport } from "./useVirtualRows";
import { t } from "@/i18n";

/** 其他專案多於這個數量時顯示搜尋欄。 */
const SEARCH_FROM = 8;
const SKELETON_ROWS = 5;
const NO_ITEMS: StudioLibraryItem[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/** 勾選屬於一個來源專案：換專案時重新開始。anchor＝Shift 範圍的起點（最後勾選或取消的那一個）。 */
interface Checked {
  projectId: string | null;
  ids: ReadonlySet<string>;
  anchor: string | null;
}

const rowId = (baseId: string, projectId: string) => `${baseId}-project-${projectId}`;
const tileId = (baseId: string, itemId: string) => `${baseId}-item-${itemId}`;

/**
 * 這個對話框只複製已經在檔案庫的檔案，不收拖進來的檔案。拖放事件會沿著 React 樹傳到後面素材庫的放置區（它會在這個對話框
 * 後面看不見地開始上傳），所以在這裡擋下；也取消預設動作，否則瀏覽器會直接打開那個檔案。
 */
function refuseFiles(event: DragEvent<HTMLElement>) {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "none";
}

export interface LibraryImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 上次選的來源專案（再打開時先看它；不在了就看最近更新的專案）。 */
  sourceId: string | null;
  onSourceChange: (projectId: string) => void;
  /** 加入之後（新素材的 item_id，依加入素材庫的順序）；由呼叫端關閉對話框並選取它們。 */
  onImported: (itemIds: string[]) => void;
}

export function LibraryImportDialog({ open, onOpenChange, sourceId, onSourceChange, onImported }: LibraryImportDialogProps) {
  const baseId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={`${baseId}-description`}
        className="h-[min(46rem,calc(100vh-2.5rem))] max-h-none max-w-[min(74rem,calc(100vw-2rem))]"
        // Keys stay in this dialog: the asset library behind it, on the same React tree, has shortcuts of its own (Ctrl／⌘＋F)
        onKeyDown={(event) => event.stopPropagation()}
        onEscapeKeyDown={(event) => {
          // Esc in the search field with text clears it first (the field does that itself)
          if (document.activeElement instanceof HTMLElement && document.activeElement.closest("[data-import-local-escape]")) event.preventDefault();
        }}
        onDragEnter={refuseFiles}
        onDragOver={refuseFiles}
        onDrop={refuseFiles}
      >
        {/* Mounted only while the dialog is open (Radix presence): every opening starts fresh and stops its reads on close */}
        <ImportBody baseId={baseId} sourceId={sourceId} onSourceChange={onSourceChange} onImported={onImported} />
      </DialogContent>
    </Dialog>
  );
}

function ImportBody({ baseId, sourceId, onSourceChange, onImported }: { baseId: string; sourceId: string | null; onSourceChange: (projectId: string) => void; onImported: (itemIds: string[]) => void }) {
  const { project, dispatch, notify } = useStudio();
  const projectsQuery = useStudioProjects();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(sourceId);
  const [kind, setKind] = useState<LibraryKindFilter>("all");
  const [checkedState, setCheckedState] = useState<Checked>({ projectId: null, ids: NO_IDS, anchor: null });
  const [cursor, setCursor] = useState<string | null>(null);
  const projectListRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const candidates = (projectsQuery.data?.items ?? []).filter((summary) => summary.project_id !== project.project_id);
  const listState = projectsQuery.isError ? "error" : projectsQuery.isPending ? "loading" : candidates.length === 0 ? "none" : "ready";
  // The items area (the scroll container measured here) exists only next to a project list: subscribe again once it mounts
  const viewport = useViewport(scrollRef, listState === "loading" || listState === "ready");
  const layout = tileLayout(viewport.width);
  const visible = candidates.filter((summary) => projectMatches(summary, query));
  // The picked project stays on the right while a search hides its row; without a pick, the most recently updated one
  const selected = candidates.find((summary) => summary.project_id === picked) ?? candidates[0] ?? null;
  const selectedId = selected?.project_id ?? null;
  const sources = useLibrarySources(
    candidates,
    visible.map((summary) => summary.project_id),
    selectedId,
  );
  const source = selectedId === null ? null : (sources.get(selectedId) ?? null);
  const items = source?.items ?? NO_ITEMS;
  const files = libraryFiles(project.library ?? []);
  const existing = (item: StudioLibraryItem) => existingItem(files, item);
  const selectableIds = new Set(items.filter((item) => existing(item) === null).map((item) => item.item_id));
  const shown = kind === "all" ? items : items.filter((item) => item.kind === kind);
  const order = shown.map((item) => item.item_id);
  const checked = checkedState.projectId === selectedId ? checkedState.ids : NO_IDS;
  const anchor = checkedState.projectId === selectedId ? checkedState.anchor : null;
  const picks = items.filter((item) => checked.has(item.item_id) && selectableIds.has(item.item_id));
  const shownSelectable = shown.filter((item) => selectableIds.has(item.item_id));
  const allChecked = shownSelectable.length > 0 && shownSelectable.every((item) => checked.has(item.item_id));
  const someChecked = shownSelectable.some((item) => checked.has(item.item_id));
  const room = MAX_LIBRARY_ITEMS - (project.library?.length ?? 0);
  const over = picks.length > room;
  const activeIndex = cursor === null ? -1 : order.indexOf(cursor);
  const activeId = activeIndex < 0 ? null : cursor;
  const revealKey = `${selectedId ?? ""}|${kind}`;
  const showSearch = candidates.length > SEARCH_FROM;
  const title = selected ? selected.title || t("未命名專案") : "";

  // A new project or type starts at the top of the grid (the grid replays its entrance under the new key); a grid that
  // has just mounted is already there
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [revealKey]);

  const choose = (projectId: string) => {
    setPicked(projectId);
    setCursor(null);
    onSourceChange(projectId);
  };
  /**
   * Checks belong to the project on the right. Checking in it also makes it the picked one, so a refreshed project list
   * (another project saved meanwhile) cannot swap the project, and the checks with it, under the user; the cursor stays.
   */
  const commit = (ids: ReadonlySet<string>, nextAnchor: string | null) => {
    setCheckedState({ projectId: selectedId, ids, anchor: nextAnchor });
    if (selectedId !== null && picked !== selectedId) {
      setPicked(selectedId);
      onSourceChange(selectedId);
    }
  };
  const toggle = (item: StudioLibraryItem, range: boolean) => {
    setCursor(item.item_id);
    if (!selectableIds.has(item.item_id)) return;
    const on = !checked.has(item.item_id);
    if (range) {
      commit(checkRange(checked, order, anchor, item.item_id, on, (itemId) => selectableIds.has(itemId)), item.item_id);
      return;
    }
    const ids = new Set(checked);
    if (on) ids.add(item.item_id);
    else ids.delete(item.item_id);
    commit(ids, item.item_id);
  };
  const toggleAll = () => {
    const ids = new Set(checked);
    for (const item of shownSelectable) {
      if (allChecked) ids.delete(item.item_id);
      else ids.add(item.item_id);
    }
    commit(ids, anchor);
  };

  const confirm = () => {
    // `over` is the reducer's limit on this library (every copy has a new item_id), so a batch that passes it joins whole
    if (!selected || picks.length === 0 || over) return;
    const copies = importedCopies(picks);
    dispatch({ type: "addLibraryItems", items: copies });
    notify({ tone: "success", title: t("已從「{project}」加入 {count} 個素材", { project: title, count: copies.length }), detail: t("沒有重新上傳：新素材直接使用同一個檔案。") });
    onImported(copies.map((item) => item.item_id));
  };

  /** Keeps the item at `index` inside the scrolled area (keyboard moves). */
  const scrollToIndex = (index: number) => {
    const element = scrollRef.current;
    if (!element) return;
    const top = Math.floor(index / layout.columns) * layout.rowHeight + layout.pad;
    const bottom = top + layout.tileHeight;
    if (top < element.scrollTop) element.scrollTop = Math.max(0, top - layout.pad);
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight + layout.pad;
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || order.length === 0) return;
    const mod = event.ctrlKey || event.metaKey;
    const at = activeIndex;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? layout.rowHeight) / layout.rowHeight)) * layout.columns;
    const move = (to: number) => {
      event.preventDefault();
      const index = Math.min(order.length - 1, Math.max(0, to));
      const itemId = order[index];
      if (itemId === undefined) return;
      if (event.shiftKey) {
        // Shift＋arrow checks the run from the anchor (or from where the cursor was) to the new position
        const from = anchor ?? activeId ?? itemId;
        commit(checkRange(checked, order, from, itemId, true, (id) => selectableIds.has(id)), from);
      }
      setCursor(itemId);
      scrollToIndex(index);
    };
    switch (event.key) {
      case "ArrowRight":
        move(at + 1);
        return;
      case "ArrowLeft":
        move(at < 0 ? 0 : at - 1);
        return;
      case "ArrowDown":
        move(at < 0 ? 0 : at + layout.columns);
        return;
      case "ArrowUp":
        move(at < 0 ? 0 : at - layout.columns);
        return;
      case "PageDown":
        move(at < 0 ? 0 : at + page);
        return;
      case "PageUp":
        move(at < 0 ? 0 : at - page);
        return;
      case "Home":
        move(0);
        return;
      case "End":
        move(order.length - 1);
        return;
      case " ":
      case "Enter": {
        // Ctrl／⌘＋Enter is 加入, handled by the dialog
        if (mod) return;
        event.preventDefault();
        const item = shown[at < 0 ? 0 : at];
        if (item) toggle(item, event.shiftKey);
        return;
      }
      default:
        if (mod && !event.altKey && event.key.toLowerCase() === "a") {
          event.preventDefault();
          toggleAll();
        }
    }
  };

  const onProjectKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (visible.length === 0) return;
    const at = visible.findIndex((summary) => summary.project_id === selectedId);
    const go = (index: number) => {
      event.preventDefault();
      const target = visible[Math.min(visible.length - 1, Math.max(0, index))];
      if (!target) return;
      choose(target.project_id);
      document.getElementById(rowId(baseId, target.project_id))?.scrollIntoView({ block: "nearest" });
    };
    switch (event.key) {
      case "ArrowDown":
        go(at + 1);
        return;
      case "ArrowUp":
        go(at < 0 ? 0 : at - 1);
        return;
      case "Home":
        go(0);
        return;
      case "End":
        go(visible.length - 1);
        return;
      case "ArrowRight":
      case "Enter":
        if (event.ctrlKey || event.metaKey || !gridRef.current) return;
        event.preventDefault();
        gridRef.current.focus();
        return;
    }
  };

  const kindCounts: Record<LibraryKindFilter, number> = {
    all: items.length,
    image: items.filter((item) => item.kind === "image").length,
    video: items.filter((item) => item.kind === "video").length,
    audio: items.filter((item) => item.kind === "audio").length,
  };
  const ready = items.length > 0;
  const status = statusLine({ over, room, count: picks.length, allInLibrary: ready && selectableIds.size === 0 });

  let pane: ReactNode;
  if (!selected) pane = null;
  else if (source?.error) {
    pane = (
      <div className="p-4">
        <Callout tone="danger" title={t("讀不到「{title}」的素材庫", { title })} className="animate-rise-in">
          <p className="[overflow-wrap:anywhere]">{errorText(source.error)}</p>
          <Button size="sm" className="mt-2" icon={<RotateCcw aria-hidden />} onClick={source.retry}>
            {t("重試")}
          </Button>
        </Callout>
      </div>
    );
  } else if (!source || source.items === null) {
    pane = <SkeletonGrid layout={layout} label={t("讀取「{title}」的素材庫…", { title })} />;
  } else if (items.length === 0) {
    pane = <EmptyState size="compact" icon={<Library />} title={t("「{title}」的素材庫是空的", { title })} description={t("在那個專案上傳的圖片、影片與聲音會出現在這裡。")} className="h-full content-center" />;
  } else if (shown.length === 0) {
    pane = (
      <EmptyState
        size="compact"
        icon={<KindIcon kind={kind === "all" ? "image" : kind} className="size-5" />}
        title={t("這個專案沒有{kind}", { kind: kind === "all" ? t("素材") : KIND_LABEL[kind] })}
        action={
          <Button size="sm" onClick={() => setKind("all")}>
            {t("清除篩選")}
          </Button>
        }
        className="h-full content-center"
      />
    );
  } else {
    pane = (
      <ItemGrid
        baseId={baseId}
        items={shown}
        layout={layout}
        viewport={viewport}
        scrollRef={scrollRef}
        gridRef={gridRef}
        revealKey={revealKey}
        checked={checked}
        activeId={activeId}
        existing={existing}
        label={t("「{title}」的素材", { title })}
        onToggle={toggle}
        onKeyDown={onGridKey}
        onFocus={() => {
          // Tabbing in without a cursor starts at the first item (nothing is checked by that)
          if (activeId === null && order[0] !== undefined) setCursor(order[0]);
        }}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          confirm();
        }
      }}
    >
      <DialogHeader>
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className={cn(ICON_TILE_BRAND, "size-9 [&_svg]:size-4.5")}>
            <Import />
          </span>
          <div className="grid min-w-0 gap-1">
            <DialogTitle>{t("從其他專案加入素材")}</DialogTitle>
            <DialogDescription id={`${baseId}-description`}>{t("選一個專案，勾選要加進這個專案素材庫的素材。不會重新上傳：新素材直接使用同一個檔案。")}</DialogDescription>
          </div>
        </div>
      </DialogHeader>

      {listState === "error" || listState === "none" ? (
        <div className="grid min-h-0 flex-1 place-items-center p-6">
          {listState === "error" ? (
            <EmptyState
              icon={<TriangleAlert />}
              title={t("讀取專案列表失敗")}
              description={<span className="[overflow-wrap:anywhere]">{errorText(projectsQuery.error)}</span>}
              action={
                <Button size="sm" icon={<RotateCcw aria-hidden />} onClick={() => void projectsQuery.refetch()}>
                  {t("重試")}
                </Button>
              }
            />
          ) : (
            <EmptyState icon={<FolderKanban />} title={t("沒有其他專案")} description={t("建立別的專案並上傳素材後，就能從這裡把那些素材加進這個專案。")} />
          )}
        </div>
      ) : (
        // Narrow dialogs stack the project list above the items: the dialog's own width decides, not the window's
        <div className="@container/import flex min-h-0 flex-1 flex-col">
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] @3xl/import:grid-cols-[17rem_minmax(0,1fr)] @3xl/import:grid-rows-1">
            <section aria-label={t("其他專案")} className="flex max-h-56 min-h-0 flex-col border-b border-line-subtle bg-canvas/40 @3xl/import:max-h-none @3xl/import:border-r @3xl/import:border-b-0">
              {showSearch ? (
                <div className="shrink-0 px-2 pt-2">
                  <label className="relative block">
                    <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
                    <Input
                      compact
                      type="search"
                      value={query}
                      data-import-local-escape={query ? "" : undefined}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape" && query) {
                          event.preventDefault();
                          setQuery("");
                        } else if (event.key === "ArrowDown" || (event.key === "Enter" && !event.ctrlKey && !event.metaKey)) {
                          event.preventDefault();
                          // Into the list: the first match becomes the project on the right unless the picked one is shown
                          const first = visible[0];
                          if (first && !visible.some((summary) => summary.project_id === selectedId)) choose(first.project_id);
                          projectListRef.current?.focus();
                        }
                      }}
                      placeholder={t("搜尋專案名稱")}
                      aria-label={t("搜尋專案名稱")}
                      autoComplete="off"
                      className="pl-8"
                    />
                  </label>
                </div>
              ) : null}
              <ProjectList
                baseId={baseId}
                listRef={projectListRef}
                loading={listState === "loading"}
                projects={visible}
                sources={sources}
                selectedId={selectedId}
                onChoose={choose}
                onKeyDown={onProjectKey}
              />
            </section>

            <section aria-label={selected ? t("「{title}」的素材", { title }) : t("素材")} className="flex min-h-0 min-w-0 flex-col">
              <div role="toolbar" aria-label={t("素材篩選與勾選")} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-2">
                <KindFilter baseId={baseId} value={kind} counts={kindCounts} disabled={!ready} onChange={setKind} />
                <label
                  className={cn(
                    "ml-auto flex min-h-8 items-center gap-2 rounded-md px-2 text-caption transition-colors duration-(--duration-fast) ease-standard",
                    shownSelectable.length === 0 ? "cursor-not-allowed text-fg-disabled" : "cursor-pointer text-fg-secondary hover:bg-raised hover:text-fg",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={allChecked}
                    disabled={shownSelectable.length === 0}
                    ref={(node) => {
                      // Some but not all checked: the native mixed state (a DOM property, not an attribute)
                      if (node) node.indeterminate = someChecked && !allChecked;
                    }}
                    onChange={toggleAll}
                    aria-keyshortcuts="Control+A Meta+A"
                    className="size-4 cursor-pointer accent-action disabled:cursor-not-allowed"
                  />
                  {t("全選")}
                  <span className="machine text-fg-tertiary">{shownSelectable.length}</span>
                </label>
                <Button size="sm" variant="quiet" disabled={picks.length === 0} onClick={() => commit(NO_IDS, null)}>
                  {t("清除選取")}
                </Button>
              </div>
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
                {listState === "loading" ? <SkeletonGrid layout={layout} label={t("讀取專案列表…")} /> : pane}
              </div>
            </section>
          </div>
        </div>
      )}

      <DialogFooter className="justify-between gap-3">
        {/* basis-56: on a narrow dialog the buttons wrap below the status instead of squeezing it */}
        <p id={`${baseId}-status`} aria-live="polite" className="flex min-w-0 flex-1 basis-56 items-center text-caption">
          <motion.span
            key={status.key}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={motionTransition("fast", "standard")}
            className={cn("flex min-w-0 items-center gap-1.5", status.tone === "warning" ? "text-warning" : status.tone === "count" ? "text-fg-secondary" : "text-fg-tertiary")}
          >
            {status.tone === "warning" ? <TriangleAlert aria-hidden className="size-3.5 shrink-0" /> : null}
            <span className="[overflow-wrap:anywhere]">{status.text}</span>
          </motion.span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <DialogClose asChild>
            <Button>{t("取消")}</Button>
          </DialogClose>
          <Button
            variant="primary"
            icon={<Plus aria-hidden />}
            disabled={picks.length === 0 || over}
            onClick={confirm}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            aria-describedby={`${baseId}-status`}
            className="min-w-32"
          >
            {picks.length > 0 ? t("加入 {count} 個", { count: picks.length }) : t("加入")}
          </Button>
        </div>
      </DialogFooter>
    </div>
  );
}

/** 底部的一句狀態：超過上限（說明還能加入幾個）、已選幾個、這個專案的素材都已在素材庫，或操作提示。 */
function statusLine({ over, room, count, allInLibrary }: { over: boolean; room: number; count: number; allInLibrary: boolean }): { key: string; tone: "warning" | "count" | "hint"; text: string } {
  if (over) {
    return {
      key: "over",
      tone: "warning",
      text: room <= 0 ? t("素材庫已滿：最多 {max} 個素材", { max: MAX_LIBRARY_ITEMS }) : t("素材庫最多 {max} 個素材：這個專案還能加入 {room} 個", { max: MAX_LIBRARY_ITEMS, room }),
    };
  }
  if (count > 0) return { key: "count", tone: "count", text: t("已選取 {count} 個", { count }) };
  if (allInLibrary) return { key: "all-in", tone: "hint", text: t("這個專案的素材都已在素材庫") };
  return { key: "hint", tone: "hint", text: t("點縮圖勾選・Shift＋點一下勾選一段・Ctrl／⌘＋A 全選") };
}

/** 左欄的專案清單：一個 listbox（焦點在清單上，↑↓ 換專案）；選到的專案有滑動的品牌底。 */
function ProjectList({
  baseId,
  listRef,
  loading,
  projects,
  sources,
  selectedId,
  onChoose,
  onKeyDown,
}: {
  baseId: string;
  listRef: RefObject<HTMLDivElement | null>;
  loading: boolean;
  projects: readonly StudioProjectSummary[];
  sources: ReadonlyMap<string, LibrarySource>;
  selectedId: string | null;
  onChoose: (projectId: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const activeShown = selectedId !== null && projects.some((summary) => summary.project_id === selectedId);
  return (
    // layoutScroll: the sliding mark measures rows inside a list that scrolls
    <motion.div
      ref={listRef}
      layoutScroll
      role="listbox"
      tabIndex={0}
      aria-label={t("其他專案")}
      aria-busy={loading || undefined}
      aria-activedescendant={activeShown && selectedId !== null ? rowId(baseId, selectedId) : undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "group/projects grid min-h-0 flex-1 auto-rows-max content-start gap-0.5 overflow-y-auto p-2",
        // The focused row carries the ring; with no row shown (a search hid it) the list does
        activeShown ? "outline-none" : "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
      )}
    >
      {loading ? (
        // Decoration only: the items area next to it says 讀取專案列表… once (role="status")
        Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <span key={index} aria-hidden className="flex min-h-12 items-center gap-2.5 px-2.5">
            <Skeleton className="size-8 shrink-0" />
            <span className="grid flex-1 gap-1.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </span>
          </span>
        ))
      ) : projects.length === 0 ? (
        <p className="px-2.5 py-3 text-caption text-fg-tertiary animate-fade-in">{t("沒有符合的專案")}</p>
      ) : (
        projects.map((summary, index) => {
          const active = summary.project_id === selectedId;
          const name = summary.title || t("未命名專案");
          return (
            <div
              key={summary.project_id}
              ref={reveal(index)}
              id={rowId(baseId, summary.project_id)}
              role="option"
              aria-selected={active}
              title={name}
              onClick={() => onChoose(summary.project_id)}
              className={cn(
                "relative flex min-h-12 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 select-none",
                active ? "text-fg" : "text-fg-secondary hover:bg-raised/70 hover:text-fg active:bg-sunken",
                "group-focus-visible/projects:aria-selected:outline-2 group-focus-visible/projects:aria-selected:-outline-offset-2 group-focus-visible/projects:aria-selected:outline-focus",
              )}
            >
              {active ? (
                <motion.span
                  layoutId={`${baseId}-project-mark`}
                  aria-hidden
                  transition={motionTransition("spring-snappy", "spring-snappy")}
                  className="absolute inset-0 rounded-lg border border-brand-blue/40 bg-brand-gradient-soft"
                />
              ) : null}
              <span aria-hidden className={cn("relative grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4", active ? "bg-brand-gradient text-on-accent shadow-glow-sm" : "bg-entity/12 text-entity")}>
                <FolderKanban />
              </span>
              <span className="relative grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-data">{name}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-caption text-fg-tertiary">
                  <SourceCount source={sources.get(summary.project_id)} />
                  <span aria-hidden>·</span>
                  <span className="machine truncate">{t("更新於 {time}", { time: formatTimestamp(summary.updated_at) })}</span>
                </span>
              </span>
            </div>
          );
        })
      )}
    </motion.div>
  );
}

/** 專案列上的素材數：讀取中是骨架，讀不到時說明（原因在提示），讀到後淡入數字。 */
function SourceCount({ source }: { source: LibrarySource | undefined }) {
  if (!source || source.pending) {
    return (
      <>
        <Skeleton className="h-3 w-12 shrink-0" />
        <span className="sr-only">{t("讀取中…")}</span>
      </>
    );
  }
  if (source.error) {
    return (
      <span title={errorText(source.error)} className="inline-flex shrink-0 items-center gap-1 text-warning animate-fade-in">
        <TriangleAlert aria-hidden className="size-3" />
        {t("讀不到")}
      </span>
    );
  }
  const count = source.items?.length ?? 0;
  return <span className="machine shrink-0 animate-fade-in">{count === 0 ? t("沒有素材") : t("{count} 個素材", { count })}</span>;
}

const KIND_FILTERS: readonly { id: LibraryKindFilter; label: string; icon: LucideIcon }[] = [
  { id: "all", label: t("全部"), icon: Library },
  { id: "image", label: t("圖片"), icon: ImageIcon },
  { id: "video", label: t("影片"), icon: Film },
  { id: "audio", label: t("聲音"), icon: AudioLines },
];

/** 類型篩選（全部／圖片／影片／聲音，附數量）：目前的類型有滑動的品牌底。 */
function KindFilter({ baseId, value, counts, disabled, onChange }: { baseId: string; value: LibraryKindFilter; counts: Record<LibraryKindFilter, number>; disabled: boolean; onChange: (kind: LibraryKindFilter) => void }) {
  return (
    <div role="group" aria-label={t("類型")} className="flex flex-wrap items-center gap-0.5 rounded-lg border border-line-subtle bg-sunken/60 p-0.5">
      {KIND_FILTERS.map((entry) => {
        const active = value === entry.id;
        return (
          <button
            key={entry.id}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(entry.id)}
            className={cn(
              "pressable relative inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption disabled:cursor-not-allowed disabled:text-fg-disabled",
              active ? "text-fg" : "text-fg-secondary enabled:hover:bg-raised enabled:hover:text-fg",
            )}
          >
            {active ? (
              <motion.span
                layoutId={`${baseId}-kind-mark`}
                aria-hidden
                transition={motionTransition("spring-snappy", "spring-snappy")}
                className="absolute inset-0 rounded-md bg-brand-gradient-soft ring-1 ring-brand-blue/40"
              />
            ) : null}
            <entry.icon aria-hidden className={cn("relative size-3.5", active ? "text-brand-cyan" : "text-fg-tertiary")} />
            <span className="relative">{entry.label}</span>
            <span className="machine relative text-fg-tertiary">{disabled ? "—" : counts[entry.id]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 讀取中的素材格：與磚同樣大小的掃光骨架（兩列），上方一行讀取說明。 */
function SkeletonGrid({ layout, label }: { layout: TileLayout; label: string }) {
  return (
    <div className="grid gap-3 animate-fade-in" style={{ padding: layout.pad }}>
      <p role="status" className="flex items-center gap-1.5 text-caption text-fg-tertiary">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
        {label}
      </p>
      <div aria-hidden className="grid" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, gridAutoRows: layout.tileHeight, gap: layout.gap }}>
        {Array.from({ length: layout.columns * 2 }, (_, index) => (
          <span key={index} className="grid content-start gap-1.5 rounded-xl border border-line-subtle bg-canvas/60 p-1.5">
            <span className="block" style={{ height: layout.thumbHeight }}>
              <Skeleton className="h-full w-full rounded-lg" />
            </span>
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * 進場的範圍：每次（重新）掛上時是「還沒捲動」，磚依序進場；之後一捲動，新掛上的磚就直接出現（與素材庫的清單相同）。
 * 以 key＝revealKey 掛上，所以換專案或類型時重新開始。
 */
function RevealScope({ scrollRef, style, children }: { scrollRef: RefObject<HTMLElement | null>; style: CSSProperties; children: (scrolled: RefObject<boolean>) => ReactNode }) {
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // Scroll events arrive a frame late: the one from the grid's own reset to the top (a new project or type, see
    // ImportBody) reaches this new scope and must not count, or the first rows would mount without their entrance
    const mark = () => {
      if (element.scrollTop > 0) scrolled.current = true;
    };
    element.addEventListener("scroll", mark, { passive: true });
    return () => element.removeEventListener("scroll", mark);
  }, [scrollRef]);
  return <div style={style}>{children(scrolled)}</div>;
}

function useEnter(scrolled: RefObject<boolean>, stagger: number) {
  return useCallback(
    (node: HTMLElement | null) => {
      if (!node || scrolled.current) return;
      return reveal(stagger)(node);
    },
    [scrolled, stagger],
  );
}

interface GridProps {
  baseId: string;
  items: readonly StudioLibraryItem[];
  layout: TileLayout;
  viewport: VirtualViewport;
  scrollRef: RefObject<HTMLDivElement | null>;
  gridRef: RefObject<HTMLDivElement | null>;
  revealKey: string;
  checked: ReadonlySet<string>;
  activeId: string | null;
  existing: (item: StudioLibraryItem) => StudioLibraryItem | null;
  label: string;
  onToggle: (item: StudioLibraryItem, range: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
}

/**
 * 素材格：一個 listbox（aria-multiselectable＋aria-activedescendant）；只掛看得到的列（來源專案最多 500 個素材，影片縮圖是
 * <video preload="metadata">，全部掛上會同時讀幾百個檔頭）。
 */
function ItemGrid({ baseId, items, layout, viewport, scrollRef, gridRef, revealKey, checked, activeId, existing, label, onToggle, onKeyDown, onFocus }: GridProps) {
  const { columns, thumbHeight, tileHeight, rowHeight, gap, pad } = layout;
  const range = virtualRows(viewport, Math.ceil(items.length / columns), rowHeight);
  const first = range.start * columns;
  const visible = items.slice(first, range.end * columns);
  const activeIndex = activeId === null ? -1 : items.findIndex((item) => item.item_id === activeId);
  const activeMounted = activeIndex >= first && activeIndex < range.end * columns;
  return (
    <div
      ref={gridRef}
      role="listbox"
      tabIndex={0}
      aria-multiselectable
      aria-label={label}
      aria-activedescendant={activeMounted && activeId !== null ? tileId(baseId, activeId) : undefined}
      aria-keyshortcuts="Space Enter Shift+Space Control+A Meta+A Control+Enter Meta+Enter"
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      className="group/listbox outline-none"
      style={{ padding: pad }}
    >
      <RevealScope key={revealKey} scrollRef={scrollRef} style={{ paddingTop: range.padTop, paddingBottom: Math.max(0, range.padBottom - gap) }}>
        {(scrolled) => (
          <div className="grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: tileHeight, gap }}>
            {visible.map((item, offset) => (
              <ImportTile
                key={item.item_id}
                id={tileId(baseId, item.item_id)}
                item={item}
                checked={checked.has(item.item_id)}
                active={item.item_id === activeId}
                existing={existing(item)}
                thumbHeight={thumbHeight}
                stagger={offset}
                scrolled={scrolled}
                onToggle={onToggle}
              />
            ))}
          </div>
        )}
      </RevealScope>
    </div>
  );
}

/** 滑過影片縮圖時無聲播放，離開時回到開頭（與素材庫的磚相同）。 */
function playPreview(event: MouseEvent<HTMLElement>) {
  void event.currentTarget.querySelector("video")?.play().catch(() => undefined);
}

function stopPreview(event: MouseEvent<HTMLElement>) {
  const video = event.currentTarget.querySelector("video");
  if (!video) return;
  video.pause();
  video.currentTime = 0.1;
}

/** 一個素材磚：縮圖、類型與長度；可以勾選的右上角有勾選框，已在素材庫的變淡並寫出來（不能勾選）。 */
function ImportTile({
  id,
  item,
  checked,
  active,
  existing,
  thumbHeight,
  stagger,
  scrolled,
  onToggle,
}: {
  id: string;
  item: StudioLibraryItem;
  checked: boolean;
  active: boolean;
  /** 這個檔案在目前專案素材庫裡的素材（null＝還沒有，可以勾選）。 */
  existing: StudioLibraryItem | null;
  thumbHeight: number;
  stagger: number;
  scrolled: RefObject<boolean>;
  onToggle: (item: StudioLibraryItem, range: boolean) => void;
}) {
  const enter = useEnter(scrolled, stagger);
  const taken = existing !== null;
  return (
    <div
      ref={enter}
      id={id}
      role="option"
      aria-selected={checked}
      aria-disabled={taken || undefined}
      data-focused={active || undefined}
      title={taken ? t("這個檔案已在這個專案的素材庫（「{name}」）", { name: existing.name }) : item.name}
      onClick={(event) => onToggle(item, event.shiftKey)}
      onMouseEnter={playPreview}
      onMouseLeave={stopPreview}
      className={cn(
        "group/tile relative grid content-start gap-1 rounded-xl border p-1.5 select-none",
        taken ? "cursor-not-allowed border-line-subtle bg-canvas/40 opacity-55" : cn("cursor-pointer", LIFT, checked ? "border-brand-blue/80 bg-brand-gradient-soft shadow-glow-sm" : "border-line-subtle bg-canvas/60 hover:border-line-strong"),
        "data-focused:outline-offset-2 group-focus-visible/listbox:data-focused:outline-2 group-focus-visible/listbox:data-focused:outline-focus",
      )}
    >
      <span className="relative grid place-items-center overflow-hidden rounded-lg border border-line-subtle bg-stage" style={{ height: thumbHeight }}>
        <LibraryThumb item={item} className={THUMB_ZOOM} />
        <span className={cn(HUD_CHIP, "absolute top-1.5 left-1.5 inline-flex items-center gap-1 px-1.5 text-[11px]")}>
          <KindIcon kind={item.kind} className="size-3" />
          {KIND_LABEL[item.kind]}
        </span>
        {item.kind !== "image" ? <span className={cn(HUD_CHIP, "machine absolute right-1.5 bottom-1.5 px-1.5 text-[11px]")}>{itemDuration(item)}</span> : null}
        {taken ? (
          <span className={cn(HUD_CHIP, "absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 px-1.5 text-[11px] text-fg-secondary")}>
            <Check aria-hidden className="size-3" />
            {t("已在素材庫")}
          </span>
        ) : (
          <span
            aria-hidden
            className={cn(
              "absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-md border shadow-[0_1px_2px_rgb(0_0_0/0.4)]",
              checked ? "border-transparent bg-brand-gradient text-on-accent" : "border-white/50 bg-sunken/70 group-hover/tile:border-white/80",
            )}
          >
            {checked ? <Check className="size-3.5 animate-pop-in" /> : null}
          </span>
        )}
      </span>
      <span className="truncate px-0.5 text-caption text-fg">{item.name}</span>
      <span className="machine truncate px-0.5 text-[11px] leading-4 text-fg-tertiary">{item.kind === "audio" ? itemSize(item) : `${itemDimensions(item)} · ${itemSize(item)}`}</span>
    </div>
  );
}
