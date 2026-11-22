// The toolbar of the Project panel: search, the sort menu, the labelled Import button and the New menu (Premiere's New
// Item: an adjustment or a text layer at the playhead) on the first row, the kind filter and the list / grid toggle on
// the second; in a wide panel the two rows are one. Its buttons do not take the focus (the panel marks it
// data-keep-focus), so Space keeps playing; the search field keeps the focus as usual.
import { ArrowDownWideNarrow, ArrowUpNarrowWide, LayoutGrid, List, Plus, Search, Upload, type LucideIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { TOOL_BUTTON, TOOL_BUTTON_ON } from "@/components/ui/look";
import type { MenuItem } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  DIRECTION_LABELS,
  KIND_FILTER_LABELS,
  KIND_FILTERS,
  MEDIA_VIEWS,
  SORT_DIRECTIONS,
  SORT_KEYS,
  SORT_LABELS,
  type KindFilter,
  type MediaView,
  type SortDirection,
  type SortKey,
} from "./media";

interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** Shown instead of the label, which stays the option's name. */
  icon?: LucideIcon;
}

interface ChoiceGroupProps<T extends string> {
  label: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
}

/** A few options in one frame: one Tab stop, the arrow keys move and choose; a click chooses without taking the focus. */
function ChoiceGroup<T extends string>({ label, value, options, onChange }: ChoiceGroupProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const step = (index: number) => {
    const next = options[(index + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    groupRef.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div ref={groupRef} role="radiogroup" aria-label={label} className="inline-flex h-8 shrink-0 items-stretch gap-0.5 rounded-md border border-line-strong bg-sunken p-0.5">
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={selected}
            aria-label={option.icon ? option.label : undefined}
            title={option.label}
            tabIndex={selected ? 0 : -1}
            onClick={() => { onChange(option.value); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") step(index + 1);
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") step(index - 1);
              else return;
              event.preventDefault();
            }}
            className={cn(
              "pressable inline-flex min-w-7 items-center justify-center rounded-[5px] px-1.5 text-caption whitespace-nowrap [&_svg]:size-3.5",
              selected ? "bg-brand-gradient-soft text-fg ring-1 ring-brand-blue/50 ring-inset [&_svg]:text-brand-cyan" : "text-fg-tertiary hover:bg-raised hover:text-fg",
            )}
          >
            {option.icon ? <option.icon aria-hidden /> : option.label}
          </button>
        );
      })}
    </div>
  );
}

const KIND_OPTIONS: readonly ChoiceOption<KindFilter>[] = KIND_FILTERS.map((value) => ({ value, label: KIND_FILTER_LABELS[value] }));
const VIEW_LOOKS: Record<MediaView, { label: string; icon: LucideIcon }> = {
  list: { label: t("清單檢視"), icon: List },
  grid: { label: t("縮圖檢視"), icon: LayoutGrid },
};
const VIEW_OPTIONS: readonly ChoiceOption<MediaView>[] = MEDIA_VIEWS.map((value) => ({ value, ...VIEW_LOOKS[value] }));

interface SortMenuProps {
  sortKey: SortKey;
  direction: SortDirection;
  onSortKey: (key: SortKey) => void;
  onDirection: (direction: SortDirection) => void;
}

function SortMenu({ sortKey, direction, onSortKey, onDirection }: SortMenuProps) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const label = t("排序：{key}・{direction}", { key: SORT_LABELS[sortKey], direction: DIRECTION_LABELS[direction] });
  const items: MenuItem[] = [
    ...SORT_KEYS.map(
      (key): MenuItem => ({ id: key, label: SORT_LABELS[key], disabledReason: key === sortKey ? t("目前的排序") : null, onSelect: () => { onSortKey(key); } }),
    ),
    ...SORT_DIRECTIONS.map(
      (value, index): MenuItem => ({
        id: value,
        label: DIRECTION_LABELS[value],
        icon: value === "ascending" ? ArrowUpNarrowWide : ArrowDownWideNarrow,
        separatorBefore: index === 0,
        disabledReason: value === direction ? t("目前的方向") : null,
        onSelect: () => { onDirection(value); },
      }),
    ),
  ];
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? id : undefined}
        aria-label={label}
        title={label}
        onClick={(event) => { setAnchor(anchor ? null : event.currentTarget); }}
        className={cn(TOOL_BUTTON, "size-8 [&_svg]:size-4", anchor && TOOL_BUTTON_ON)}
      >
        {direction === "ascending" ? <ArrowUpNarrowWide aria-hidden /> : <ArrowDownWideNarrow aria-hidden />}
      </button>
      {anchor ? (
        <ActionMenu id={id} label={t("素材排序")} items={items} anchor={{ kind: "element", element: anchor }} returnFocus={anchor} onClose={() => { setAnchor(null); }} />
      ) : null}
    </>
  );
}

/** The New menu: what the timeline makes itself, at the playhead (no file to import). */
function NewMenu({ items }: { items: MenuItem[] }) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <Button
        size="sm"
        icon={<Plus aria-hidden />}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? id : undefined}
        title={t("在時間軸的播放頭新增調整圖層或文字圖層")}
        onClick={(event) => { setAnchor(anchor ? null : event.currentTarget); }}
      >
        {t("新增")}
      </Button>
      {anchor ? <ActionMenu id={id} label={t("新增項目")} items={items} anchor={{ kind: "element", element: anchor }} returnFocus={anchor} onClose={() => { setAnchor(null); }} /> : null}
    </>
  );
}

export interface ProjectToolbarProps extends SortMenuProps {
  query: string;
  onQuery: (query: string) => void;
  kind: KindFilter;
  onKind: (kind: KindFilter) => void;
  view: MediaView;
  onView: (view: MediaView) => void;
  onImport: () => void;
  /** The items of the New menu. */
  newItems: MenuItem[];
}

export function ProjectToolbar({ query, onQuery, kind, onKind, view, onView, onImport, newItems, ...sort }: ProjectToolbarProps) {
  return (
    <div data-keep-focus="" className="@container shrink-0 border-b border-line-subtle">
      <div role="group" aria-label={t("專案素材工具列")} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1">
        <div className="relative min-w-24 grow basis-40">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input
            compact
            type="search"
            value={query}
            aria-label={t("搜尋素材")}
            placeholder={t("搜尋素材")}
            className="pl-8"
            onChange={(event) => { onQuery(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || query === "") return;
              event.preventDefault();
              onQuery("");
            }}
          />
        </div>
        <SortMenu {...sort} />
        <Button size="sm" icon={<Upload aria-hidden />} title={t("匯入影片、聲音或圖片到專案（也可以把檔案拖到這個面板）")} onClick={onImport}>
          {t("匯入")}
        </Button>
        <NewMenu items={newItems} />
        <div className="flex basis-full flex-wrap items-center justify-between gap-x-2 gap-y-1 @[34rem]:basis-auto">
          <ChoiceGroup label={t("素材類型")} value={kind} options={KIND_OPTIONS} onChange={onKind} />
          <ChoiceGroup label={t("檢視方式")} value={view} options={VIEW_OPTIONS} onChange={onView} />
        </div>
      </div>
    </div>
  );
}
