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
import { FolderKanban, Import, Library, Plus, RotateCcw, Search, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { useStudioProjects } from "@/api/studioProjects";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/controls";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ICON_TILE_BRAND } from "@/components/ui/look";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import type { LibraryKindFilter } from "../../model/library";
import { MAX_LIBRARY_ITEMS } from "../../model/project";
import { KindIcon } from "../../references/KindIcon";
import { KIND_LABEL } from "../../references/materials";
import { useStudio } from "../../studioContext";
import { ItemGrid, SkeletonGrid } from "./ImportItemGrid";
import { KindFilter } from "./ImportKindFilter";
import { ProjectList } from "./ImportProjectList";
import { checkRange, existingItem, importedCopies, libraryFiles, projectMatches, rowId, tileLayout } from "./libraryImport";
import { useLibrarySources } from "./useLibrarySources";
import { useViewport } from "./useVirtualRows";
import { t } from "@/i18n";

/** 其他專案多於這個數量時顯示搜尋欄。 */
const SEARCH_FROM = 8;
const NO_ITEMS: StudioLibraryItem[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/** 勾選屬於一個來源專案：換專案時重新開始。anchor＝Shift 範圍的起點（最後勾選或取消的那一個）。 */
interface Checked {
  projectId: string | null;
  ids: ReadonlySet<string>;
  anchor: string | null;
}


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
        onKeyDown={(event) => { event.stopPropagation(); }}
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
  else if (source?.error != null) {
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
  } else if (source?.items == null) {
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
          <Button size="sm" onClick={() => { setKind("all"); }}>
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
    <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */
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
                  <div className="relative block">
                    <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
                    <Input
                      compact
                      type="search"
                      value={query}
                      data-import-local-escape={query ? "" : undefined}
                      onChange={(event) => { setQuery(event.target.value); }}
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
                  </div>
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
                <Button size="sm" variant="quiet" disabled={picks.length === 0} onClick={() => { commit(NO_IDS, null); }}>
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

