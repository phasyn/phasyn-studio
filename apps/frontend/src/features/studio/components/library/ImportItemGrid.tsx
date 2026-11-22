// 「從其他專案加入…」的右欄：選到的專案的素材格（只掛看得到的列）、讀取中的骨架與一個可以勾選的素材磚。
import { Check, LoaderCircle } from "lucide-react";
import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { HUD_CHIP, LIFT, THUMB_ZOOM } from "@/components/ui/look";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { KindIcon } from "../../references/KindIcon";
import { KIND_LABEL } from "../../references/materials";
import { LibraryThumb } from "../../references/ReferenceRow";
import { itemDimensions, itemDuration, itemSize } from "./display";
import type { TileLayout } from "./libraryImport";
import { useEnter } from "./reveal";
import { RevealScope } from "./RevealScope";
import { virtualRows, type VirtualViewport } from "./useVirtualRows";
import { t } from "@/i18n";

const tileId = (baseId: string, itemId: string) => `${baseId}-item-${itemId}`;

/** 讀取中的素材格：與磚同樣大小的掃光骨架（兩列），上方一行讀取說明。 */
export function SkeletonGrid({ layout, label }: { layout: TileLayout; label: string }) {
  return (
    <div className="grid gap-3 animate-fade-in" style={{ padding: layout.pad }}>
      <p role="status" className="flex items-center gap-1.5 text-caption text-fg-tertiary">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
        {label}
      </p>
      <div aria-hidden className="grid" style={{ gridTemplateColumns: `repeat(${String(layout.columns)}, minmax(0, 1fr))`, gridAutoRows: layout.tileHeight, gap: layout.gap }}>
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
export function ItemGrid({ baseId, items, layout, viewport, scrollRef, gridRef, revealKey, checked, activeId, existing, label, onToggle, onKeyDown, onFocus }: GridProps) {
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
          <div className="grid" style={{ gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`, gridAutoRows: tileHeight, gap }}>
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
    <div /* eslint-disable-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/interactive-supports-focus -- The owning composite keeps keyboard focus and exposes the active option with aria-activedescendant. */
      ref={enter}
      id={id}
      role="option"
      aria-selected={checked}
      aria-disabled={taken || undefined}
      data-focused={active || undefined}
      title={taken ? t("這個檔案已在這個專案的素材庫（「{name}」）", { name: existing.name }) : item.name}
      onClick={(event) => { onToggle(item, event.shiftKey); }}
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
