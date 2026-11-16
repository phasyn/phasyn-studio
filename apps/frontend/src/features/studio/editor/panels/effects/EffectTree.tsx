// The tree of the Effects browser: collapsible categories over their items. One Tab stop; the arrow keys move
// (→ opens a category or steps into it, ← closes it or goes back to it), Enter opens or closes a category and applies
// an item, and so does a double click on an item. Every item can be dragged onto the timeline, whatever is selected.
// An item that cannot be applied to the selection stays in the tree, drawn back, with the reason as its tooltip.
import { Check, ChevronRight } from "lucide-react";
import { useId, type KeyboardEvent } from "react";
import { COUNT, LIST_ROW, LIST_ROW_IDLE, LIST_ROW_SELECTED, SPRING_SNAPPY } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { endEffectDrag, writeEffectDrag } from "../../effectDrag";
import type { EffectAvailability, EffectCategory, EffectItem } from "./catalog";

export interface EffectTreeEntry {
  item: EffectItem;
  availability: EffectAvailability;
}

export interface EffectTreeGroup {
  category: EffectCategory;
  entries: readonly EffectTreeEntry[];
  open: boolean;
}

export interface EffectTreeProps {
  label: string;
  groups: readonly EffectTreeGroup[];
  /** The selected row: an item's id, or a category's row id. */
  selectedId: string | null;
  onSelect: (rowId: string) => void;
  onToggle: (category: EffectCategory, open: boolean) => void;
  onApply: (item: EffectItem) => void;
}

const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset";

/** A category header stays at the top of the tree while its items scroll under it. */
const CATEGORY_ROW = "sticky top-0 z-10 flex h-9 cursor-default items-center gap-1.5 border-b border-line-subtle bg-surface pr-3 pl-2 select-none hover:bg-raised";

function categoryRowId(category: EffectCategory): string {
  return `category:${category.id}`;
}

function entryTitle({ item, availability }: EffectTreeEntry): string {
  const drag = item.lands === "cut" ? t("也可以拖曳到時間軸上兩個片段之間的編輯點，或片段沒有相鄰片段的一端") : t("也可以拖曳到時間軸的片段上；放在選取的片段上時，所有選取的片段一起套用");
  if (availability.reason) return `${t("{label}：{value}", { label: item.label, value: availability.reason })}\n${drag}`;
  const clip = availability.clipName ?? "";
  if (item.lands === "cut") return `${t("{name}：按兩下或按 Enter，套用到「{clip}」的出點", { name: item.label, clip })}\n${drag}`;
  return `${t("{name}：按兩下或按 Enter，套用到「{clip}」", { name: item.label, clip })}\n${drag}`;
}

interface EntryRowProps {
  entry: EffectTreeEntry;
  /** Place under its category (the entrance stagger: the items of a category that opens come in one after another). */
  index: number;
  selected: boolean;
  tabbable: boolean;
  reasonId: string;
  onSelect: () => void;
  onApply: () => void;
}

function EntryRow({ entry, index, selected, tabbable, reasonId, onSelect, onApply }: EntryRowProps) {
  const { item, availability } = entry;
  const blocked = availability.reason !== null;
  // Already applied is a state of the clip, not a missing precondition: the item keeps its colours. A drawn-back
  // name stays readable (the list is browsed and searched whatever is selected); only its icon takes the disabled tone
  const drawnBack = blocked && !availability.applied;
  return (
    <div
      ref={reveal(index)}
      role="treeitem"
      aria-level={2}
      aria-selected={selected}
      aria-disabled={blocked ? true : undefined}
      aria-describedby={blocked ? reasonId : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-tree-row={item.id}
      title={entryTitle(entry)}
      draggable
      onDragStart={(event) => writeEffectDrag(event.dataTransfer, { itemId: item.id })}
      onDragEnd={endEffectDrag}
      onFocus={onSelect}
      onDoubleClick={onApply}
      className={cn(LIST_ROW, FOCUS_RING, "flex h-8 cursor-grab items-center gap-2 pr-2.5 pl-8 text-data select-none active:cursor-grabbing", selected ? LIST_ROW_SELECTED : LIST_ROW_IDLE)}
    >
      <item.icon aria-hidden className={cn("size-4 shrink-0", drawnBack ? "text-fg-disabled" : "text-brand-cyan")} />
      <span className={cn("min-w-0 flex-1 truncate", drawnBack ? "text-fg-tertiary" : "text-fg")}>{item.label}</span>
      {availability.applied ? <Check aria-hidden className="size-3.5 shrink-0 text-fg-secondary" /> : null}
      {blocked ? (
        <span id={reasonId} className="sr-only">
          {availability.reason}
        </span>
      ) : null}
    </div>
  );
}

export function EffectTree({ label, groups, selectedId, onSelect, onToggle, onApply }: EffectTreeProps) {
  const treeId = useId();
  const rows = groups.flatMap((group) => [categoryRowId(group.category), ...(group.open ? group.entries.map((entry) => entry.item.id) : [])]);
  const tabStop = selectedId !== null && rows.includes(selectedId) ? selectedId : rows[0];
  const focusRow = (rowId: string | undefined) => {
    if (rowId !== undefined) document.getElementById(treeId)?.querySelector<HTMLElement>(`[data-tree-row="${CSS.escape(rowId)}"]`)?.focus();
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const rowId = event.target instanceof HTMLElement ? event.target.dataset.treeRow : undefined;
    if (rowId === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    const at = rows.indexOf(rowId);
    const group = groups.find((item) => categoryRowId(item.category) === rowId);
    const parent = groups.find((item) => item.entries.some((entry) => entry.item.id === rowId));
    const entry = parent?.entries.find((item) => item.item.id === rowId);
    switch (event.key) {
      case "ArrowDown":
        focusRow(rows[at + 1]);
        break;
      case "ArrowUp":
        focusRow(at > 0 ? rows[at - 1] : undefined);
        break;
      case "Home":
        focusRow(rows[0]);
        break;
      case "End":
        focusRow(rows.at(-1));
        break;
      case "ArrowRight":
        if (group && !group.open) onToggle(group.category, true);
        else if (group) focusRow(group.entries[0]?.item.id);
        break;
      case "ArrowLeft":
        if (group?.open) onToggle(group.category, false);
        else if (parent) focusRow(categoryRowId(parent.category));
        break;
      case "Enter":
        // A held key applies the entry once
        if (event.repeat) break;
        if (group) onToggle(group.category, !group.open);
        else if (entry) onApply(entry.item);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    // data-delete-keys: Delete pressed in the tree is not a Delete of the timeline's selection. The scroll padding keeps
    // a row that the arrow keys move to from coming to rest under its category's sticky header
    <div id={treeId} role="tree" aria-label={label} data-delete-keys="" onKeyDown={keys} className="min-h-0 flex-1 scroll-pt-9 overflow-y-auto pb-1">
      {groups.map((group, groupIndex) => {
        const rowId = categoryRowId(group.category);
        return (
          <div key={group.category.id} role="presentation">
            <div
              ref={reveal(groupIndex)}
              role="treeitem"
              aria-level={1}
              aria-expanded={group.open}
              aria-selected={rowId === selectedId}
              tabIndex={rowId === tabStop ? 0 : -1}
              data-tree-row={rowId}
              onFocus={() => onSelect(rowId)}
              onClick={() => onToggle(group.category, !group.open)}
              className={cn(FOCUS_RING, CATEGORY_ROW)}
            >
              <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-fg-tertiary transition-[rotate]", SPRING_SNAPPY, group.open && "rotate-90")} />
              <span className="min-w-0 flex-1 truncate text-data font-semibold text-fg">{group.category.label}</span>
              <span className={COUNT}>{group.entries.length}</span>
            </div>
            {group.open
              ? group.entries.map((entry, entryIndex) => (
                  <EntryRow
                    key={entry.item.id}
                    entry={entry}
                    index={entryIndex + 1}
                    selected={entry.item.id === selectedId}
                    tabbable={entry.item.id === tabStop}
                    reasonId={`${treeId}-${entry.item.id}`}
                    onSelect={() => onSelect(entry.item.id)}
                    onApply={() => onApply(entry.item)}
                  />
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}
