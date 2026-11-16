// 專案素材庫（Asset Library）：專案的參考素材（上傳的圖片／影片／聲音，Video Studio 與 Image Studio 共用）、渲染結果
// （成功的 take）與匯出成片（序列匯出）的大型對話框。
// 版型（參考 galgame-editor R010）：左＝分類（參考素材的類型與使用狀態、渲染結果（可依鏡頭篩選）、匯出成片，附數量）與
// 上傳進度；中＝工具列（搜尋、類型、排序、格狀／清單、縮圖大小）與項目（只掛看得到的）；右＝詳細資料（參考素材：大預覽、
// 媒體資訊、使用處、備註、改名、下載、移除；渲染成品：大預覽、seed／路由／run、下載、設為使用中、跳到鏡頭）。
// 渲染成品不是素材庫項目：改名、備註與移除只對參考素材（F2／Delete 在渲染分類不做事）。
// 對話框掛在 Studio 工具列：關閉再開啟時保留分類、篩選、選取與捲動位置；整個對話框都可以拖放檔案上傳（只收圖片、影片、
// 聲音，其他的略過並說明）；上傳在對話框關閉後仍繼續（換專案或離開頁面才中止）。「從其他專案加入…」把別的專案素材庫的
// 素材加進來，不重新上傳（LibraryImportDialog）；加入後回到參考素材並選取新加入的素材。
// 鍵盤：方向鍵移動、Shift 延伸、Ctrl／Cmd＋A 全選、Enter／空白鍵預覽、F2 改名、Delete 移除（還在使用的不能移除）、
// Ctrl／Cmd＋F 搜尋。移除只從專案文件拿掉，不刪除檔案（model/library）。
import { ArrowDownWideNarrow, ArrowUpNarrowWide, AudioLines, Ban, Clapperboard, Film, Image as ImageIcon, Import, LayoutGrid, Library, Link2, List, ListVideo, PanelRightClose, PanelRightOpen, Search, TriangleAlert, Unlink, Upload, X, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ICON_TILE_BRAND } from "@/components/ui/look";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { usePersistentChoice, usePersistentFlag, usePersistentSize } from "@/lib/usePersistentSize";
import { mediaUrl } from "@/api/http";
import { useShotActions } from "../../hooks/useShotActions";
import {
  defaultSortDescending,
  filterLibrary,
  filterRenders,
  LIBRARY_SORT_KEYS,
  libraryUses,
  projectExportEntries,
  projectTakeEntries,
  renderEntryName,
  sortLibrary,
  sortRenders,
  type LibraryKindFilter,
  type LibrarySortKey,
  type LibraryUsageFilter,
  type RenderEntry,
} from "../../model/library";
import { activeTake } from "../../model/project";
import { itemFacts } from "../../references/display";
import { KIND_LABEL } from "../../references/materials";
import { videoLibrary } from "../../references/materials";
import { ReferenceUploadRow } from "../../references/UploadRow";
import { findSwapJob } from "../../swap/job";
import { useStudio } from "../../studioContext";
import { useLibraryUploads } from "../bin/useLibraryUploads";
import { LibraryRemoveDialog } from "../LibraryRemoveDialog";
import { assetAdapter } from "./assetCards";
import { renderDimensions, renderDuration, totalSize } from "./display";
import { LibraryBulkRemoveDialog } from "./LibraryBulkRemoveDialog";
import { LibraryCollection, type LibraryViewMode } from "./LibraryCollection";
import { LibraryDetails } from "./LibraryDetails";
import { LibraryImportDialog } from "./LibraryImportDialog";
import { closeAssetLibrary, openAssetLibrary, useAssetLibraryOpen } from "./libraryOpen";
import { LibraryPreview, type PreviewMedia } from "./LibraryPreview";
import { renderAdapter } from "./renderCards";
import { RenderDetails } from "./RenderDetails";
import { NO_SELECTION, selectAll, selectOnly, visibleSelection, type LibrarySelection } from "./selection";
import { t } from "@/i18n";

const VIEW_MODES: readonly LibraryViewMode[] = ["grid", "list"];
const NO_USES: never[] = [];

const KIND_FILTERS: { id: LibraryKindFilter; label: string; icon: LucideIcon }[] = [
  { id: "all", label: t("全部素材"), icon: Library },
  { id: "image", label: t("圖片"), icon: ImageIcon },
  { id: "video", label: t("影片"), icon: Film },
  { id: "audio", label: t("聲音"), icon: AudioLines },
];

const USAGE_FILTERS: { id: LibraryUsageFilter; label: string; icon: LucideIcon }[] = [
  { id: "all", label: t("不限"), icon: Library },
  { id: "used", label: t("使用中"), icon: Link2 },
  { id: "unused", label: t("沒有使用"), icon: Unlink },
];

const SORT_LABEL: Record<LibrarySortKey, string> = { name: t("名稱"), created: t("加入時間"), size: t("大小"), duration: t("長度") };
/** 渲染成品沒有「加入」：建立時間。 */
const RENDER_SORT_LABEL: Record<LibrarySortKey, string> = { ...SORT_LABEL, created: t("建立時間") };

/** 素材庫的三個分類：參考素材（素材庫項目）、渲染結果（成功的 take）、匯出成片（序列匯出）。 */
type LibrarySection = "assets" | "takes" | "exports";
type SectionSelections = Record<LibrarySection, LibrarySelection>;
const NO_SELECTIONS: SectionSelections = { assets: NO_SELECTION, takes: NO_SELECTION, exports: NO_SELECTION };
const TAKE_ADAPTER = renderAdapter("take");
const EXPORT_ADAPTER = renderAdapter("export");
/** 拒收訊息顯示多久（毫秒）。 */
const NOTICE_MS = 8000;

/** 拖進來的檔案（dragenter／dragover 時只看得到類型）：全部都有類型而且沒有一個是圖片、影片或聲音＝不收。 */
function dragVerdict(event: DragEvent<HTMLElement>): "accept" | "reject" {
  const files = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
  if (files.length === 0) return "accept";
  return files.every((item) => item.type !== "" && !/^(image|video|audio)\//.test(item.type)) ? "reject" : "accept";
}

/** 預覽用的媒體（參考素材或渲染成品）。 */
function assetMedia(item: StudioLibraryItem): PreviewMedia {
  const facts = itemFacts(item);
  return { key: item.item_id, url: mediaUrl(item.file.node_id, item.file.file_id), kind: item.kind, name: item.name, facts: [KIND_LABEL[item.kind], ...(facts ? [facts] : [])] };
}

function renderMedia(entry: RenderEntry): PreviewMedia {
  const file = entry.asset.file;
  return {
    key: entry.id,
    url: mediaUrl(file.node_id, file.file_id),
    kind: "video",
    name: renderEntryName(entry),
    facts: [...(entry.kind === "take" ? [`seed ${entry.take.seed}`] : []), renderDimensions(entry), renderDuration(entry)],
  };
}

const acceptsFiles = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes("Files");
const mediaFiles = (files: Iterable<File>) => Array.from(files).filter((file) => /^(image|video|audio)\//.test(file.type));

/** 左側分類的一個按鈕：目前的分類有品牌色標記（Motion layoutId 在分類之間滑動）。 */
function CategoryButton({ group, active, label, icon: Icon, count, onClick }: { group: string; active: boolean; label: string; icon: LucideIcon; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "pressable relative flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-data transition-colors duration-(--duration-fast)",
        active ? "text-fg" : "text-fg-secondary hover:bg-raised/70 hover:text-fg",
      )}
    >
      {active ? (
        <motion.span
          layoutId={`library-category-${group}`}
          transition={motionTransition("spring-snappy", "spring-snappy")}
          aria-hidden
          className="absolute inset-0 rounded-md border border-brand-blue/40 bg-brand-gradient-soft"
        />
      ) : null}
      <Icon aria-hidden className={cn("relative size-4 shrink-0", active ? "text-brand-cyan" : "text-fg-tertiary")} />
      <span className="relative min-w-0 flex-1 truncate">{label}</span>
      <span className="machine relative text-caption text-fg-tertiary">{count}</span>
    </button>
  );
}

function ToggleButton({ pressed, label, onClick, children }: { pressed: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "pressable inline-flex size-7 items-center justify-center rounded-md transition-colors duration-(--duration-fast) [&_svg]:size-4",
        pressed ? "bg-brand-gradient-soft text-brand-cyan ring-1 ring-brand-blue/40" : "text-fg-tertiary hover:bg-raised hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** 渲染結果的鏡頭篩選（縮排在「渲染結果」下面）。 */
function ShotFilterButton({ active, index, title, count, onClick }: { active: boolean; index: number; title: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={cn(
        "pressable flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-caption transition-colors duration-(--duration-fast)",
        active ? "bg-brand-gradient-soft text-fg ring-1 ring-brand-blue/40" : "text-fg-secondary hover:bg-raised/70 hover:text-fg",
      )}
    >
      <span className="machine shrink-0 text-fg-tertiary">{String(index + 1).padStart(2, "0")}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="machine shrink-0 text-fg-tertiary">{count}</span>
    </button>
  );
}

/** 素材庫裡的項目數：參考素材、渲染結果（成功的 take）與匯出成片。 */
function useLibraryCounts() {
  const { project } = useStudio();
  const assets = videoLibrary(project.library ?? []).length;
  const takes = project.shots.reduce((sum, shot) => sum + shot.takes.filter((take) => take.state === "succeeded" && take.asset).length, 0);
  const exports = project.exports.filter((record) => record.state === "succeeded" && record.asset).length;
  return { assets, takes, exports, total: assets + takes + exports };
}

/**
 * 開啟素材庫的大按鈕（主要樣式＋圖示＋數量）：toolbar＝Studio 工具列（一直顯示文字）；panel＝專案面板
 * 「素材」分頁頂端，佔滿整列並說明裡面有什麼。
 */
export function AssetLibraryButton({ placement = "toolbar", className }: { placement?: "toolbar" | "panel"; className?: string }) {
  const counts = useLibraryCounts();
  const title = t("開啟專案素材庫：參考素材 {assets}・渲染結果 {takes}・匯出成片 {exports}", { assets: counts.assets, takes: counts.takes, exports: counts.exports });
  const countPill = <span className="machine inline-flex min-w-6 items-center justify-center rounded-full bg-white/18 px-1.5 text-caption leading-5 font-semibold text-[#fff]">{counts.total}</span>;
  if (placement === "panel") {
    return (
      <Button variant="primary" onClick={() => openAssetLibrary()} title={title} className={cn("h-auto min-h-12 w-full justify-start gap-3 rounded-lg px-3 py-2 text-left", className)}>
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-white/15 [&_svg]:size-4.5">
          <Library />
        </span>
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate text-body font-semibold">{t("開啟素材庫")}</span>
          <span className="line-clamp-2 text-[11px] font-normal whitespace-normal text-[#fff]/80">{t("參考素材・渲染結果・匯出成片")}</span>
        </span>
        {countPill}
      </Button>
    );
  }
  return (
    <Button
      variant="primary"
      icon={<Library aria-hidden />}
      onClick={() => openAssetLibrary()}
      title={title}
      className={cn("h-10 min-w-0 shrink-0 rounded-full px-4 text-body [&_svg]:size-4.5", className)}
    >
      <span className="truncate">{t("素材庫")}</span>
      {countPill}
    </Button>
  );
}

/**
 * 素材庫對話框（掛在 Studio 工具列，一直掛著）：狀態在這裡，所以關閉後再開啟仍保留篩選、選取與捲動位置；上傳也在這裡。
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
  const [appliedSerial, setAppliedSerial] = useState(openState.serial);
  const [focusRequest, setFocusRequest] = useState(0);
  const scrollMemory = useRef(0);
  const listboxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // 從專案面板指定素材開啟：回到參考素材、清掉篩選並選取它（在 render 中依上一次的開啟序號調整狀態）
  if (openState.serial !== appliedSerial) {
    setAppliedSerial(openState.serial);
    if (openState.itemId) {
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
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
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
  const setSelection = (next: LibrarySelection) => setSelections((current) => ({ ...current, [section]: next }));
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
  const revealKey = `${section}|${kind}|${usage}|${shotFilter ?? ""}|${query.trim()}|${sort}|${descending ? 1 : 0}|${view}`;
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
            <Button variant="primary" icon={<Upload aria-hidden />} onClick={() => fileInput.current?.click()}>
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
    scrollMemoryRef: scrollMemory,
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
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
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
          <Button
            size="sm"
            className="ml-auto"
            icon={<Import aria-hidden />}
            onClick={() => setImporting(true)}
            aria-haspopup="dialog"
            title={t("從其他專案的素材庫挑選素材加進這個專案（使用同一個檔案，不重新上傳）")}
          >
            {t("從其他專案加入…")}
          </Button>
          <Button variant="primary" size="sm" icon={<Upload aria-hidden />} onClick={() => fileInput.current?.click()} title={t("上傳圖片、影片或聲音到專案素材庫（不會加到任何鏡頭）")}>
            {t("上傳")}
          </Button>
          <input
            ref={fileInput}
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
          <aside aria-label={t("素材分類")} className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-line-subtle bg-canvas/40 p-3">
            <nav aria-label={t("參考素材")} className="grid gap-0.5">
              <h3 className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-tertiary">{t("參考素材")}</h3>
              {KIND_FILTERS.map((entry) => (
                <CategoryButton
                  key={entry.id}
                  group="category"
                  active={section === "assets" && kind === entry.id}
                  label={entry.label}
                  icon={entry.icon}
                  count={kindCount(entry.id)}
                  onClick={() => {
                    changeSection("assets");
                    setKind(entry.id);
                  }}
                />
              ))}
            </nav>
            <nav aria-label={t("使用狀態")} className={cn("grid gap-0.5 transition-opacity duration-(--duration-fast)", section !== "assets" && "opacity-60")}>
              <h3 className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-tertiary">{t("使用狀態")}</h3>
              {USAGE_FILTERS.map((entry) => (
                <CategoryButton
                  key={entry.id}
                  group="usage"
                  active={section === "assets" && usage === entry.id}
                  label={entry.label}
                  icon={entry.icon}
                  count={usageCount(entry.id)}
                  onClick={() => {
                    changeSection("assets");
                    setUsage(entry.id);
                  }}
                />
              ))}
            </nav>
            <nav aria-label={t("渲染成品")} className="grid gap-0.5">
              <h3 className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-tertiary">{t("渲染成品")}</h3>
              <CategoryButton group="category" active={section === "takes" && shotFilter === null} label={t("渲染結果")} icon={Clapperboard} count={takeEntries.length} onClick={() => {
                changeSection("takes");
                setRenderShot(null);
              }} />
              <AnimatePresence initial={false}>
                {section === "takes" && renderShots.length > 0 ? (
                  <motion.div
                    key="shots"
                    role="group"
                    aria-label={t("依鏡頭篩選")}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={motionTransition("base", "standard")}
                    className="ml-3 grid grid-cols-1 gap-0.5 overflow-hidden border-l border-line-subtle pl-1.5"
                  >
                    {renderShots.map(({ shot, index, count }) => (
                      <ShotFilterButton key={shot.shot_id} active={shotFilter === shot.shot_id} index={index} title={shot.title} count={count} onClick={() => setRenderShot(shot.shot_id)} />
                    ))}
                  </motion.div>
                ) : null}
              </AnimatePresence>
              <CategoryButton group="category" active={section === "exports"} label={t("匯出成片")} icon={ListVideo} count={exportEntries.length} onClick={() => changeSection("exports")} />
            </nav>
            {uploads.tasks.length > 0 ? (
              <section aria-label={t("上傳")} className="grid gap-1">
                <h3 className="px-2.5 text-[11px] font-semibold tracking-wide text-fg-tertiary">{t("上傳")}</h3>
                <ul className="grid gap-0.5 rounded-lg border border-line-subtle bg-canvas/60 p-1" aria-live="polite">
                  {uploads.tasks.map((task) => (
                    <ReferenceUploadRow key={task.key} task={task} onRetry={() => uploads.retry(task.key)} onDismiss={() => uploads.dismiss(task.key)} />
                  ))}
                </ul>
              </section>
            ) : null}
            <div className="mt-auto grid gap-1 border-t border-line-subtle px-1 pt-3 text-caption text-fg-tertiary">
              <p>{t("參考素材合計 {size}", { size: totalSize(library) })}</p>
              {masks > 0 ? <p className="text-[11px] leading-4">{t("另有 {masks} 個 Image Studio 遮罩，只在 Image Studio 使用，這裡不列出。", { masks })}</p> : null}
            </div>
          </aside>

          {/* 中：工具列與項目 */}
          <section aria-label={section === "assets" ? t("素材") : section === "takes" ? t("渲染結果") : t("匯出成片")} className="relative flex min-h-0 min-w-0 flex-col">
            <div role="toolbar" aria-label={t("素材庫工具列")} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-2">
              <div className="relative min-w-48 flex-1">
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
                <Input
                  ref={searchRef}
                  compact
                  type="search"
                  value={query}
                  data-library-local-escape={query ? "" : undefined}
                  aria-label={t("搜尋素材")}
                  aria-keyshortcuts="Control+F Meta+F"
                  placeholder={section === "assets" ? t("搜尋名稱或備註（Ctrl／⌘＋F）") : t("搜尋鏡頭、prompt、seed 或 run（Ctrl／⌘＋F）")}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query) {
                      event.preventDefault();
                      setQuery("");
                    } else if (event.key === "ArrowDown" || event.key === "Enter") {
                      event.preventDefault();
                      listboxRef.current?.focus();
                    }
                  }}
                  className="pl-8"
                />
              </div>
              {section === "assets" ? (
                <div role="group" aria-label={t("類型")} className="flex items-center gap-0.5 rounded-lg border border-line-subtle bg-sunken/60 p-0.5">
                  {KIND_FILTERS.map((entry) => (
                    <ToggleButton key={entry.id} pressed={kind === entry.id} label={entry.label} onClick={() => setKind(entry.id)}>
                      <entry.icon aria-hidden />
                    </ToggleButton>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-1">
                <Select compact aria-label={t("排序方式")} value={sort} onChange={(event) => changeSort(event.target.value as LibrarySortKey)} className="w-32">
                  {LIBRARY_SORT_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {sortLabels[key]}
                    </option>
                  ))}
                </Select>
                <ToggleButton pressed={false} label={descending ? t("由大到小（按一下改成由小到大）") : t("由小到大（按一下改成由大到小）")} onClick={() => setDescending(!descending)}>
                  {descending ? <ArrowDownWideNarrow aria-hidden /> : <ArrowUpNarrowWide aria-hidden />}
                </ToggleButton>
              </div>
              <div role="group" aria-label={t("檢視方式")} className="flex items-center gap-0.5 rounded-lg border border-line-subtle bg-sunken/60 p-0.5">
                <ToggleButton pressed={view === "grid"} label={t("格狀檢視")} onClick={() => setView("grid")}>
                  <LayoutGrid aria-hidden />
                </ToggleButton>
                <ToggleButton pressed={view === "list"} label={t("清單檢視")} onClick={() => setView("list")}>
                  <List aria-hidden />
                </ToggleButton>
              </div>
              {view === "grid" ? (
                <label className="flex items-center gap-1.5 text-caption text-fg-tertiary" title={t("縮圖大小")}>
                  <ImageIcon aria-hidden className="size-3" />
                  <input type="range" min={120} max={320} step={8} value={thumb} onChange={(event) => setThumb(Number(event.target.value))} aria-label={t("縮圖大小")} className="w-24 accent-action" />
                  <ImageIcon aria-hidden className="size-4" />
                </label>
              ) : null}
              <ToggleButton pressed={detailsOpen} label={detailsOpen ? t("收起詳細資料") : t("展開詳細資料")} onClick={() => setDetailsOpen(!detailsOpen)}>
                {detailsOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
              </ToggleButton>
            </div>

            {section === "assets" ? (
              <LibraryCollection {...collectionProps} items={items} adapter={assetAdapter(uses)} label={t("素材")} onRename={rename} onRemove={requestRemove} />
            ) : (
              <LibraryCollection {...collectionProps} items={renders} adapter={section === "takes" ? TAKE_ADAPTER : EXPORT_ADAPTER} label={section === "takes" ? t("渲染結果") : t("匯出成片")} />
            )}

            <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-line-subtle px-3 text-caption text-fg-tertiary">
              <span className="machine">{filtered ? t("{shown} / {total} 個項目", { shown, total: sectionTotal }) : t("{total} 個項目", { total: sectionTotal })}</span>
              {selection.ids.size > 0 ? <span className="machine text-fg-secondary">{t("已選取 {count} 個", { count: selection.ids.size })}</span> : null}
              {filtered ? (
                <button type="button" onClick={clearFilters} className="pressable rounded px-1 text-action-fg hover:underline">
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
                    <button type="button" onClick={() => setNotice(null)} aria-label={t("關閉")} className="pressable shrink-0 rounded p-0.5 hover:bg-raised">
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
                  onJumpToShot={(shotId) => jumpToShot(shotId)}
                  onClearSelection={() => setSelection(NO_SELECTION)}
                />
              ) : (
                <RenderDetails
                  entry={focusRender}
                  selected={selectedRenders}
                  onExpand={setPreview}
                  onUseTake={(shotId, takeId) => actions.useTake(shotId, takeId)}
                  onJumpToShot={jumpToShot}
                  onClearSelection={() => setSelection(NO_SELECTION)}
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

        <AnimatePresence>
          {dropping ? (
            <motion.div
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={motionTransition("fast", "standard")}
              className={cn(
                "pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed backdrop-blur-sm",
                dropping === "accept" ? "border-brand-blue/70 bg-brand-soft" : "border-danger/70 bg-danger/10",
              )}
            >
              <motion.span
                key={dropping}
                initial={{ opacity: 0, y: 6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={motionTransition("spring-snappy", "spring-snappy")}
                className="material-popover grid justify-items-center gap-2 rounded-xl px-6 py-4 text-center"
              >
                {dropping === "accept" ? <Upload aria-hidden className="size-7 text-brand-cyan" /> : <Ban aria-hidden className="size-7 text-danger" />}
                <span className="text-body font-semibold text-fg">{dropping === "accept" ? t("放開以上傳到素材庫") : t("只能上傳圖片、影片或聲音")}</span>
                <span className="text-caption text-fg-tertiary">{dropping === "accept" ? t("圖片、影片或聲音會加進參考素材（不會加到任何鏡頭）；其他檔案會略過") : t("這些檔案不會上傳")}</span>
              </motion.span>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <LibraryRemoveDialog
          itemId={removing?.itemId ?? null}
          uses={(removing && uses.get(removing.itemId)) ?? NO_USES}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            const next = removing?.focusAfter ?? null;
            setSelections((current) => ({ ...current, assets: next ? selectOnly(next) : NO_SELECTION }));
            focusList();
          }}
        />
        <LibraryBulkRemoveDialog
          items={bulk === null ? null : library.filter((item) => bulk.includes(item.item_id))}
          uses={uses}
          onClose={() => setBulk(null)}
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
