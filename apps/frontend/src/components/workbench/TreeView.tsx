import { ChevronRight, Ellipsis } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { DOT_TONE, TEXT_TONE } from "./tones";
import {
  autoScrollStep,
  passedDragThreshold,
  rowAtY,
  sameIndicator,
  visibleRows,
  type TreeDropIndicator,
  type TreeDropResult,
  type TreeItem,
  type TreeRow,
  type VerticalRect,
} from "./treeModel";
import { t } from "@/i18n";

const INDENT = 14;

/** 動作選單的錨點：指標位置（右鍵）或觸發元件（⋯ 按鈕、Shift+F10）。 */
export type TreeMenuAnchor = { kind: "point"; x: number; y: number } | { kind: "element"; element: HTMLElement };

/** opt-in 拖曳排序：指標事件＋pointer capture（不用 HTML5 drag and drop、不需要額外套件）。 */
export interface TreeDragOptions<D> {
  /** 可以拖曳的項目。 */
  canDrag: (item: TreeItem) => boolean;
  /** 指標在 over 列（fraction＝列內相對高度 0–1）時的放置結果；不能放、或放了不會改變時回傳 null。 */
  resolve: (sourceId: string, over: TreeRow, fraction: number, rows: readonly TreeRow[]) => TreeDropResult<D> | null;
  /** 放開：執行放置（呼叫端負責保存與宣告結果）。 */
  onDrop: (sourceId: string, drop: D) => void;
  /** Esc 取消了拖曳（呼叫端可宣告）。 */
  onCancel?: (sourceId: string) => void;
}

/** opt-in 動作選單：右鍵、Shift+F10／選單鍵、列上的 ⋯ 按鈕；選單本身由呼叫端繪製。 */
export interface TreeMenuOptions {
  /** 選單元素的 id（⋯ 按鈕的 aria-controls）。 */
  menuId: string;
  /** 目前開著選單的項目。 */
  openId: string | null;
  has: (item: TreeItem) => boolean;
  /** ⋯ 按鈕與選單的名稱，例如「「t2va」的動作」。 */
  label: (item: TreeItem) => string;
  open: (item: TreeItem, anchor: TreeMenuAnchor, returnFocus: HTMLElement, focus: "first" | "last") => void;
  close: () => void;
}

interface DragSession<D> {
  sourceId: string;
  pointerId: number;
  element: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  /** Esc 取消後仍等放開，用來吃掉放開後的 click。 */
  cancelled: boolean;
  result: TreeDropResult<D> | null;
  scroller: HTMLElement | null;
  frame: number;
  detach: () => void;
}

interface DragView {
  sourceId: string;
  indicator: TreeDropIndicator | null;
}

/** 最近的垂直捲動容器（面板內容區）。 */
function scrollOwner(node: HTMLElement | null): HTMLElement | null {
  for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
    const overflow = getComputedStyle(current).overflowY;
    if (overflow === "auto" || overflow === "scroll") return current;
  }
  return null;
}

/** 拖曳放開後瀏覽器仍會送出 click：吃掉這一次，避免放開時也被當成點選（開啟項目）。 */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

function isMenuKey(event: KeyboardEvent): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey);
}

/**
 * WAI-ARIA tree（扁平列＋aria-level）：單一 Tab 停駐點；↑↓ 移動、→ 展開／進入子項、← 收合／回上層、
 * Home／End、Enter／Space 開啟。點列＝開啟（有子項時同時展開），點箭頭＝只切換展開。
 *
 * opt-in（沒傳就和原本完全相同）：
 * - drag：滑鼠／觸控筆按住列拖曳（移動 4 px 以上才開始；沒移動的點選照常開啟）；插入線或資料夾高亮、
 *   被拖曳的列變淡、靠近捲動區上下緣自動捲動、Esc 取消。
 * - onMoveKey：Alt+↑／↓ 移動聚焦的項目（移動後焦點跟著項目）。
 * - menu：右鍵、Shift+F10／選單鍵、列上的 ⋯ 按鈕開啟動作選單。
 * - highlightId：剛移動過的列短暫標示。
 */
export function TreeView<D = never>({
  items,
  label,
  selectedId,
  expanded,
  onToggle,
  onActivate,
  className,
  drag,
  onMoveKey,
  menu,
  highlightId = null,
  instructions,
}: {
  items: readonly TreeItem[];
  label: string;
  selectedId: string | null;
  expanded: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  onActivate: (item: TreeItem) => void;
  className?: string;
  drag?: TreeDragOptions<D>;
  /** 回傳 true＝已移動（焦點會跟著項目）。 */
  onMoveKey?: (item: TreeItem, direction: -1 | 1) => boolean;
  menu?: TreeMenuOptions;
  highlightId?: string | null;
  /** 給輔助技術的操作說明（以 aria-describedby 連到樹）。 */
  instructions?: string;
}) {
  const rows = visibleRows(items, expanded);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dragView, setDragView] = useState<DragView | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const treeRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const session = useRef<DragSession<D> | null>(null);
  const latest = useRef({ rows, drag });
  const instructionsId = useId();
  const interactive = Boolean(drag || onMoveKey || menu);
  const current =
    rows.find((row) => row.item.id === focusedId) ?? rows.find((row) => row.item.id === selectedId) ?? rows[0] ?? null;

  // 拖曳中的事件處理讀最新的列與設定（資料可能在拖曳中重新讀取）
  useLayoutEffect(() => {
    latest.current = { rows, drag };
  });

  // 拖曳開始時把預覽放到指標旁（之後由 pointermove 直接更新，不重新 render）
  useLayoutEffect(() => {
    const active = session.current;
    if (dragView && active && ghostRef.current) ghostRef.current.style.transform = `translate(${active.x + 14}px, ${active.y + 12}px)`;
  }, [dragView]);

  // 卸載時結束進行中的拖曳（移除 window 監聽）
  useLayoutEffect(
    () => () => {
      const active = session.current;
      if (!active) return;
      active.detach();
      session.current = null;
    },
    [],
  );

  const focusRow = (row: TreeRow | undefined) => {
    if (!row) return;
    setFocusedId(row.item.id);
    refs.current.get(row.item.id)?.focus();
  };

  /** 移動後列可能換了位置（DOM 節點被移動會失去焦點）：下一個畫面再聚焦回來。 */
  const refocusLater = (id: string) => {
    requestAnimationFrame(() => {
      const element = refs.current.get(id);
      if (element && document.activeElement !== element) element.focus();
    });
  };

  const openMenu = (item: TreeItem, anchor: TreeMenuAnchor, focus: "first" | "last" = "first") => {
    const element = refs.current.get(item.id);
    if (!menu || !element || !menu.has(item)) return;
    menu.open(item, anchor, element, focus);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) => {
    if (onMoveKey && event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (onMoveKey(row.item, event.key === "ArrowUp" ? -1 : 1)) refocusLater(row.item.id);
      return;
    }
    if (menu && isMenuKey(event)) {
      event.preventDefault();
      openMenu(row.item, { kind: "element", element: event.currentTarget });
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        focusRow(rows[index + 1]);
        break;
      case "ArrowUp":
        focusRow(rows[index - 1]);
        break;
      case "Home":
        focusRow(rows[0]);
        break;
      case "End":
        focusRow(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (row.hasChildren && !row.expanded) onToggle(row.item.id, true);
        else if (row.hasChildren) focusRow(rows[index + 1]);
        break;
      case "ArrowLeft":
        if (row.hasChildren && row.expanded) onToggle(row.item.id, false);
        else if (row.parentId) focusRow(rows.find((candidate) => candidate.item.id === row.parentId));
        break;
      case "Enter":
      case " ":
        onActivate(row.item);
        if (row.hasChildren && !row.expanded) onToggle(row.item.id, true);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // ------------------------------------------------------------ 拖曳
  /** 指標下方的列與放置結果（只看樹在捲動區內可見的範圍；水平超出樹＝沒有目標）。 */
  const resolveAt = (active: DragSession<D>): TreeDropResult<D> | null => {
    const tree = treeRef.current;
    const options = latest.current.drag;
    if (!tree || !options) return null;
    const box = tree.getBoundingClientRect();
    const view = active.scroller?.getBoundingClientRect();
    const top = Math.max(box.top, view?.top ?? box.top);
    const bottom = Math.min(box.bottom, view?.bottom ?? box.bottom);
    if (active.x < box.left || active.x > box.right || bottom <= top) return null;
    const visible = latest.current.rows;
    const rects: VerticalRect[] = visible.map((row) => refs.current.get(row.item.id)?.getBoundingClientRect() ?? { top: 0, bottom: 0 });
    const at = rowAtY(rects, Math.min(Math.max(active.y, top), bottom - 1));
    const over = at ? visible[at.index] : undefined;
    if (!at || !over) return null;
    return options.resolve(active.sourceId, over, at.fraction, visible);
  };

  const showResult = (active: DragSession<D>) => {
    if (!active.active || active.cancelled) return;
    const result = resolveAt(active);
    active.result = result;
    setDragView((view) => (view && sameIndicator(view.indicator, result?.indicator ?? null) ? view : { sourceId: active.sourceId, indicator: result?.indicator ?? null }));
  };

  const autoScroll = (active: DragSession<D>) => {
    active.frame = requestAnimationFrame(() => {
      if (session.current !== active || !active.active || active.cancelled) return;
      const scroller = active.scroller;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const step = autoScrollStep(active.y, rect.top, rect.bottom);
        if (step !== 0) {
          const before = scroller.scrollTop;
          scroller.scrollTop = before + step;
          if (scroller.scrollTop !== before) showResult(active);
        }
      }
      autoScroll(active);
    });
  };

  const finish = (active: DragSession<D>, commit: boolean) => {
    active.detach();
    cancelAnimationFrame(active.frame);
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    if (session.current === active) session.current = null;
    if (!active.active) return;
    swallowNextClick();
    setDragView(null);
    const options = latest.current.drag;
    if (commit && !active.cancelled && active.result && options) options.onDrop(active.sourceId, active.result.drop);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, item: TreeItem) => {
    if (!drag || session.current || event.button !== 0 || event.pointerType === "touch") return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !drag.canDrag(item)) return;
    const element = event.currentTarget;
    const active: DragSession<D> = {
      sourceId: item.id,
      pointerId: event.pointerId,
      element,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      cancelled: false,
      result: null,
      scroller: null,
      frame: 0,
      detach: () => undefined,
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== active.pointerId || active.cancelled) return;
      active.x = moveEvent.clientX;
      active.y = moveEvent.clientY;
      if (!active.active) {
        if (!passedDragThreshold(active.x - active.startX, active.y - active.startY)) return;
        active.active = true;
        try {
          element.setPointerCapture(active.pointerId);
        } catch {
          // 指標已放開：window 監聽仍會收到 pointerup
        }
        active.scroller = scrollOwner(treeRef.current);
        window.getSelection()?.removeAllRanges();
        setDragView({ sourceId: active.sourceId, indicator: null });
        autoScroll(active);
      }
      if (ghostRef.current) ghostRef.current.style.transform = `translate(${active.x + 14}px, ${active.y + 12}px)`;
      showResult(active);
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === active.pointerId) finish(active, true);
    };
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === active.pointerId) finish(active, false);
    };
    const escape = (keyEvent: globalThis.KeyboardEvent) => {
      if (keyEvent.key !== "Escape" || !active.active || active.cancelled) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      active.cancelled = true;
      active.result = null;
      cancelAnimationFrame(active.frame);
      setDragView(null);
      latest.current.drag?.onCancel?.(active.sourceId);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
    active.detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
    };
    session.current = active;
  };

  const dragged = dragView ? rows.find((row) => row.item.id === dragView.sourceId)?.item : undefined;
  const GhostIcon = dragged?.icon;

  return (
    <>
      <div
        ref={treeRef}
        role="tree"
        aria-label={label}
        aria-describedby={instructions ? instructionsId : undefined}
        className={cn("grid grid-cols-[minmax(0,1fr)] content-start py-1", className)}
      >
        {rows.map((row, index) => {
          const { item } = row;
          const selected = item.id === selectedId;
          const Icon = item.icon;
          const indicator = dragView?.indicator?.rowId === item.id ? dragView.indicator : null;
          const isSource = dragView?.sourceId === item.id;
          const hasMenu = Boolean(menu?.has(item));
          const menuOpen = hasMenu && menu?.openId === item.id;
          const movable = Boolean(drag?.canDrag(item));
          const shortcuts = [movable && onMoveKey ? "Alt+ArrowUp Alt+ArrowDown" : null, hasMenu ? "Shift+F10" : null].filter(Boolean).join(" ");
          return (
            <div
              key={item.id}
              ref={(node) => {
                if (node) refs.current.set(item.id, node);
                else refs.current.delete(item.id);
              }}
              role="treeitem"
              data-tree-item={item.id}
              aria-level={row.level}
              aria-posinset={row.posinset}
              aria-setsize={row.setsize}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              aria-selected={selected}
              aria-keyshortcuts={shortcuts || undefined}
              tabIndex={current?.item.id === item.id ? 0 : -1}
              title={item.title ?? item.label}
              onFocus={() => setFocusedId(item.id)}
              onClick={() => {
                onActivate(item);
                if (row.hasChildren && !row.expanded) onToggle(item.id, true);
              }}
              onKeyDown={(event) => onKeyDown(event, row, index)}
              onPointerDown={drag ? (event) => onPointerDown(event, item) : undefined}
              onContextMenu={
                hasMenu
                  ? (event) => {
                      event.preventDefault();
                      openMenu(item, { kind: "point", x: event.clientX, y: event.clientY });
                    }
                  : undefined
              }
              className={cn(
                "group relative mx-1.5 flex h-7 cursor-default items-center gap-1.5 rounded-md pr-2 text-data outline-none select-none",
                "focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
                selected ? "bg-brand-gradient-soft text-fg" : "text-fg-secondary hover:bg-raised hover:text-fg",
                interactive && "transition-[background-color,color,opacity] duration-150 ease-(--ease-standard)",
                highlightId === item.id && !selected && "bg-brand-soft",
                indicator?.position === "inside" && "bg-brand-soft ring-1 ring-brand-blue/70 ring-inset",
                isSource && "cursor-grabbing opacity-45",
              )}
              style={{ paddingLeft: 6 + (row.level - 1) * INDENT }}
            >
              {selected ? (
                <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-[image:linear-gradient(180deg,var(--color-brand-cyan),var(--color-brand-blue),var(--color-brand-violet))]" />
              ) : null}
              {Array.from({ length: row.level - 1 }, (_, depth) => (
                <span
                  key={depth}
                  aria-hidden
                  className="absolute inset-y-0 w-px bg-line-subtle"
                  style={{ left: 6 + depth * INDENT + 7 }}
                />
              ))}
              {indicator && indicator.position !== "inside" ? (
                <span
                  aria-hidden
                  className={cn("pointer-events-none absolute right-1 z-10 h-0.5 rounded-full bg-brand-gradient", indicator.position === "before" ? "-top-px" : "-bottom-px")}
                  style={{ left: 6 + ((indicator.level ?? row.level) - 1) * INDENT + 4 }}
                >
                  <span className="absolute -top-[3px] -left-1 size-2 rounded-full border-2 border-brand-cyan bg-surface" />
                </span>
              ) : null}
              <span
                aria-hidden
                onClick={(event) => {
                  if (!row.hasChildren) return;
                  event.stopPropagation();
                  onToggle(item.id, !row.expanded);
                }}
                className={cn("grid size-4 shrink-0 place-items-center rounded-sm", row.hasChildren && "hover:bg-overlay")}
              >
                {row.hasChildren ? (
                  <ChevronRight className={cn("size-3.5 text-fg-tertiary transition-transform duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)", row.expanded && "rotate-90")} />
                ) : null}
              </span>
              {Icon ? <Icon aria-hidden className={cn("size-4 shrink-0", item.iconTone ? TEXT_TONE[item.iconTone] : "text-fg-tertiary")} /> : null}
              <span className={cn("min-w-0 flex-1 truncate", item.muted && "text-fg-tertiary", selected && "font-medium")}>{item.label}</span>
              {item.detail ? <span className="machine max-w-24 shrink-0 truncate text-caption text-fg-tertiary">{item.detail}</span> : null}
              {item.count !== undefined && item.count !== null ? (
                <span className="machine shrink-0 rounded-sm bg-raised px-1 text-caption text-fg-tertiary">{item.count}</span>
              ) : null}
              {item.dot ? (
                <span className="flex shrink-0 items-center" title={item.dotLabel}>
                  <span aria-hidden className={cn("size-2 rounded-full", DOT_TONE[item.dot])} />
                  {item.dotLabel ? <span className="sr-only">{item.dotLabel}</span> : null}
                </span>
              ) : null}
              {menu && hasMenu ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-controls={menuOpen ? menu.menuId : undefined}
                  aria-label={menu.label(item)}
                  title={t("{item}（右鍵或 Shift+F10）", { item: menu.label(item) })}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (menuOpen) menu.close();
                    else openMenu(item, { kind: "element", element: event.currentTarget });
                  }}
                  className={cn(
                    "-mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-fg-tertiary opacity-0 transition-opacity duration-150 hover:bg-overlay hover:text-fg",
                    "group-hover:opacity-100 group-focus-within:opacity-100 group-aria-selected:opacity-100 aria-expanded:opacity-100 aria-expanded:text-action-fg pointer-coarse:opacity-100",
                  )}
                >
                  <Ellipsis aria-hidden className="size-4" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {instructions ? (
        <p id={instructionsId} className="sr-only">
          {instructions}
        </p>
      ) : null}
      {dragView && dragged
        ? createPortal(
            <div
              ref={ghostRef}
              aria-hidden
              className="pointer-events-none fixed top-0 left-0 z-50 flex max-w-64 scale-[1.02] rotate-[0.8deg] items-center gap-1.5 rounded-md border border-[rgb(255_255_255_/_0.1)] bg-overlay/95 px-2 py-1 text-data text-fg shadow-window animate-fade-in"
            >
              {GhostIcon ? <GhostIcon className={cn("size-4 shrink-0", dragged.iconTone ? TEXT_TONE[dragged.iconTone] : "text-fg-tertiary")} /> : null}
              <span className="truncate">{dragged.label}</span>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
