// @ 自動完成的候選清單（MentionTextarea 在游標下方或上方顯示）：縮圖、@ 名稱、H3 標籤與檔名；目前的選項＝左側品牌標記＋
// 淡漸層底，縮圖以 snappy 彈簧放大一點。按下不搶走文字區的焦點（mousedown 不預設），滑過就換目前的選項。
// 外觀：浮層（material-popover 玻璃＋snappy 彈簧淡入）。
import type { RefObject } from "react";
import { LIST_ROW, LIST_ROW_SELECTED } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { ReferenceThumb } from "../references/ReferenceThumb";
import type { MentionOption } from "./mentions";

export const MENU_WIDTH = 320;

export function MentionMenu({
  menuRef,
  listId,
  optionId,
  top,
  left,
  query,
  filtered,
  active,
  hasOptions,
  onChoose,
  onHover,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  listId: string;
  optionId: (alias: string) => string;
  top: number;
  left: number;
  /** What has been typed after the @. */
  query: string;
  filtered: readonly MentionOption[];
  active: number;
  /** The shot has references at all (decides which empty message shows). */
  hasOptions: boolean;
  onChoose: (option: MentionOption) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      ref={menuRef}
      className="material-popover absolute z-30 grid max-h-72 overflow-y-auto rounded-xl p-1 text-data text-fg animate-pop-in forced-colors:border forced-colors:border-[CanvasText]"
      style={{ top, left, width: `min(${MENU_WIDTH}px, 100%)` }}
    >
      {filtered.length > 0 ? (
        <ul role="listbox" id={listId} aria-label={t("插入參考素材")} className="grid">
          {filtered.map((option, index) => (
            <li
              key={option.alias}
              id={optionId(option.alias)}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(option)}
              onMouseMove={() => {
                if (index !== active) onHover(index);
              }}
              className={cn(LIST_ROW, "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 rounded-lg px-1.5 py-1", index === active ? cn(LIST_ROW_SELECTED, "text-fg") : "text-fg-secondary")}
            >
              <ReferenceThumb item={option.item} kind={option.kind} className={cn("row-span-2 transition-[scale] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)", index === active && "scale-105")} />
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="machine shrink-0 text-fg">@{option.alias}</span>
                {option.label ? <span className="machine truncate text-caption text-fg-tertiary">{option.label}</span> : null}
              </span>
              <span className={cn("truncate text-caption", option.name ? "text-fg-tertiary" : "text-warning")}>{option.name ?? t("檔案已不在素材庫")}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p id={listId} className="px-2 py-1.5 text-caption text-fg-tertiary">
          {hasOptions ? t("沒有符合「{query}」的參考。", { query }) : t("這個鏡頭還沒有參考素材：在「參考素材」加入後即可用 @ 插入。")}
        </p>
      )}
    </div>
  );
}
