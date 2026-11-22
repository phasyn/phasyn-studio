// The Markers panel: the sequence's markers in time order. A click on a row moves the playhead there; the colour
// swatch opens the colour menu; a double click on the name renames it and on the timecode retimes it; the row's menu
// (right click, Shift+F10) and the keys Enter, F2 and Delete carry the same actions. The toolbar adds a marker at the
// playhead and steps to the marker before or after it. Every change is one commit of the timeline document.
import { focusOpenedControl } from "@/lib/dom";
import { ChevronLeft, ChevronRight, Flag, MapPin, PencilLine, Trash2, createLucideIcon } from "lucide-react";
import { useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import type { TimelineMarker } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { LIST_ROW, LIST_ROW_IDLE, LIST_ROW_SELECTED, TOOL_BUTTON } from "@/components/ui/look";
import type { MenuAnchor, MenuItem } from "@/components/ui/menuModel";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { isMenuKey, isTextEntry } from "@/lib/keyboard";
import type { PlayheadStore } from "../../hooks/playhead";
import { formatTimecode, parseTimecode } from "../../model/frames";
import { useEditor } from "../editorContext";
import { chordOf } from "../keymap";
import { MAX_TIMELINE_FRAMES } from "../model";
import { MARKER_COLOR } from "../timeline/markerColors";

type MarkerColor = TimelineMarker["color"];
type MarkerField = "name" | "frame";

function markerColor(value: MarkerColor, label: string, fill: string) {
  const icon = createLucideIcon(`marker-${value}`, [["circle", { cx: 12, cy: 12, r: 7, stroke: "none", className: fill, key: "dot" }]]);
  return { value, label, icon };
}
const BY_COLOR = {
  blue: markerColor("blue", t("藍色"), "fill-brand-blue"),
  green: markerColor("green", t("綠色"), "fill-success"),
  amber: markerColor("amber", t("琥珀色"), "fill-warning"),
  rose: markerColor("rose", t("玫瑰色"), "fill-danger"),
  violet: markerColor("violet", t("紫色"), "fill-brand-violet"),
} satisfies Record<MarkerColor, ReturnType<typeof markerColor>>;
const COLORS = Object.values(BY_COLOR);
/** Longest marker name the document takes. */
const NAME_LIMIT = 200;
const UNAVAILABLE = "cursor-not-allowed text-fg-disabled hover:bg-transparent hover:text-fg-disabled";

interface InlineFieldProps {
  label: string;
  value: string;
  maxLength?: number;
  /** Applies the text; returns why it cannot be taken, or null when it was. */
  onApply: (text: string) => string | null;
  /** byKey: closed with Enter or Esc (the row takes the focus back), not by leaving the field. */
  onClose: (byKey: boolean) => void;
  className?: string;
}

/**
 * A cell being edited in place. Enter applies and closes; leaving the field applies when the text is valid and
 * otherwise drops it; Esc drops it. Text that cannot be applied on Enter stays, marked, with the reason as its tooltip.
 */
function InlineField({ label, value, maxLength, onApply, onClose, className }: InlineFieldProps) {
  const closedRef = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => {
    closedRef.current = true;
    onClose(true);
  };
  return (
    <input
      ref={focusOpenedControl}
      defaultValue={value}
      maxLength={maxLength}
      aria-label={label}
      aria-invalid={(problem != null && problem !== "") ? true : undefined}
      title={problem ?? undefined}
      onFocus={(event) => { event.currentTarget.select(); }}
      onChange={() => { setProblem(null); }}
      onBlur={(event) => {
        if (closedRef.current) return;
        onApply(event.target.value);
        onClose(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          const rejected = onApply(event.currentTarget.value);
          if (rejected != null && rejected !== "") setProblem(rejected);
          else close();
        } else if (event.key === "Escape") close();
      }}
      className={cn("h-7 min-w-0 rounded-md border border-line-control bg-sunken px-1.5 text-data text-fg outline-none focus-visible:border-focus aria-invalid:border-danger", className)}
    />
  );
}

interface MarkerRowProps {
  marker: TimelineMarker;
  index: number;
  fps: number;
  selected: boolean;
  /** The row the Tab key lands on (the selected one, else the first). */
  tabbable: boolean;
  /** The playhead stands on this marker. */
  current: boolean;
  editing: MarkerField | null;
  onEdit: (field: MarkerField) => void;
  onEditEnd: (row: HTMLElement | null) => void;
  onSelect: () => void;
  onSeek: () => void;
  onChange: (change: Partial<TimelineMarker>) => boolean;
  onRemove: () => void;
  onMenu: (kind: MenuKind, anchor: MenuAnchor, row: HTMLElement | null) => void;
}

function MarkerRow({ marker, index, fps, selected, tabbable, current, editing, onEdit, onEditEnd, onSelect, onSeek, onChange, onRemove, onMenu }: MarkerRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const name = marker.name || t("未命名標記");
  const rename = (text: string): string | null => {
    const next = text.trim();
    if (next === marker.name) return null;
    return onChange({ name: next }) ? null : t("無法套用剪輯");
  };
  const retime = (text: string): string | null => {
    const frame = parseTimecode(text, fps, marker.frame);
    if (frame === null || frame > MAX_TIMELINE_FRAMES) return t("請輸入影格數、時間碼或 +／− 位移（最多 {max} 影格）", { max: MAX_TIMELINE_FRAMES });
    if (frame === marker.frame) return null;
    return onChange({ frame }) ? null : t("無法套用剪輯");
  };
  const press = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("button, input")) return;
    onSeek();
  };
  const endEdit = (byKey: boolean) => { onEditEnd(byKey ? rowRef.current : null); };
  return (
    <div /* eslint-disable-line jsx-a11y-x/click-events-have-key-events -- The focused row delegates its keyboard actions to the parent grid or tree. */
      ref={(node) => {
        rowRef.current = node;
        return reveal(index)(node);
      }}
      role="row"
      tabIndex={tabbable ? 0 : -1}
      data-marker-row={marker.marker_id}
      aria-selected={selected}
      aria-current={current ? "true" : undefined}
      onClick={press}
      onFocus={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu("row", { kind: "point", x: event.clientX, y: event.clientY }, event.currentTarget);
      }}
      className={cn(LIST_ROW, "flex h-9 min-w-0 cursor-default items-center gap-1 pr-1 pl-1.5 outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset", selected ? LIST_ROW_SELECTED : LIST_ROW_IDLE)}
    >
      <span role="gridcell" className="flex shrink-0">
        <button
          type="button"
          tabIndex={-1}
          aria-haspopup="menu"
          aria-label={t("「{name}」的顏色：{color}", { name, color: BY_COLOR[marker.color].label })}
          title={t("顏色：{color}", { color: BY_COLOR[marker.color].label })}
          onClick={(event) => { onMenu("color", { kind: "element", element: event.currentTarget }, rowRef.current); }}
          className={TOOL_BUTTON}
        >
          <span aria-hidden className={cn("size-3 rounded-[3px]", MARKER_COLOR[marker.color])} />
        </button>
      </span>
      <span role="gridcell" className="flex min-w-0 flex-1 items-center">
        {editing === "name" ? (
          <InlineField label={t("標記名稱")} value={marker.name} maxLength={NAME_LIMIT} onApply={rename} onClose={endEdit} className="w-full" />
        ) : (
          <button onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onEdit("name"); } }} type="button" className={cn("min-w-0 flex-1 truncate text-data", marker.name ? "text-fg" : "text-fg-tertiary")} title={t("{name}（按兩下重新命名）", { name })} onDoubleClick={() => { onEdit("name"); }}>
            {name}
          </button>
        )}
      </span>
      <span role="gridcell" className="flex shrink-0 items-center">
        {editing === "frame" ? (
          <InlineField label={t("標記位置（影格或時間碼）")} value={formatTimecode(marker.frame, fps)} onApply={retime} onClose={endEdit} className="machine w-24 text-caption" />
        ) : (
          <button onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onEdit("frame"); } }} type="button" className={cn("machine px-1 text-caption", current ? "text-brand-cyan" : "text-fg-tertiary")} title={t("按兩下輸入影格、時間碼或 +／− 位移")} onDoubleClick={() => { onEdit("frame"); }}>
            {formatTimecode(marker.frame, fps)}
          </button>
        )}
      </span>
      <span role="gridcell" className="flex shrink-0">
        <button type="button" tabIndex={-1} aria-label={t("刪除標記「{name}」", { name })} title={t("刪除標記（Delete）")} onClick={onRemove} className={cn(TOOL_BUTTON, "text-fg-tertiary hover:text-danger")}>
          <Trash2 aria-hidden />
        </button>
      </span>
    </div>
  );
}

interface PlayheadMarkers {
  /** The marker the playhead stands on. */
  currentId: string | null;
  /** There is a marker before / after the playhead. */
  before: boolean;
  after: boolean;
}

/** Where the playhead is among the markers. Read as one string, so a moving playhead renders only when the answer changes. */
function usePlayheadMarkers(playhead: PlayheadStore, markers: readonly TimelineMarker[]): PlayheadMarkers {
  const snapshot = useSyncExternalStore(playhead.subscribe, () => {
    const frame = playhead.getFrame();
    const current = markers.find((marker) => marker.frame === frame)?.marker_id ?? "";
    return `${String(markers.some((marker) => marker.frame < frame) ? 1 : 0)}${String(markers.some((marker) => marker.frame > frame) ? 1 : 0)}${current}`;
  });
  return { before: snapshot.startsWith("1"), after: snapshot.charAt(1) === "1", currentId: snapshot.slice(2) || null };
}

type MenuKind = "color" | "row";

interface OpenMenu {
  markerId: string;
  kind: MenuKind;
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
}

export function MarkersPanel() {
  const editor = useEditor();
  const { timeline, fps, transport, playhead } = editor;
  const menuId = useId();
  // Rows are found by the grid's id, not through a ref: menu items built during render must not close over a ref.
  const listId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ markerId: string; field: MarkerField } | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const markers = [...timeline.markers].sort((a, b) => a.frame - b.frame);
  const { currentId, before, after } = usePlayheadMarkers(playhead, markers);
  const panelId = useId();
  const selected = markers.find((marker) => marker.marker_id === selectedId) ?? null;

  const rowOf = (markerId: string) =>
    document.getElementById(listId)?.querySelector<HTMLElement>(`[data-marker-row="${CSS.escape(markerId)}"]`) ?? null;
  const change = (markerId: string, patch: Partial<TimelineMarker>) =>
    editor.commit({ ...timeline, markers: timeline.markers.map((marker) => (marker.marker_id === markerId ? { ...marker, ...patch } : marker)) });
  const remove = (marker: TimelineMarker) => {
    const at = markers.findIndex((item) => item.marker_id === marker.marker_id);
    const next = markers[at + 1] ?? markers[at - 1] ?? null;
    if (!editor.commit({ ...timeline, markers: timeline.markers.filter((item) => item.marker_id !== marker.marker_id) })) return;
    setSelectedId(next?.marker_id ?? null);
    if (next) rowOf(next.marker_id)?.focus();
    else document.getElementById(panelId)?.focus({ preventScroll: true });
  };
  const step = (direction: -1 | 1) => {
    const frame = playhead.getFrame();
    const target = direction < 0 ? markers.filter((marker) => marker.frame < frame).at(-1) : markers.find((marker) => marker.frame > frame);
    if (!target) return;
    setSelectedId(target.marker_id);
    transport.seek(target.frame);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTextEntry(event.target) || !selected) return;
    const at = markers.indexOf(selected);
    const moves: Record<string, number> = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: markers.length - 1 };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      const target = markers[move];
      if (target) rowOf(target.marker_id)?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      transport.seek(selected.frame);
    } else if (event.key === "F2") {
      event.preventDefault();
      setEditing({ markerId: selected.marker_id, field: "name" });
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(selected);
    } else if (isMenuKey(event)) {
      event.preventDefault();
      const row = rowOf(selected.marker_id);
      if (row) setMenu({ markerId: selected.marker_id, kind: "row", anchor: { kind: "element", element: row }, returnFocus: row });
    }
  };

  const menuMarker = menu ? (markers.find((marker) => marker.marker_id === menu.markerId) ?? null) : null;
  const colorItems = (marker: TimelineMarker, separated: boolean): MenuItem[] =>
    COLORS.map((color, index) => ({
      id: `color-${color.value}`,
      label: color.label,
      icon: color.icon,
      separatorBefore: separated && index === 0,
      disabledReason: color.value === marker.color ? t("目前的顏色") : null,
      onSelect: () => void change(marker.marker_id, { color: color.value }),
    }));
  const rowItems = (marker: TimelineMarker): MenuItem[] => [
    { id: "seek", label: t("把播放頭移到這個標記"), icon: MapPin, shortcut: "Enter", onSelect: () => { transport.seek(marker.frame); } },
    { id: "rename", label: t("重新命名"), icon: PencilLine, shortcut: "F2", onSelect: () => { setEditing({ markerId: marker.marker_id, field: "name" }); } },
    {
      id: "move",
      label: t("把標記移到播放頭"),
      icon: Flag,
      disabledReason: marker.marker_id === currentId ? t("標記已經在播放頭") : null,
      onSelect: () => void change(marker.marker_id, { frame: playhead.getFrame() }),
    },
    ...colorItems(marker, true),
    { id: "remove", label: t("刪除標記"), icon: Trash2, shortcut: "Delete", tone: "danger", separatorBefore: true, onSelect: () => { remove(marker); } },
  ];

  return (
    // The panel takes the focus when the row that had it removes itself and no row is left: Delete stays here instead of reaching the selected clip
    <div id={panelId} tabIndex={-1} data-delete-keys="" className="flex min-h-0 flex-1 flex-col outline-none">
      <div data-keep-focus="" className="flex h-10 shrink-0 items-center gap-1 border-b border-line-subtle px-2">
        <Button size="sm" icon={<Flag aria-hidden />} title={t("在播放頭新增標記（{shortcut}）", { shortcut: chordOf("addMarker") })} onClick={() => void editor.addMarker()}>
          {t("新增標記")}
        </Button>
        <span className="ml-auto flex items-center gap-0.5">
          <button type="button" aria-label={t("上一個標記")} aria-disabled={before ? undefined : true} title={before ? t("上一個標記") : t("播放頭之前沒有標記")} onClick={() => { step(-1); }} className={cn(TOOL_BUTTON, !before && UNAVAILABLE)}>
            <ChevronLeft aria-hidden />
          </button>
          <button type="button" aria-label={t("下一個標記")} aria-disabled={after ? undefined : true} title={after ? t("下一個標記") : t("播放頭之後沒有標記")} onClick={() => { step(1); }} className={cn(TOOL_BUTTON, !after && UNAVAILABLE)}>
            <ChevronRight aria-hidden />
          </button>
        </span>
      </div>
      {markers.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
          <EmptyState size="compact" icon={<Flag />} title={t("還沒有標記")} description={t("標記會出現在時間尺上，按一下就能回到那個位置。")} />
        </div>
      ) : (
        <div tabIndex={-1} id={listId} role="grid" aria-label={t("序列標記")} data-delete-keys="" onKeyDown={keys} className="min-h-0 flex-1 overflow-y-auto py-1">
          {markers.map((marker, index) => (
            <MarkerRow
              key={marker.marker_id}
              marker={marker}
              index={index}
              fps={fps}
              selected={marker.marker_id === selected?.marker_id}
              tabbable={selected ? marker.marker_id === selected.marker_id : index === 0}
              current={marker.marker_id === currentId}
              editing={editing?.markerId === marker.marker_id ? editing.field : null}
              onEdit={(field) => { setEditing({ markerId: marker.marker_id, field }); }}
              onEditEnd={(row) => {
                setEditing(null);
                row?.focus();
              }}
              onSelect={() => { setSelectedId(marker.marker_id); }}
              onSeek={() => { transport.seek(marker.frame); }}
              onChange={(patch) => change(marker.marker_id, patch)}
              onRemove={() => { remove(marker); }}
              onMenu={(kind, anchor, row) => { setMenu({ markerId: marker.marker_id, kind, anchor, returnFocus: row }); }}
            />
          ))}
        </div>
      )}
      {menu && menuMarker ? (
        <ActionMenu
          id={menuId}
          label={menu.kind === "color" ? t("標記顏色") : t("「{name}」的動作", { name: menuMarker.name || t("未命名標記") })}
          items={menu.kind === "color" ? colorItems(menuMarker, false) : rowItems(menuMarker)}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          onClose={() => { setMenu(null); }}
        />
      ) : null}
    </div>
  );
}
