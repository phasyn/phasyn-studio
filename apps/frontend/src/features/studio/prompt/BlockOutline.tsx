// 區塊大綱：每個區塊一列（類型圖示、名稱、時間範圍、內容摘要）；可選擇是否顯示上移／下移。
// 外觀：選取的區塊＝左側品牌標記＋淡漸層底（與 Studio 清單一致）；上移／下移是 pressable 的小工具按鈕。
import { withOccurrenceKeys } from "@/lib/occurrenceKeys";
import { ArrowDown, ArrowUp, Clapperboard, Heading, ListTree, Pilcrow, Timer, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { LIST_ROW, LIST_ROW_IDLE, LIST_ROW_SELECTED, TOOL_BUTTON } from "@/components/ui/look";
import type { BlockKind, PromptBlock } from "./blocks";
import { describeBlock } from "./outline";
import { t } from "@/i18n";

const ICONS: Record<BlockKind, LucideIcon> = { section: ListTree, shot: Clapperboard, time: Timer, heading: Heading, paragraph: Pilcrow };

export function BlockKindIcon({ kind, className }: { kind: BlockKind; className?: string }) {
  const Icon = ICONS[kind];
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-fg-tertiary", className)} />;
}

export function BlockOutline({
  blocks,
  selected,
  onSelect,
  onMove,
  disabled = false,
  label,
  selectHint,
}: {
  blocks: readonly PromptBlock[];
  selected: number | null;
  onSelect: (index: number) => void;
  /** 提供時每列顯示上移／下移。 */
  onMove?: (index: number, delta: -1 | 1) => void;
  disabled?: boolean;
  label: string;
  /** 點選一列會做什麼（給輔助技術，例如「在專業編輯器開啟」）。 */
  selectHint?: string;
}) {
  return (
    <ol aria-label={label} className="grid min-w-0 gap-0.5">
      {withOccurrenceKeys(blocks, (block) => JSON.stringify([block.kind, block.marker, block.title, block.body])).map(({ item: block, key }, index) => {
        const info = describeBlock(block);
        const current = index === selected;
        const name = info.title || info.kind;
        return (
          <li key={key} className="flex min-w-0 items-stretch gap-0.5">
            <button
              type="button"
              onClick={() => { onSelect(index); }}
              aria-current={current ? "true" : undefined}
              aria-label={t("{kind}：{name}{value}{value2}", { kind: info.kind, name, value: (info.detail != null && info.detail !== "") ? t("（{detail}）", { detail: info.detail }) : "", value2: (selectHint != null && selectHint !== "") ? t("，{selectHint}", { selectHint }) : "" })}
              className={cn(
                LIST_ROW,
                "grid min-w-0 flex-1 grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2 rounded-lg px-2 py-1.5 text-left",
                current ? LIST_ROW_SELECTED : LIST_ROW_IDLE,
              )}
            >
              <BlockKindIcon kind={block.kind} className={cn("mt-0.5", current && "text-brand-cyan")} />
              <span className="grid min-w-0 gap-0.5">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className={cn("truncate text-data", block.kind === "section" && "machine", current ? "text-fg" : "text-fg-secondary")}>{name || t("（空白段落）")}</span>
                  {(info.detail != null && info.detail !== "") ? <span className="machine shrink-0 text-caption text-fg-tertiary">{info.detail}</span> : null}
                </span>
                {info.excerpt ? <span className="truncate text-caption text-fg-tertiary">{info.excerpt}</span> : block.kind !== "paragraph" ? <span className="text-caption text-warning">{t("（沒有內容）")}</span> : null}
              </span>
            </button>
            {onMove ? (
              <span className="flex shrink-0 flex-col justify-center">
                <button
                  type="button"
                  onClick={() => { onMove(index, -1); }}
                  disabled={disabled || index === 0}
                  aria-label={t("上移「{name}」", { name })}
                  title={t("上移")}
                  className={cn(TOOL_BUTTON, "size-6 text-fg-tertiary")}
                >
                  <ArrowUp aria-hidden className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => { onMove(index, 1); }}
                  disabled={disabled || index === blocks.length - 1}
                  aria-label={t("下移「{name}」", { name })}
                  title={t("下移")}
                  className={cn(TOOL_BUTTON, "size-6 text-fg-tertiary")}
                >
                  <ArrowDown aria-hidden className="size-3.5" />
                </button>
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
