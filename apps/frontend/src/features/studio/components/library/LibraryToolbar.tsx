// 素材庫中欄上方的工具列：搜尋、類型（參考素材）、排序與方向、格狀／清單、縮圖大小與收起／展開詳細資料。
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Image as ImageIcon, LayoutGrid, List, PanelRightClose, PanelRightOpen, Search } from "lucide-react";
import type { RefObject } from "react";
import { Input, Select } from "@/components/ui/controls";
import { isListed } from "@/lib/json";
import { LIBRARY_SORT_KEYS, type LibraryKindFilter, type LibrarySortKey } from "../../model/library";
import { KIND_FILTERS } from "./filters";
import type { LibraryViewMode } from "./LibraryCollection";
import { ToggleButton } from "./libraryControls";
import type { LibrarySection } from "./LibrarySidebar";
import { t } from "@/i18n";

export interface LibraryToolbarProps {
  section: LibrarySection;
  searchRef: RefObject<HTMLInputElement | null>;
  listboxRef: RefObject<HTMLDivElement | null>;
  query: string;
  onQuery: (query: string) => void;
  kind: LibraryKindFilter;
  onKind: (kind: LibraryKindFilter) => void;
  sort: LibrarySortKey;
  sortLabels: Record<LibrarySortKey, string>;
  /** 選同一個排序鍵＝換方向；換排序鍵＝它的預設方向。 */
  onSort: (key: LibrarySortKey) => void;
  descending: boolean;
  onDescending: (descending: boolean) => void;
  view: LibraryViewMode;
  onView: (view: LibraryViewMode) => void;
  thumb: number;
  onThumb: (size: number) => void;
  detailsOpen: boolean;
  onDetailsOpen: (open: boolean) => void;
}

export function LibraryToolbar({ section, searchRef, listboxRef, query, onQuery, kind, onKind, sort, sortLabels, onSort, descending, onDescending, view, onView, thumb, onThumb, detailsOpen, onDetailsOpen }: LibraryToolbarProps) {
  return (
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
          onChange={(event) => { onQuery(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              onQuery("");
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
            <ToggleButton key={entry.id} pressed={kind === entry.id} label={entry.label} onClick={() => { onKind(entry.id); }}>
              <entry.icon aria-hidden />
            </ToggleButton>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-1">
        <Select compact aria-label={t("排序方式")} value={sort} onChange={(event) => { const value = event.target.value; if (isListed(value, LIBRARY_SORT_KEYS)) onSort(value); }} className="w-32">
          {LIBRARY_SORT_KEYS.map((key) => (
            <option key={key} value={key}>
              {sortLabels[key]}
            </option>
          ))}
        </Select>
        <ToggleButton pressed={false} label={descending ? t("由大到小（按一下改成由小到大）") : t("由小到大（按一下改成由大到小）")} onClick={() => { onDescending(!descending); }}>
          {descending ? <ArrowDownWideNarrow aria-hidden /> : <ArrowUpNarrowWide aria-hidden />}
        </ToggleButton>
      </div>
      <div role="group" aria-label={t("檢視方式")} className="flex items-center gap-0.5 rounded-lg border border-line-subtle bg-sunken/60 p-0.5">
        <ToggleButton pressed={view === "grid"} label={t("格狀檢視")} onClick={() => { onView("grid"); }}>
          <LayoutGrid aria-hidden />
        </ToggleButton>
        <ToggleButton pressed={view === "list"} label={t("清單檢視")} onClick={() => { onView("list"); }}>
          <List aria-hidden />
        </ToggleButton>
      </div>
      {view === "grid" ? (
        <label className="flex items-center gap-1.5 text-caption text-fg-tertiary" title={t("縮圖大小")}>
          <ImageIcon aria-hidden className="size-3" />
          <input type="range" min={120} max={320} step={8} value={thumb} onChange={(event) => { onThumb(Number(event.target.value)); }} aria-label={t("縮圖大小")} className="w-24 accent-action" />
          <ImageIcon aria-hidden className="size-4" />
        </label>
      ) : null}
      <ToggleButton pressed={detailsOpen} label={detailsOpen ? t("收起詳細資料") : t("展開詳細資料")} onClick={() => { onDetailsOpen(!detailsOpen); }}>
        {detailsOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
      </ToggleButton>
    </div>
  );
}
