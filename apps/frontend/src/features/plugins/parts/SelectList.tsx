import { optionalField } from "@/lib/json";
// 單選清單（WAI-ARIA listbox）：焦點留在清單上，↑／↓／Home／End 移動選取（aria-activedescendant），點一列就選取。
// 列第一次出現時依序進場；篩選或排序後留下的列以 snappy 彈簧補位（只動 transform）。選取的列有品牌標記，hover 只變色。
import { Fragment, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { LIST_ROW, LIST_ROW_IDLE, LIST_ROW_SELECTED } from "@/components/ui/look";
import { useFlipList } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { useRevealRef } from "./motion";

interface RowProps {
  id: string;
  index: number;
  selected: boolean;
  dimmed: boolean;
  title?: string;
  onSelect: () => void;
  children: ReactNode;
}

function Row({ id, index, selected, dimmed, title, onSelect, children }: RowProps) {
  const enter = useRevealRef(index);
  return (
    <div /* eslint-disable-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/interactive-supports-focus -- The owning composite keeps keyboard focus and exposes the active option with aria-activedescendant. */
      ref={enter}
      id={id}
      role="option"
      aria-selected={selected}
      title={title}
      onClick={onSelect}
      className={cn(LIST_ROW, selected ? LIST_ROW_SELECTED : LIST_ROW_IDLE, "cursor-default rounded-lg", dimmed && "opacity-55")}
    >
      {children}
    </div>
  );
}

export interface SelectListProps<T> {
  label: string;
  items: readonly T[];
  idOf: (item: T) => string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  renderRow: (item: T, selected: boolean) => ReactNode;
  /** 整列變淡（例如已停用的包）。 */
  dimmed?: (item: T) => boolean;
  titleOf?: (item: T) => string;
  /** 分組名稱：與前一列不同時，在這一列前面放一個分組標題。 */
  groupOf?: (item: T) => string;
  className?: string;
}

export function SelectList<T>({ label, items, idOf, selectedId, onSelect, renderRow, dimmed, titleOf, groupOf, className }: SelectListProps<T>) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const ids = items.map(idOf);
  useFlipList(listRef, ids.join("\u0000"));
  const optionId = (id: string) => `${baseId}-${id}`;
  const active = selectedId !== null && ids.includes(selectedId) ? selectedId : null;

  const move = (to: number) => {
    const id = ids[Math.max(0, Math.min(ids.length - 1, to))];
    if (id === undefined) return;
    onSelect(id);
    // 選取立即生效；捲動只是把它帶進畫面
    requestAnimationFrame(() => document.getElementById(optionId(id))?.scrollIntoView({ block: "nearest" }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = active === null ? -1 : ids.indexOf(active);
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? ids.length - 1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(ids.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      aria-activedescendant={active === null ? undefined : optionId(active)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn("grid content-start gap-0.5 rounded-lg focus-visible:-outline-offset-2", className)}
    >
      {items.map((item, index) => {
        const id = idOf(item);
        const previous = items[index - 1];
        const group = groupOf?.(item);
        const heading = group !== undefined && (previous === undefined || groupOf?.(previous) !== group) ? group : null;
        return (
          <Fragment key={id}>
            {heading !== null ? (
              <div role="presentation" className="px-3 pt-2 pb-1 text-caption font-semibold text-fg-tertiary first:pt-0.5">
                {heading}
              </div>
            ) : null}
            <Row id={optionId(id)} index={index} selected={id === active} dimmed={dimmed?.(item) ?? false} {...optionalField("title", titleOf?.(item))} onSelect={() => { onSelect(id); }}>
              {renderRow(item, id === active)}
            </Row>
          </Fragment>
        );
      })}
    </div>
  );
}
