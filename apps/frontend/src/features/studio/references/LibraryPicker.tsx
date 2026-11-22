// 「從素材庫加入」的彈出層（約 480 px，錨定在按鈕上）：搜尋檔名與篩選類型，三欄縮圖格可以多選，底部「加入 n 個」依選取的順序
// 加到這個鏡頭（決定 @ 名稱的序號）。已在鏡頭裡的顯示 @ 名稱；加上已選的會超過 H3 限制的停用並寫出原因。
// Image Studio 的遮罩（灰階局部重繪用）不是參考素材，不列出。
// 鍵盤：焦點留在搜尋欄（combobox），方向鍵移動目前的縮圖（上下一次一列），Enter 選取或取消，Ctrl＋Enter 加入；Esc 關閉。
// 外觀：縮圖磚（滑過時縮圖在框內放大）；選取的磚是品牌細邊，角落的圓點寫出第幾個選的；磚依序淡入。
import { Check, Plus, Search } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { OPTION_SELECTED, THUMB_ZOOM, TILE } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { itemFacts } from "./display";
import { KindIcon } from "./KindIcon";
import { addBlockedReason, KIND_LABEL, newReference, videoLibrary, type ReferenceKind } from "./materials";
import { LibraryThumb } from "./ReferenceRow";
import { t } from "@/i18n";

const COLUMNS = 3;

/** The references the shot would have after adding `items` in order (the same rule as adding them). */
function planned(references: readonly StudioReference[], items: readonly StudioLibraryItem[]): StudioReference[] {
  return items.reduce<StudioReference[]>((list, item) => {
    const created = newReference(item, list, `planned-${item.item_id}`);
    return created ? [...list, created] : list;
  }, [...references]);
}

export function LibraryPicker({
  library,
  references,
  disabledReason,
  onAdd,
  onCancel,
}: {
  library: readonly StudioLibraryItem[];
  references: readonly StudioReference[];
  /** 非 null＝不能加入（例如路由不支援參考素材）。 */
  disabledReason: string | null;
  /** The chosen files, in the order they were chosen. */
  onAdd: (items: StudioLibraryItem[]) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<ReferenceKind | "all">("all");
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [cursor, setCursor] = useState(0);
  const used = new Map(references.map((ref) => [ref.item_id, ref.alias]));
  const usable = videoLibrary(library);
  const byId = new Map(usable.map((item) => [item.item_id, item]));
  const picked = chosen.flatMap((itemId) => byId.get(itemId) ?? []);
  const after = planned(references, picked);
  const q = search.trim().toLowerCase();
  const items = [...usable]
    .filter((item) => (kind === "all" || item.kind === kind) && (q.length === 0 || item.name.toLowerCase().includes(q)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const active = Math.min(cursor, Math.max(0, items.length - 1));
  const optionId = (at: number) => `${id}-option-${String(at)}`;

  const reasonOf = (item: StudioLibraryItem): string | null => {
    if (used.has(item.item_id) || chosen.includes(item.item_id)) return null;
    return disabledReason ?? addBlockedReason(item.kind, after);
  };
  const toggle = (item: StudioLibraryItem | undefined) => {
    if (!item || used.has(item.item_id)) return;
    if (chosen.includes(item.item_id)) setChosen(chosen.filter((itemId) => itemId !== item.item_id));
    else if (!((reasonOf(item) ?? "") !== "")) setChosen([...chosen, item.item_id]);
  };
  const moveTo = (at: number) => {
    const next = Math.max(0, Math.min(items.length - 1, at));
    setCursor(next);
    document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      if (picked.length > 0) onAdd(picked);
    } else if (event.target instanceof HTMLInputElement && event.key === "ArrowRight") moveTo(active + 1);
    else if (event.target instanceof HTMLInputElement && event.key === "ArrowLeft") moveTo(active - 1);
    else if (event.target instanceof HTMLInputElement && event.key === "ArrowDown") moveTo(active + COLUMNS);
    else if (event.target instanceof HTMLInputElement && event.key === "ArrowUp") moveTo(active - COLUMNS);
    else if (event.target instanceof HTMLInputElement && event.key === "Enter") toggle(items[active]);
    else return;
    event.preventDefault();
  };

  return (
    <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */  className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(7rem,auto)] gap-1.5 border-b border-white/8 p-2">
        <div className="relative block">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input
            compact
            data-autofocus=""
            type="search"
            role="combobox"
            aria-expanded
            aria-controls={`${id}-list`}
            aria-activedescendant={items.length > 0 ? optionId(active) : undefined}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setCursor(0);
            }}
            placeholder={t("搜尋檔名")}
            aria-label={t("搜尋素材庫檔名")}
            autoComplete="off"
            className="pl-8"
          />
        </div>
        <Select compact value={kind} onChange={(event) => { const value = event.target.value; if (value === "all" || value === "image" || value === "video" || value === "audio") setKind(value); }} aria-label={t("類型")}>
          <option value="all">{t("全部類型")}</option>
          <option value="image">{t("圖片")}</option>
          <option value="video">{t("影片")}</option>
          <option value="audio">{t("聲音")}</option>
        </Select>
      </div>
      {usable.length === 0 ? (
        <EmptyState
          size="compact"
          illustration="drop"
          title={library.length > 0 ? t("專案素材庫只有 Image Studio 的遮罩") : t("專案素材庫是空的")}
          description={library.length > 0 ? t("遮罩不能當參考素材；先上傳圖片、影片或聲音。") : t("先上傳圖片、影片或聲音。")}
        />
      ) : items.length === 0 ? (
        <p className="px-3 py-6 text-center text-caption text-fg-tertiary">{t("沒有符合的檔案。")}</p>
      ) : (
        // Rows take their tile's full height (auto-rows-max) and the grid scrolls: a grid capped by max-height would
        // shrink every row to fit and the tiles (which clip their content) would show only the thumbnail.
        <div
          id={`${id}-list`}
          role="listbox"
          aria-multiselectable
          aria-label={t("素材庫檔案（{itemsCount}）", { itemsCount: items.length })}
          className="grid max-h-[22rem] min-h-0 auto-rows-max grid-cols-3 gap-2 overflow-y-auto p-2"
        >
          {items.map((item, index) => {
            const alias = used.get(item.item_id);
            const order = chosen.indexOf(item.item_id);
            const reason = reasonOf(item);
            const facts = itemFacts(item);
            return (
              <div /* eslint-disable-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/interactive-supports-focus -- The owning composite keeps keyboard focus and exposes the active option with aria-activedescendant. */
                key={item.item_id}
                ref={reveal(index)}
                id={optionId(index)}
                role="option"
                aria-selected={order >= 0}
                aria-disabled={alias !== undefined || reason !== null || undefined}
                title={reason ?? ((alias != null && alias !== "") ? t("已加入 @{alias}", { alias }) : item.name)}
                onClick={() => { toggle(item); }}
                onPointerMove={() => { setCursor(index); }}
                className={cn(
                  TILE,
                  "relative grid min-w-0 transition-[border-color,background-color,opacity] duration-(--duration-fast)",
                  order >= 0 ? OPTION_SELECTED : index === active && "border-brand-blue/50",
                  alias !== undefined || reason !== null ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                )}
              >
                <span className="relative grid aspect-video w-full place-items-center overflow-hidden bg-stage">
                  <LibraryThumb item={item} className={THUMB_ZOOM} />
                  <span aria-hidden className="absolute top-1 left-1 grid size-5 place-items-center rounded-md bg-sunken/85">
                    <KindIcon kind={item.kind} className="size-3.5" />
                  </span>
                  {alias === undefined && reason === null ? (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute top-1 right-1 grid size-5 place-items-center rounded-full border text-[11px] font-semibold transition-colors duration-(--duration-fast)",
                        order >= 0 ? "border-transparent bg-brand-gradient text-on-accent animate-pop-in" : "border-white/45 bg-sunken/60 text-transparent",
                      )}
                    >
                      {order >= 0 ? order + 1 : <Check className="size-3" />}
                    </span>
                  ) : null}
                </span>
                <span className="grid min-w-0 gap-0.5 px-1.5 pt-1 pb-1.5">
                  <span className="truncate text-caption text-fg">{item.name}</span>
                  <span className="truncate text-[11px] leading-4 text-fg-tertiary">
                    {KIND_LABEL[item.kind]}
                    {facts ? ` · ${facts}` : ""}
                  </span>
                  {(alias != null && alias !== "") ? (
                    <span className="machine justify-self-start rounded-full border border-line bg-raised px-1.5 text-[11px] leading-4 text-fg-secondary">{t("已加入 @{alias}", { alias })}</span>
                  ) : (reason != null && reason !== "") ? (
                    <span className="line-clamp-2 text-[11px] leading-4 text-warning">{reason}</span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 border-t border-white/8 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-caption text-fg-tertiary" aria-live="polite">
          {picked.length > 0 ? t("已選 {count} 個；依選取的順序加入", { count: picked.length }) : t("點縮圖選取，可以選好幾個")}
        </span>
        <Button size="sm" variant="quiet" onClick={onCancel}>
          {t("取消")}
        </Button>
        <Button size="sm" variant="primary" icon={<Plus aria-hidden />} disabled={picked.length === 0} onClick={() => { onAdd(picked); }} aria-keyshortcuts="Control+Enter">
          {picked.length > 0 ? t("加入 {count} 個", { count: picked.length }) : t("加入")}
        </Button>
      </div>
    </div>
  );
}
