// 專案素材庫（Asset Library）：專案的參考素材（上傳的圖片／影片／聲音，Video Studio 與 Image Studio 共用）、渲染結果
// （成功的 take）與匯出成片（序列匯出）的大型對話框。
// 版型（參考 galgame-editor R010）：左＝分類（參考素材的類型與使用狀態、渲染結果（可依鏡頭篩選）、匯出成片，附數量）與
// 上傳進度；中＝工具列（搜尋、類型、排序、格狀／清單、縮圖大小）與項目（只掛看得到的）；右＝詳細資料（參考素材：大預覽、
// 媒體資訊、使用處、備註、改名、下載、移除；渲染成品：大預覽、seed／路由／run、下載、設為使用中、跳到鏡頭）。
// 渲染成品不是素材庫項目：改名、備註與移除只對參考素材（F2／Delete 在渲染分類不做事）。
// 對話框掛在 Studio 工具列（程式另外載入：LazyAssetLibraryHost；開啟按鈕在 AssetLibraryButton）：關閉再開啟時保留分類、篩選、選取與捲動位置；整個對話框都可以拖放檔案上傳（只收圖片、影片、
// 聲音，其他的略過並說明）；上傳在對話框關閉後仍繼續（換專案或離開頁面才中止）。「從其他專案加入…」把別的專案素材庫的
// 素材加進來，不重新上傳（LibraryImportDialog）；加入後回到參考素材並選取新加入的素材。
// 鍵盤：方向鍵移動、Shift 延伸、Ctrl／Cmd＋A 全選、Enter／空白鍵預覽、F2 改名、Delete 移除（還在使用的不能移除）、
// Ctrl／Cmd＋F 搜尋。移除只從專案文件拿掉，不刪除檔案（model/library）。
import { Clapperboard, Import, Library, ListVideo, Search, TriangleAlert, Upload, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ICON_TILE_BRAND } from "@/components/ui/look";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { usePersistentChoice, usePersistentFlag, usePersistentSize } from "@/lib/usePersistentSize";
import { useShotActions } from "../../hooks/useShotActions";
import {
  defaultSortDescending,
  filterLibrary,
  filterRenders,
  LIBRARY_SORT_KEYS,
  libraryUses,
  projectExportEntries,
  projectTakeEntries,
  sortLibrary,
  sortRenders,
  type LibraryKindFilter,
  type LibrarySortKey,
  type LibraryUsageFilter,
} from "../../model/library";
import { activeTake } from "../../model/project";
import { videoLibrary } from "../../references/materials";
import { findSwapJob } from "../../swap/job";
import { useStudio } from "../../studioContext";
import { useLibraryUploads } from "../bin/useLibraryUploads";
import { LibraryRemoveDialog } from "../LibraryRemoveDialog";
import { assetAdapter } from "./assetCards";
import { CollectRunOutput } from "./CollectRunOutput";
import { totalSize } from "./display";
import { DropOverlay } from "./DropOverlay";
import { RENDER_SORT_LABEL, SORT_LABEL } from "./filters";
import { LibraryBulkRemoveDialog } from "./LibraryBulkRemoveDialog";
import { LibraryCollection, type LibraryViewMode } from "./LibraryCollection";
import { LibraryDetails } from "./LibraryDetails";
import { acceptsFiles, dragVerdict, mediaFiles } from "./libraryDrop";
import { LibraryImportDialog } from "./LibraryImportDialog";
import { closeAssetLibrary, openAssetLibrary, useAssetLibraryOpen } from "./libraryOpen";
import { LibraryPreview } from "./LibraryPreview";
import { LibrarySidebar, type LibrarySection } from "./LibrarySidebar";
import { LibraryToolbar } from "./LibraryToolbar";
import { assetMedia, renderMedia } from "./previewMedia";
import { renderAdapter } from "./renderCards";
import { RenderDetails } from "./RenderDetails";
import { NO_SELECTION, selectAll, selectOnly, visibleSelection, type LibrarySelection } from "./selection";
import { t } from "@/i18n";

const VIEW_MODES: readonly LibraryViewMode[] = ["grid", "list"];
const NO_USES: never[] = [];

type SectionSelections = Record<LibrarySection, LibrarySelection>;
const NO_SELECTIONS: SectionSelections = { assets: NO_SELECTION, takes: NO_SELECTION, exports: NO_SELECTION };
const TAKE_ADAPTER = renderAdapter("take");
const EXPORT_ADAPTER = renderAdapter("export");
/** 拒收訊息顯示多久（毫秒）。 */
const NOTICE_MS = 8000;

/**
 * 素材庫對話框（掛在 Studio 工具列，載入後一直掛著）：狀態在這裡，所以關閉後再開啟仍保留篩選、選取與捲動位置；上傳也在這裡。
 */
export function AssetLibraryHost() {
  const { project, setSourceTakeId, setMonitorMode } = useStudio();
  const actions = useShotActions();
  const navigate = useNavigate();
  const location = useLocation();
  const openState = useAssetLibraryOpen();
  const uploads = useLibraryUploads();
  const baseId = useId();

  const [section, setSection] = useState<LibrarySection>("assets");
  const [kind, setKind] = useState<LibraryKindFilter>("all");
  const [usage, setUsage] = useState<LibraryUsageFilter>("all");
  /** 渲染結果只看這個鏡頭（null＝全部鏡頭）。 */
  const [renderShot, setRenderShot] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selections, setSelections] = useState<SectionSelections>(NO_SELECTIONS);
  const [sort, setSort] = usePersistentChoice<LibrarySortKey>("studio.library.sort", "created", LIBRARY_SORT_KEYS);
  const [descending, setDescending] = usePersistentFlag("studio.library.descending", true);
  const [view, setView] = usePersistentChoice<LibraryViewMode>("studio.library.view", "grid", VIEW_MODES);
  const [thumb, setThumb] = usePersistentSize("studio.library.thumb", 176, 120, 320);
  const [detailsOpen, setDetailsOpen] = usePersistentFlag("studio.library.details", true);
  const [preview, setPreview] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState<{ itemId: string; focusAfter: string | null } | null>(null);
  const [bulk, setBulk] = useState<string[] | null>(null);
  const [importing, setImporting] = useState(false);
  /** 上次「從其他專案加入」看的專案：再打開時先看它（換專案也沿用：多半是從同一個舊專案拿素材）。 */
  const [importSource, setImportSource] = useState<string | null>(null);
  const [dropping, setDropping] = useState<"accept" | "reject" | null>(null);
  const [notice, setNotice] = useState<{ text: string; serial: number } | null>(null);
  // Mounted by the opening that loaded it (LazyAssetLibraryHost): that opening's item still has to be applied
  const [appliedSerial, setAppliedSerial] = useState(openState.open ? openState.serial - 1 : openState.serial);
  const [focusRequest, setFocusRequest] = useState(0);
  const scrollMemoryRef = useRef(0);
  const listboxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 從專案面板指定素材開啟：回到參考素材、清掉篩選並選取它（在 render 中依上一次的開啟序號調整狀態）
  if (openState.serial !== appliedSerial) {
    setAppliedSerial(openState.serial);
    if (openState.itemId != null && openState.itemId !== "") {
      setSection("assets");
      setKind("all");
      setUsage("all");
      setQuery("");
      setSelections((current) => ({ ...current, assets: selectOnly(openState.itemId ?? "") }));
      setFocusRequest((value) => value + 1);
    }
  }
  // The import dialog lives inside the library: however the library closes (also from outside it), the import ends with
  // it instead of coming back by itself with the next opening
  if (!openState.open && importing) setImporting(false);

  // 拒收訊息幾秒後自動消失
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => { setNotice(null); }, NOTICE_MS);
    return () => { window.clearTimeout(timer); };
  }, [notice]);

  const all = project.library ?? [];
  const library = videoLibrary(all);
  const masks = all.length - library.length;
  const swapSourceId = findSwapJob(project)?.source.item_id ?? null;
  const uses = libraryUses(project, swapSourceId);
  const takeEntries = projectTakeEntries(project, activeTake);
  const exportEntries = projectExportEntries(project);
  // 鏡頭篩選指向已刪除或已沒有成品的鏡頭時視為全部鏡頭
  const shotFilter = renderShot !== null && takeEntries.some((entry) => entry.kind === "take" && entry.shot.shot_id === renderShot) ? renderShot : null;
  const items = section === "assets" ? sortLibrary(filterLibrary(library, { kind, usage, query }, uses), sort, descending) : [];
  const renders = section === "takes" ? sortRenders(filterRenders(takeEntries, query, shotFilter), sort, descending) : section === "exports" ? sortRenders(filterRenders(exportEntries, query, null), sort, descending) : [];
  const order = section === "assets" ? items.map((item) => item.item_id) : renders.map((entry) => entry.id);
  const selection = visibleSelection(selections[section], order);
  const setSelection = (next: LibrarySelection) => { setSelections((current) => ({ ...current, [section]: next })); };
  const focusItem = section === "assets" && selection.focus !== null ? (items.find((item) => item.item_id === selection.focus) ?? null) : null;
  const selectedItems = section === "assets" ? items.filter((item) => selection.ids.has(item.item_id)) : [];
  const focusRender = section !== "assets" && selection.focus !== null ? (renders.find((entry) => entry.id === selection.focus) ?? null) : null;
  const selectedRenders = section !== "assets" ? renders.filter((entry) => selection.ids.has(entry.id)) : [];
  const previewIndex = preview === null ? -1 : order.indexOf(preview);
  const previewMedia = previewIndex < 0 ? null : section === "assets" ? (items[previewIndex] ? assetMedia(items[previewIndex]) : null) : renders[previewIndex] ? renderMedia(renders[previewIndex]) : null;
  const usedCount = library.filter((item) => uses.has(item.item_id)).length;
  const kindCount = (id: LibraryKindFilter) => (id === "all" ? library.length : library.filter((item) => item.kind === id).length);
  const usageCount = (id: LibraryUsageFilter) => (id === "all" ? library.length : id === "used" ? usedCount : library.length - usedCount);
  const renderShots = project.shots
    .map((shot, index) => ({ shot, index, count: takeEntries.filter((entry) => entry.kind === "take" && entry.shot.shot_id === shot.shot_id).length }))
    .filter((entry) => entry.count > 0);
  const sectionTotal = section === "assets" ? library.length : section === "takes" ? takeEntries.length : exportEntries.length;
  const shown = order.length;
  const revealKey = `${section}|${kind}|${usage}|${shotFilter ?? ""}|${query.trim()}|${sort}|${String(descending ? 1 : 0)}|${view}`;
  const filtered = query.trim() !== "" || (section === "assets" ? kind !== "all" || usage !== "all" : section === "takes" && shotFilter !== null);
  const sortLabels = section === "assets" ? SORT_LABEL : RENDER_SORT_LABEL;

  const focusList = () => requestAnimationFrame(() => listboxRef.current?.focus({ preventScroll: true }));
  const changeSort = (key: LibrarySortKey) => {
    if (key === sort) setDescending(!descending);
    else {
      setSort(key);
      setDescending(defaultSortDescending(key));
    }
  };
  const changeSection = (next: LibrarySection) => {
    setSection(next);
    setPreview(null);
    setRenaming(false);
  };
  const requestRemove = () => {
    if (section !== "assets") return;
    if (selection.ids.size > 1) {
      setBulk([...selection.ids]);
      return;
    }
    const target = selection.focus;
    if (target === null) return;
    const index = order.indexOf(target);
    setRemoving({ itemId: target, focusAfter: order[index + 1] ?? order[index - 1] ?? null });
  };
  const rename = (itemId: string) => {
    setSelection(selectOnly(itemId));
    setDetailsOpen(true);
    setRenaming(true);
  };
  /** 關閉素材庫並選取鏡頭（takeId：監看器顯示這個 take）；不在「鏡頭」工作區時帶著鏡頭切過去。 */
  const jumpToShot = (shotId: string, takeId: string | null = null) => {
    closeAssetLibrary();
    if (location.pathname.startsWith("/studio/generate")) {
      actions.openInSource(shotId);
      if (takeId !== null) setSourceTakeId(takeId);
      return;
    }
    // 鏡頭由目的 URL 的 shot 參數選取（同 Render 工作區的「到編輯監看」）；這裡只指定監看器要看的 take
    setSourceTakeId(takeId);
    setMonitorMode("source");
    void navigate(`/studio/generate?project=${encodeURIComponent(project.project_id)}&shot=${encodeURIComponent(shotId)}`);
  };
  const addFiles = (files: File[]) => {
    if (files.length > 0) uploads.addFiles(files, false);
  };
  const dropFiles = (dropped: File[]) => {
    const accepted = mediaFiles(dropped);
    const skipped = dropped.length - accepted.length;
    if (skipped > 0) setNotice({ text: t("已略過 {skipped} 個不是圖片、影片或聲音的檔案", { skipped }), serial: Date.now() });
    if (accepted.length > 0) {
      // 上傳進度在左欄；切回參考素材，傳完的素材出現在清單上
      changeSection("assets");
      addFiles(accepted);
    }
  };
  const clearFilters = () => {
    setKind("all");
    setUsage("all");
    setRenderShot(null);
    setQuery("");
  };
  /** 從其他專案加入之後：回到參考素材、清掉篩選並選取新加入的素材（捲到第一個），焦點回到清單。 */
  const showImported = (itemIds: string[]) => {
    setImporting(false);
    changeSection("assets");
    clearFilters();
    setSelections((current) => ({ ...current, assets: selectAll(itemIds, null) }));
    setFocusRequest((value) => value + 1);
    // Moved while the import dialog is closing, so its focus return leaves it on the list (see components/ui/focusReturn)
    focusList();
  };

  const noMatch = (
    <EmptyState
      icon={<Search />}
      title={t("沒有符合的素材")}
      description={t("換個關鍵字，或清除篩選條件。")}
      action={
        <Button size="sm" onClick={clearFilters} icon={<X aria-hidden />}>
          {t("清除篩選")}
        </Button>
      }
    />
  );
  const emptyState = (
    <div className="grid h-full place-items-center p-6">
      {sectionTotal > 0 ? (
        noMatch
      ) : section === "assets" ? (
        <EmptyState
          illustration="drop"
          title={t("還沒有上傳參考素材")}
          description={t("把圖片、影片或聲音拖到這裡，或按「上傳」。")}
          action={
            <Button variant="primary" icon={<Upload aria-hidden />} onClick={() => fileInputRef.current?.click()}>
              {t("上傳")}
            </Button>
          }
        />
      ) : (
        <EmptyState icon={section === "takes" ? <Clapperboard /> : <ListVideo />} title={section === "takes" ? t("還沒有渲染結果") : t("還沒有匯出成片")} description={t("渲染成功的 take 與序列匯出會出現在這裡。")} />
      )}
    </div>
  );

  const collectionProps = {
    baseId,
    selection,
    onSelection: (next: LibrarySelection) => {
      setSelection(next);
      setRenaming(false);
      if (next.ids.size > 0 && !detailsOpen) setDetailsOpen(true);
    },
    view,
    thumb,
    sort,
    descending,
    onSort: changeSort,
    revealKey,
    focusRequest,
    scrollMemoryRef: scrollMemoryRef,
    listboxRef,
    onOpen: setPreview,
    empty: emptyState,
  };

  return (
    <Dialog
      open={openState.open}
      onOpenChange={(open) => {
        if (open) openAssetLibrary();
        else {
          setPreview(null);
          setRenaming(false);
          setDropping(null);
          closeAssetLibrary();
        }
      }}
    >
      <DialogContent
        aria-describedby={`${baseId}-description`}
        className="h-[min(60rem,calc(100vh-2.5rem))] max-h-none w-[calc(100vw-2.5rem)] max-w-[110rem]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (listboxRef.current ?? searchRef.current)?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => {
          if (preview !== null) {
            event.preventDefault();
            setPreview(null);
            focusList();
          } else if (document.activeElement instanceof HTMLElement && document.activeElement.closest("[data-library-local-escape]")) {
            event.preventDefault();
          }
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
            event.preventDefault();
            setPreview(null);
            searchRef.current?.focus();
            searchRef.current?.select();
          }
        }}
        // 整個對話框都是放置區：拖進檔案時蓋上說明（不是圖片、影片或聲音時說明不收）
        onDragEnter={(event) => {
          if (!acceptsFiles(event)) return;
          event.preventDefault();
          setDropping(dragVerdict(event));
        }}
        onDragOver={(event) => {
          if (!acceptsFiles(event)) return;
          event.preventDefault();
          const verdict = dragVerdict(event);
          event.dataTransfer.dropEffect = verdict === "accept" ? "copy" : "none";
          if (verdict !== dropping) setDropping(verdict);
        }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          setDropping(null);
        }}
        onDrop={(event) => {
          if (!acceptsFiles(event)) return;
          event.preventDefault();
          setDropping(null);
          dropFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line-subtle px-4 pr-14">
          <span aria-hidden className={cn(ICON_TILE_BRAND, "size-8 [&_svg]:size-4")}>
            <Library />
          </span>
          <div className="grid min-w-0">
            <DialogTitle className="flex items-baseline gap-2 text-data">
              {t("專案素材庫")}
              <span className="machine text-caption font-normal text-fg-tertiary">{library.length + takeEntries.length + exportEntries.length}</span>
            </DialogTitle>
            <DialogDescription id={`${baseId}-description`} className="truncate text-caption text-fg-tertiary">
              {t("參考素材（Video Studio 與 Image Studio 共用）、渲染結果與匯出成片；可以把檔案直接拖進來上傳。移除只從專案拿掉參考素材，不會刪除檔案。")}
            </DialogDescription>
          </div>
          <div className="ml-auto"><CollectRunOutput /></div>
          <Button
            size="sm"
            icon={<Import aria-hidden />}
            onClick={() => { setImporting(true); }}
            aria-haspopup="dialog"
            title={t("從其他專案的素材庫挑選素材加進這個專案（使用同一個檔案，不重新上傳）")}
          >
            {t("從其他專案加入…")}
          </Button>
          <Button variant="primary" size="sm" icon={<Upload aria-hidden />} onClick={() => fileInputRef.current?.click()} title={t("上傳圖片、影片或聲音到專案素材庫（不會加到任何鏡頭）")}>
            {t("上傳")}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              dropFiles(files);
            }}
          />
        </header>

        <div className={cn("grid min-h-0 flex-1", detailsOpen ? "grid-cols-[15rem_minmax(0,1fr)_23rem]" : "grid-cols-[15rem_minmax(0,1fr)]")}>
          {/* 左：分類 */}
          <LibrarySidebar
            section={section}
            kind={kind}
            usage={usage}
            shotFilter={shotFilter}
            kindCount={kindCount}
            usageCount={usageCount}
            takeCount={takeEntries.length}
            exportCount={exportEntries.length}
            renderShots={renderShots}
            uploads={uploads}
            librarySize={totalSize(library)}
            masks={masks}
            onKind={(id) => {
              changeSection("assets");
              setKind(id);
            }}
            onUsage={(id) => {
              changeSection("assets");
              setUsage(id);
            }}
            onTakes={() => {
              changeSection("takes");
              setRenderShot(null);
            }}
            onShot={setRenderShot}
            onExports={() => { changeSection("exports"); }}
          />

          {/* 中：工具列與項目 */}
          <section aria-label={section === "assets" ? t("素材") : section === "takes" ? t("渲染結果") : t("匯出成片")} className="relative flex min-h-0 min-w-0 flex-col">
            <LibraryToolbar
              section={section}
              searchRef={searchRef}
              listboxRef={listboxRef}
              query={query}
              onQuery={setQuery}
              kind={kind}
              onKind={setKind}
              sort={sort}
              sortLabels={sortLabels}
              onSort={changeSort}
              descending={descending}
              onDescending={setDescending}
              view={view}
              onView={setView}
              thumb={thumb}
              onThumb={setThumb}
              detailsOpen={detailsOpen}
              onDetailsOpen={setDetailsOpen}
            />

            {section === "assets" ? (
              <LibraryCollection {...collectionProps} items={items} adapter={assetAdapter(uses)} label={t("素材")} onRename={rename} onRemove={requestRemove} />
            ) : (
              <LibraryCollection {...collectionProps} items={renders} adapter={section === "takes" ? TAKE_ADAPTER : EXPORT_ADAPTER} label={section === "takes" ? t("渲染結果") : t("匯出成片")} />
            )}

            <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-line-subtle px-3 text-caption text-fg-tertiary">
              <span className="machine">{filtered ? t("{shown} / {total} 個項目", { shown, total: sectionTotal }) : t("{total} 個項目", { total: sectionTotal })}</span>
              {selection.ids.size > 0 ? <span className="machine text-fg-secondary">{t("已選取 {count} 個", { count: selection.ids.size })}</span> : null}
              {filtered ? (
                <button type="button" onClick={clearFilters} className="pressable rounded-sm px-1 text-action-fg hover:underline">
                  {t("清除篩選")}
                </button>
              ) : null}
              <AnimatePresence mode="popLayout" initial={false}>
                {notice ? (
                  <motion.span
                    key={notice.serial}
                    role="status"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={motionTransition("fast", "standard")}
                    className="flex min-w-0 items-center gap-1.5 text-warning"
                  >
                    <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">{notice.text}</span>
                    <button type="button" onClick={() => { setNotice(null); }} aria-label={t("關閉")} className="pressable shrink-0 rounded-sm p-0.5 hover:bg-raised">
                      <X aria-hidden className="size-3" />
                    </button>
                  </motion.span>
                ) : null}
              </AnimatePresence>
              <span className="ml-auto truncate">{section === "assets" ? t("↑↓←→ 移動・Shift 延伸・Enter 預覽・F2 改名・Delete 移除") : t("↑↓←→ 移動・Shift 延伸・Enter 預覽")}</span>
            </footer>
          </section>

          {/* 右：詳細資料 */}
          {detailsOpen ? (
            <aside aria-label={t("詳細資料")} className="min-h-0 overflow-y-auto border-l border-line-subtle bg-canvas/40">
              {section === "assets" ? (
                <LibraryDetails
                  item={focusItem}
                  selected={selectedItems}
                  uses={uses}
                  swapSourceId={swapSourceId}
                  renaming={renaming}
                  onRenaming={(on) => {
                    setRenaming(on);
                    if (!on) focusList();
                  }}
                  renameRef={renameRef}
                  onExpand={setPreview}
                  onRemove={requestRemove}
                  onJumpToShot={(shotId) => { jumpToShot(shotId); }}
                  onClearSelection={() => { setSelection(NO_SELECTION); }}
                />
              ) : (
                <RenderDetails
                  entry={focusRender}
                  selected={selectedRenders}
                  onExpand={setPreview}
                  onUseTake={(shotId, takeId) => { actions.selectTake(shotId, takeId); }}
                  onJumpToShot={jumpToShot}
                  onClearSelection={() => { setSelection(NO_SELECTION); }}
                />
              )}
            </aside>
          ) : null}
        </div>

        <AnimatePresence>
          {previewMedia ? (
            <LibraryPreview
              media={previewMedia}
              position={previewIndex}
              total={order.length}
              onStep={(delta) => {
                const next = order[(previewIndex + delta + order.length) % order.length];
                if (next === undefined) return;
                setPreview(next);
                setSelection(selectOnly(next));
              }}
              onClose={() => {
                setPreview(null);
                focusList();
              }}
            />
          ) : null}
        </AnimatePresence>

        <DropOverlay verdict={dropping} />

        <LibraryRemoveDialog
          itemId={removing?.itemId ?? null}
          uses={(removing && uses.get(removing.itemId)) ?? NO_USES}
          onClose={() => { setRemoving(null); }}
          onRemoved={() => {
            const next = removing?.focusAfter ?? null;
            setSelections((current) => ({ ...current, assets: (next != null && next !== "") ? selectOnly(next) : NO_SELECTION }));
            focusList();
          }}
        />
        <LibraryBulkRemoveDialog
          items={bulk === null ? null : library.filter((item) => bulk.includes(item.item_id))}
          uses={uses}
          onClose={() => { setBulk(null); }}
          onRemoved={() => {
            setSelections((current) => ({ ...current, assets: NO_SELECTION }));
            focusList();
          }}
        />
        <LibraryImportDialog open={importing} onOpenChange={setImporting} sourceId={importSource} onSourceChange={setImportSource} onImported={showImported} />
      </DialogContent>
    </Dialog>
  );
}
