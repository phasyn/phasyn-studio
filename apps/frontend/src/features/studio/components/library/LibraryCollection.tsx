// 素材庫的中央清單：格狀（縮圖磚，大小可調）或清單（欄位由內容決定：參考素材見 assetCards，渲染成品見 renderCards）。
// 一個 listbox（aria-multiselectable）＋aria-activedescendant：焦點留在清單上，方向鍵移動目前項目，Shift 延伸範圍，
// Ctrl／Cmd＋A 全選，Enter／空白鍵預覽，F2 改名，Delete 移除（只有參考素材有；由呼叫端確認，還在使用的不能移除）。
// 只掛看得到的列（useVirtualRows）；篩選或排序改變時清單重新依序進場，捲動時新掛上的項目不再播放進場動畫。
import { ArrowDown, ArrowUp } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react";
import { reveal } from "@/components/ui/motion";
import { LIFT, LIST_ROW, LIST_ROW_IDLE, LIST_ROW_SELECTED } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import type { LibrarySortKey } from "../../model/library";
import { selectAll, selectOnly, selectRange, toggleSelected, type LibrarySelection } from "./selection";
import { useViewport, virtualRows } from "./useVirtualRows";
import { t } from "@/i18n";

export type LibraryViewMode = "grid" | "list";

const GRID_GAP = 12;
/** 磚的外框（border＋padding）與下方兩行文字的高度（px）。 */
const TILE_CHROME = 14;
const TILE_CAPTION = 40;
const LIST_ROW_HEIGHT = 44;

export interface CollectionColumn {
  id: string;
  label: string;
  width: string;
  sort?: LibrarySortKey;
  align?: "end";
}

/** 清單與磚的內容（參考素材與渲染成品各一個）；外框、選取、鍵盤與視窗化在這裡共用。 */
export interface CollectionAdapter<T> {
  idOf: (item: T) => string;
  titleOf: (item: T) => string;
  /** 清單欄位（width＝中央區域寬度，窄的時候少放幾欄）。 */
  columns: (width: number) => CollectionColumn[];
  cell: (item: T, columnId: string) => ReactNode;
  /** 磚的內容：高 thumbHeight 的縮圖框＋兩行文字。 */
  tile: (item: T, thumbHeight: number) => ReactNode;
}

/** 格狀：一列幾個、縮圖與磚的高度；清單：固定列高。width＝捲動容器的寬度（含 p-3）。 */
function collectionLayout(width: number, view: LibraryViewMode, thumb: number) {
  if (view === "list") return { columnsCount: 1, thumbHeight: 0, tileHeight: 0, rowHeight: LIST_ROW_HEIGHT };
  const inner = Math.max(0, width - 24);
  const columnsCount = Math.max(1, Math.floor((inner + GRID_GAP) / (thumb + GRID_GAP)));
  const tileWidth = inner > 0 ? (inner - GRID_GAP * (columnsCount - 1)) / columnsCount : thumb;
  const thumbHeight = Math.max(40, Math.round((tileWidth - TILE_CHROME) * (9 / 16)));
  const tileHeight = thumbHeight + TILE_CHROME + TILE_CAPTION;
  return { columnsCount, thumbHeight, tileHeight, rowHeight: tileHeight + GRID_GAP };
}

const optionId = (base: string, itemId: string) => `${base}-${itemId}`;

export interface CollectionProps<T> {
  baseId: string;
  items: readonly T[];
  adapter: CollectionAdapter<T>;
  /** listbox 的名稱（「素材」、「渲染結果」…）。 */
  label: string;
  selection: LibrarySelection;
  onSelection: (next: LibrarySelection) => void;
  view: LibraryViewMode;
  thumb: number;
  sort: LibrarySortKey;
  descending: boolean;
  onSort: (key: LibrarySortKey) => void;
  /** 篩選、排序或檢視改變時換一個值：清單捲回頂端並重新依序進場。 */
  revealKey: string;
  /** 每次指定要選取的素材（從專案面板開啟）時加一：捲到那個素材。 */
  focusRequest: number;
  /** 上次的捲動位置（關閉對話框再開啟時回到原處）。 */
  scrollMemoryRef: RefObject<number>;
  listboxRef: RefObject<HTMLDivElement | null>;
  onOpen: (itemId: string) => void;
  /** 改名（F2）與移除（Delete）：只有參考素材有；沒有時按鍵不做事。 */
  onRename?: (itemId: string) => void;
  onRemove?: () => void;
  empty: ReactNode;
}

/** 一個項目的進場：清單（重新）掛上後、使用者還沒捲動前才播放。 */
function useEnter(scrolled: RefObject<boolean>, stagger: number) {
  return useCallback(
    (node: HTMLElement | null) => {
      if (!node || scrolled.current) return;
      return reveal(stagger)(node);
    },
    [scrolled, stagger],
  );
}

interface ItemProps<T> {
  item: T;
  itemId: string;
  title: string;
  id: string;
  selected: boolean;
  focused: boolean;
  stagger: number;
  scrolled: RefObject<boolean>;
  onPointer: (event: MouseEvent, itemId: string) => void;
  onOpen: (itemId: string) => void;
}

function GridTile<T>({ item, itemId, title, id, selected, focused, stagger, scrolled, onPointer, onOpen, thumbHeight, adapter }: ItemProps<T> & { thumbHeight: number; adapter: CollectionAdapter<T> }) {
  const enter = useEnter(scrolled, stagger);
  return (
    <div
      ref={enter}
      id={id}
      role="option"
      aria-selected={selected}
      data-focused={focused || undefined}
      onClick={(event) => onPointer(event, itemId)}
      onDoubleClick={() => onOpen(itemId)}
      // 滑過影片縮圖時無聲播放（離開時回到開頭）
      onMouseEnter={(event) => void event.currentTarget.querySelector("video")?.play().catch(() => undefined)}
      onMouseLeave={(event) => {
        const video = event.currentTarget.querySelector("video");
        if (!video) return;
        video.pause();
        video.currentTime = 0.1;
      }}
      title={title}
      className={cn(
        "group/tile relative grid cursor-default content-start gap-1 rounded-xl border bg-canvas/60 p-1.5 select-none",
        LIFT,
        selected ? "border-brand-blue/80 bg-brand-gradient-soft shadow-glow-sm" : "border-line-subtle hover:border-line-strong",
        "data-focused:outline-offset-2 group-focus-visible/listbox:data-focused:outline-2 group-focus-visible/listbox:data-focused:outline-focus",
      )}
    >
      {adapter.tile(item, thumbHeight)}
    </div>
  );
}

function ListRow<T>({ item, itemId, title, id, selected, focused, stagger, scrolled, onPointer, onOpen, columns, template, adapter }: ItemProps<T> & { columns: CollectionColumn[]; template: string; adapter: CollectionAdapter<T> }) {
  const enter = useEnter(scrolled, stagger);
  return (
    <div
      ref={enter}
      id={id}
      role="option"
      aria-selected={selected}
      data-focused={focused || undefined}
      onClick={(event) => onPointer(event, itemId)}
      onDoubleClick={() => onOpen(itemId)}
      title={title}
      style={{ gridTemplateColumns: template, height: LIST_ROW_HEIGHT }}
      className={cn(
        "grid cursor-default items-center gap-3 border-b border-line-subtle/60 px-3 text-caption text-fg-secondary select-none",
        LIST_ROW,
        selected ? LIST_ROW_SELECTED : LIST_ROW_IDLE,
        "group-focus-visible/listbox:data-focused:outline-2 group-focus-visible/listbox:data-focused:-outline-offset-2 group-focus-visible/listbox:data-focused:outline-focus",
      )}
    >
      {columns.map((column) => (
        <span key={column.id} className={cn("flex min-w-0", column.align === "end" && "justify-end")}>
          {adapter.cell(item, column.id)}
        </span>
      ))}
    </div>
  );
}

/** 清單的欄位標題（可排序的欄位是按鈕；目前的排序顯示方向箭頭）。 */
function ListHeader({ columns, template, sort, descending, onSort }: { columns: CollectionColumn[]; template: string; sort: LibrarySortKey; descending: boolean; onSort: (key: LibrarySortKey) => void }) {
  return (
    <div style={{ gridTemplateColumns: template }} className="grid h-8 shrink-0 items-center gap-3 border-b border-line-subtle bg-surface px-3 text-caption font-medium text-fg-tertiary">
      {columns.map((column) =>
        column.sort ? (
          <button
            key={column.id}
            type="button"
            onClick={() => column.sort && onSort(column.sort)}
            aria-label={t("依「{label}」排序", { label: column.label })}
            className={cn(
              "pressable flex min-w-0 items-center gap-1 rounded px-0.5 hover:text-fg",
              column.align === "end" && "justify-end",
              sort === column.sort && "text-fg-secondary",
            )}
          >
            <span className="truncate">{column.label}</span>
            {sort === column.sort ? descending ? <ArrowDown aria-hidden className="size-3 text-brand-cyan" /> : <ArrowUp aria-hidden className="size-3 text-brand-cyan" /> : null}
          </button>
        ) : (
          <span key={column.id} className={cn("flex min-w-0 truncate", column.align === "end" && "justify-end")}>
            {column.label}
          </span>
        ),
      )}
    </div>
  );
}

/**
 * 進場的範圍：每次（重新）掛上時是「還沒捲動」，項目依序進場；之後一捲動，新掛上的項目就直接出現。
 * 以 key＝revealKey 掛上，所以篩選或排序改變時重新開始。
 */
function RevealScope({ scrollRef, style, children }: { scrollRef: RefObject<HTMLElement | null>; style: CSSProperties; children: (scrolled: RefObject<boolean>) => ReactNode }) {
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const mark = () => {
      scrolled.current = true;
    };
    element.addEventListener("scroll", mark, { passive: true });
    return () => element.removeEventListener("scroll", mark);
  }, [scrollRef]);
  return <div style={style}>{children(scrolled)}</div>;
}

export function LibraryCollection<T>(props: CollectionProps<T>) {
  const { baseId, items, adapter, label, selection, onSelection, view, thumb, sort, descending, onSort, revealKey, focusRequest, scrollMemoryRef, listboxRef, onOpen, onRename, onRemove, empty } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewport = useViewport(scrollRef, view);
  const firstKey = useRef(revealKey);
  const handledFocus = useRef(0);
  const mounted = useRef(false);
  const layout = collectionLayout(viewport.width, view, thumb);
  const { columnsCount, thumbHeight, tileHeight, rowHeight } = layout;
  const rowCount = Math.ceil(items.length / columnsCount);
  const range = virtualRows(viewport, rowCount, rowHeight);
  const columns = adapter.columns(viewport.width);
  const template = columns.map((column) => column.width).join(" ");
  const order = items.map((item) => adapter.idOf(item));
  const focusIndex = selection.focus === null ? -1 : order.indexOf(selection.focus);
  const focusVisible = focusIndex >= range.start * columnsCount && focusIndex < range.end * columnsCount;

  // 開啟時回到上次的捲動位置；篩選、排序或檢視改變時回到頂端並重新進場；指定了素材（focusRequest）時捲到它
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const changed = firstKey.current !== revealKey;
    firstKey.current = revealKey;
    if (focusRequest !== handledFocus.current) {
      handledFocus.current = focusRequest;
      if (focusIndex >= 0) {
        // 剛掛上時還沒量到寬度：直接用容器的寬度算這一列的位置
        const now = collectionLayout(element.clientWidth, view, thumb);
        element.scrollTop = Math.max(0, Math.floor(focusIndex / now.columnsCount) * now.rowHeight - element.clientHeight / 3);
        mounted.current = true;
        return;
      }
    }
    if (!mounted.current) element.scrollTop = scrollMemoryRef.current;
    else if (changed) element.scrollTop = 0;
    mounted.current = true;
  }, [revealKey, scrollMemoryRef, focusRequest, focusIndex, view, thumb]);

  /** 讓第 index 個項目在捲動範圍內（鍵盤移動時）。 */
  const scrollToIndex = (index: number) => {
    const element = scrollRef.current;
    if (!element) return;
    const top = Math.floor(index / columnsCount) * rowHeight + (view === "grid" ? 12 : 0);
    const bottom = top + rowHeight;
    if (top < element.scrollTop) element.scrollTop = Math.max(0, top - 12);
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight + 12;
  };

  const move = (event: KeyboardEvent, to: number) => {
    event.preventDefault();
    const index = Math.min(order.length - 1, Math.max(0, to));
    const id = order[index];
    if (id === undefined) return;
    onSelection(event.shiftKey ? selectRange(selection, order, id, event.ctrlKey || event.metaKey) : selectOnly(id));
    scrollToIndex(index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (order.length === 0) return;
    const at = focusIndex < 0 ? -1 : focusIndex;
    const mod = event.ctrlKey || event.metaKey;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? rowHeight) / rowHeight)) * columnsCount;
    switch (event.key) {
      case "ArrowRight":
        if (view === "grid") move(event, at + 1);
        return;
      case "ArrowLeft":
        if (view === "grid") move(event, at < 0 ? 0 : at - 1);
        return;
      case "ArrowDown":
        move(event, at < 0 ? 0 : at + columnsCount);
        return;
      case "ArrowUp":
        move(event, at < 0 ? 0 : at - columnsCount);
        return;
      case "PageDown":
        move(event, at < 0 ? 0 : at + page);
        return;
      case "PageUp":
        move(event, at < 0 ? 0 : at - page);
        return;
      case "Home":
        move(event, 0);
        return;
      case "End":
        move(event, order.length - 1);
        return;
      case "Enter":
      case " ":
        if (selection.focus === null) return;
        event.preventDefault();
        onOpen(selection.focus);
        return;
      case "F2":
        if (selection.focus === null || !onRename) return;
        event.preventDefault();
        onRename(selection.focus);
        return;
      case "Delete":
      case "Backspace":
        if (selection.ids.size === 0 || event.altKey || mod || !onRemove) return;
        event.preventDefault();
        onRemove();
        return;
      default:
        if (mod && event.key.toLowerCase() === "a") {
          event.preventDefault();
          onSelection(selectAll(order, selection.focus));
        }
    }
  };

  const onPointer = (event: MouseEvent, itemId: string) => {
    if (event.shiftKey) onSelection(selectRange(selection, order, itemId, event.ctrlKey || event.metaKey));
    else if (event.ctrlKey || event.metaKey) onSelection(toggleSelected(selection, itemId));
    else onSelection(selectOnly(itemId));
  };

  const visible = items.slice(range.start * columnsCount, range.end * columnsCount);
  const itemProps = (item: T, offset: number, scrolled: RefObject<boolean>): ItemProps<T> => {
    const itemId = adapter.idOf(item);
    return {
    item,
    itemId,
    title: adapter.titleOf(item),
    id: optionId(baseId, itemId),
    selected: selection.ids.has(itemId),
    focused: selection.focus === itemId,
    stagger: offset,
    scrolled,
    onPointer,
    onOpen,
    };
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {view === "list" && items.length > 0 ? <ListHeader columns={columns} template={template} sort={sort} descending={descending} onSort={onSort} /> : null}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          scrollMemoryRef.current = event.currentTarget.scrollTop;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {items.length === 0 ? (
          empty
        ) : (
          <div
            ref={listboxRef}
            role="listbox"
            tabIndex={0}
            aria-multiselectable
            aria-label={label}
            aria-activedescendant={focusVisible && selection.focus !== null ? optionId(baseId, selection.focus) : undefined}
            aria-keyshortcuts={onRemove ? "Enter F2 Delete Control+A" : "Enter Control+A"}
            onKeyDown={onKeyDown}
            onFocus={() => {
              // 用 Tab 進來時沒有目前項目：選第一個（不捲動）
              if (selection.focus === null && order[0] !== undefined) onSelection(selectOnly(order[0]));
            }}
            className={cn("group/listbox outline-none", view === "grid" ? "p-3" : "")}
          >
            <RevealScope key={revealKey} scrollRef={scrollRef} style={{ paddingTop: range.padTop, paddingBottom: Math.max(0, range.padBottom - (view === "grid" ? GRID_GAP : 0)) }}>
              {(scrolled) =>
                view === "grid" ? (
                  <div className="grid" style={{ gridTemplateColumns: `repeat(${columnsCount}, minmax(0, 1fr))`, gridAutoRows: tileHeight, gap: GRID_GAP }}>
                    {visible.map((item, offset) => (
                      <GridTile key={adapter.idOf(item)} {...itemProps(item, offset, scrolled)} thumbHeight={thumbHeight} adapter={adapter} />
                    ))}
                  </div>
                ) : (
                  visible.map((item, offset) => <ListRow key={adapter.idOf(item)} {...itemProps(item, offset, scrolled)} columns={columns} template={template} adapter={adapter} />)
                )
              }
            </RevealScope>
          </div>
        )}
      </div>
    </div>
  );
}
