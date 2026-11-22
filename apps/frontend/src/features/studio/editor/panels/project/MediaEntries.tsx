// One item of the Project panel, as a 36 px list row or as a grid cell with a thumbnail. Both are rows of the
// panel's grid: focusing one selects it, a double click loads it into the Source monitor, dragging it carries the
// source towards the timeline, and its "⋯" button (or a right click) opens its menu. A shot that is not rendered is
// drawn back; a shot whose shorter take waits carries a badge and the one-click action that applies it.
import { Clapperboard, Ellipsis, Gauge, LoaderCircle, MonitorPlay, Scissors, TriangleAlert, type LucideIcon } from "lucide-react";
import type { DragEvent, MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LIST_ROW, LIST_ROW_IDLE, LIST_ROW_SELECTED, OPTION_CARD, OPTION_IDLE, OPTION_SELECTED, TOOL_BUTTON } from "@/components/ui/look";
import type { MenuAnchor } from "@/components/ui/menuModel";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatTimecode } from "../../../model/frames";
import { KindIcon } from "../../../references/KindIcon";
import { endSourceDrag, writeSourceDrag } from "../../dragSource";
import { mediaTitle, type MediaItem, type ProxyState } from "./media";
import { APPLY_SHORTER_HINT } from "./mediaMenu";
import { MediaThumb } from "./MediaThumb";

export interface MediaEntryProps {
  item: MediaItem;
  /** Place in the list (the entrance stagger). */
  index: number;
  fps: number;
  selected: boolean;
  /** The entry the Tab key lands on (the selected one, else the first). */
  tabbable: boolean;
  /** It is what the Source monitor shows. */
  loaded: boolean;
  menuId: string;
  menuOpen: boolean;
  /** Its shorter take is being applied. */
  applying: boolean;
  onSelect: () => void;
  onOpen: () => void;
  /** Opens the item's menu at a pointer position or under its button; the entry gets the focus back when it closes. */
  onMenu: (anchor: MenuAnchor, entry: HTMLElement) => void;
  onMenuClose: () => void;
  onApplyShorter: () => void;
}

const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset";

const PROXY_MARKS: Record<Exclude<ProxyState, "none">, { icon: LucideIcon; tone: string }> = {
  building: { icon: LoaderCircle, tone: "text-info [&_svg]:animate-spin" },
  ready: { icon: Gauge, tone: "text-fg-secondary" },
  failed: { icon: TriangleAlert, tone: "text-danger" },
};

function proxyLabel(item: MediaItem): string {
  if (item.proxy === "building") return t("代理媒體正在建立");
  if (item.proxy === "ready") return t("代理已完成並通過影格數、影格率與來源核對");
  return t("代理建立失敗：{error}", { error: item.source.proxy_error ?? "" });
}

/** A shot's take carries the Video Studio's clapperboard; uploaded media the icon of its kind. */
function MediaIcon({ item, className }: { item: MediaItem; className?: string }) {
  if (!(item.source.shot_id != null && item.source.shot_id !== "")) return <KindIcon kind={item.kind} {...(className === undefined ? {} : { className })} />;
  return <Clapperboard aria-hidden className={cn("size-4 shrink-0", item.pending ? "text-fg-tertiary" : "text-brand-cyan", className)} />;
}

/** A small sign after the name, named for assistive technology and in its tooltip. */
function StateMark({ label, icon: Icon, tone }: { label: string; icon: LucideIcon; tone: string }) {
  return (
    <span role="img" aria-label={label} title={label} className={cn("flex shrink-0 [&_svg]:size-3.5", tone)}>
      <Icon aria-hidden />
    </span>
  );
}

/** What is true of the item beyond its name: the Source monitor shows it, and the state of its proxy. */
function StateMarks({ item, loaded }: { item: MediaItem; loaded: boolean }) {
  const proxy = item.proxy === "none" ? null : PROXY_MARKS[item.proxy];
  return (
    <>
      {loaded ? <StateMark label={t("已在來源監看器開啟")} icon={MonitorPlay} tone="text-brand-cyan" /> : null}
      {proxy ? <StateMark label={proxyLabel(item)} icon={proxy.icon} tone={proxy.tone} /> : null}
    </>
  );
}

interface MenuButtonProps {
  item: MediaItem;
  menuId: string;
  open: boolean;
  onOpen: MediaEntryProps["onMenu"];
  onClose: () => void;
  className?: string;
}

/** The entry's "⋯": reached with the pointer; the keyboard opens the same menu from the entry (Shift+F10). */
function MenuButton({ item, menuId, open, onOpen, onClose, className }: MenuButtonProps) {
  const label = t("「{name}」的動作", { name: item.name });
  const toggle = (button: HTMLElement) => {
    if (open) onClose();
    else onOpen({ kind: "element", element: button }, button.closest<HTMLElement>("[data-media-item]") ?? button);
  };
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={label}
      title={label}
      onClick={(event) => { toggle(event.currentTarget); }}
      className={cn(TOOL_BUTTON, "text-fg-tertiary aria-expanded:bg-brand-gradient-soft aria-expanded:text-fg", className)}
    >
      <Ellipsis aria-hidden />
    </button>
  );
}

function ShorterTakeBadge() {
  return (
    <Badge tone="warning">
      <TriangleAlert aria-hidden />
      {t("新 take 較短")}
    </Badge>
  );
}

function ShorterTakeAction({ applying, onApply, className }: { applying: boolean; onApply: () => void; className?: string }) {
  return (
    <Button
      size="sm"
      icon={<Scissors aria-hidden />}
      pending={applying}
      title={APPLY_SHORTER_HINT}
      onClick={onApply}
      className={cn("min-h-7 gap-1.5 px-2.5 text-caption [&_svg]:size-3.5", className)}
    >
      {t("套用並裁短…")}
    </Button>
  );
}

/** A press on one of the entry's own buttons is not a press on the entry. */
function onControl(event: MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element && event.target.closest("button") !== null;
}

/** What a list row and a grid cell share: grid row semantics, selection, the drag towards the timeline and the menu. */
function entryProps({ item, selected, tabbable, loaded, onSelect, onOpen, onMenu }: MediaEntryProps) {
  return {
    role: "row",
    tabIndex: tabbable ? 0 : -1,
    "data-media-item": item.id,
    "aria-selected": selected,
    "aria-current": loaded ? ("true" as const) : undefined,
    draggable: true,
    onFocus: onSelect,
    onDoubleClick: (event: MouseEvent<HTMLElement>) => {
      if (!onControl(event)) onOpen();
    },
    onDragStart: (event: DragEvent<HTMLElement>) => { writeSourceDrag(event.dataTransfer, { sourceId: item.id, inFrame: null, outFrame: null }); },
    onDragEnd: endSourceDrag,
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      onSelect();
      onMenu({ kind: "point", x: event.clientX, y: event.clientY }, event.currentTarget);
    },
  };
}

export function MediaRow(props: MediaEntryProps) {
  const { item, index, fps, selected, loaded, menuId, menuOpen, applying, onMenu, onMenuClose, onApplyShorter } = props;
  const usage = t("時間軸使用 {count} 次", { count: item.uses });
  return (
    <div
      ref={reveal(index)}
      {...entryProps(props)}
      title={mediaTitle(item, fps)}
      className={cn(LIST_ROW, FOCUS_RING, "cursor-default select-none", selected ? LIST_ROW_SELECTED : LIST_ROW_IDLE)}
    >
      <div role="presentation" className="flex h-9 min-w-0 items-center gap-2 pr-1 pl-2.5">
        <span role="gridcell" className="flex shrink-0">
          <MediaIcon item={item} />
        </span>
        <span role="gridcell" className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className={cn("min-w-0 truncate text-data", item.pending ? "text-fg-tertiary" : "text-fg")}>{item.name}</span>
          <StateMarks item={item} loaded={loaded} />
        </span>
        {item.pending ? (
          // A shot that waits for its render says so where its length would stand (the planned length is in the tooltip)
          <span role="gridcell" className="shrink-0 text-caption text-warning">
            {t("尚未渲染")}
          </span>
        ) : (
          // The narrowest panel gives the length's place to the name
          <span role="gridcell" className="machine shrink-0 text-caption text-fg-tertiary @max-[17.5rem]:hidden">
            {item.duration === null ? "—" : formatTimecode(item.duration, fps)}
          </span>
        )}
        <span role="gridcell" className="flex w-8 shrink-0 justify-end" title={usage}>
          {item.uses > 0 ? (
            <span aria-hidden className="machine rounded-full bg-overlay px-1.5 text-caption leading-5 text-fg-secondary">
              ×{item.uses}
            </span>
          ) : null}
          <span className="sr-only">{usage}</span>
        </span>
        <span role="gridcell" className="flex shrink-0">
          <MenuButton item={item} menuId={menuId} open={menuOpen} onOpen={onMenu} onClose={onMenuClose} />
        </span>
      </div>
      {item.shorter ? (
        <div role="gridcell" className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-2 pb-1.5 pl-8.5">
          <ShorterTakeBadge />
          <ShorterTakeAction applying={applying} onApply={onApplyShorter} />
        </div>
      ) : null}
    </div>
  );
}

/** Over the thumbnail, the "⋯" shows while the cell is pointed at, focused or selected (always where there is no hover). */
const CELL_MENU = "absolute top-1 right-1 size-6 bg-stage/85 text-fg opacity-0 group-focus-within/cell:opacity-100 group-hover/cell:opacity-100 pointer-coarse:opacity-100 aria-expanded:opacity-100";

export function MediaCell(props: MediaEntryProps) {
  const { item, index, fps, selected, loaded, menuId, menuOpen, applying, onMenu, onMenuClose, onApplyShorter } = props;
  return (
    <div
      ref={reveal(index)}
      {...entryProps(props)}
      className={cn(OPTION_CARD, FOCUS_RING, "group/cell grid min-w-0 cursor-default content-start p-1.5 select-none", selected ? OPTION_SELECTED : OPTION_IDLE)}
    >
      <div role="gridcell" className="grid min-w-0 gap-1">
        <div className="relative">
          <MediaThumb item={item} />
          {item.duration === null ? null : (
            <span className="machine absolute right-1 bottom-1 rounded-sm bg-stage/85 px-1 text-[11px] leading-4 text-fg">{formatTimecode(item.duration, fps)}</span>
          )}
          <MenuButton item={item} menuId={menuId} open={menuOpen} onOpen={onMenu} onClose={onMenuClose} className={cn(CELL_MENU, selected && "opacity-100")} />
        </div>
        {/* The tooltip stands on the text, not on the thumbnail: there it would cover the frames of a hover scrub */}
        <div className="grid min-w-0 gap-0.5" title={mediaTitle(item, fps)}>
          <div className="flex min-w-0 items-center gap-1">
            <MediaIcon item={item} className="size-3.5" />
            <span className={cn("min-w-0 flex-1 truncate text-caption", item.pending ? "text-fg-tertiary" : "text-fg")}>{item.name}</span>
            <StateMarks item={item} loaded={loaded} />
          </div>
          <span className="truncate text-caption leading-4 text-fg-tertiary">{t("時間軸使用 {count} 次", { count: item.uses })}</span>
        </div>
        {item.pending ? <span className="sr-only">{t("尚未渲染")}</span> : null}
        {item.shorter ? (
          <div className="grid justify-items-start gap-1 pt-0.5">
            <ShorterTakeBadge />
            <ShorterTakeAction applying={applying} onApply={onApplyShorter} className="w-full" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
