// 專案套用中的插件項目：一個項目一顆大膠囊（種類圖示＋名稱＋移除）。點名稱在插件管理視窗看它的內容；說明與所屬的包
// 在 tooltip。找不到的引用、所屬的包停用或不相容的項目以警示色顯示原因。加入與移除時膠囊彈出、其餘的補位。
import { TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { StudioPluginRef } from "@/api/generated/contracts";
import { motionTransition, STAGGER_LIMIT } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { contributionTitle, selectedLabel, type SelectedItem } from "../model/contributions";
import { ContributionIcon } from "../parts/kinds";

/** 進場依序延遲（與清單逐項進場同一個步距）。 */
const STAGGER_MS = 24;

function Chip({ item, index, onOpen, onRemove }: { item: SelectedItem; index: number; onOpen: () => void; onRemove: () => void }) {
  const label = selectedLabel(item);
  const title = item.problem?.text ?? (item.contribution ? contributionTitle(item.contribution) : label);
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, transition: motionTransition("exit", "exit") }}
      transition={motionTransition("spring-snappy", "spring-snappy", Math.min(index, STAGGER_LIMIT) * STAGGER_MS)}
      className={cn(
        "flex h-9 max-w-full min-w-0 items-center rounded-full border pl-1",
        item.problem ? "border-warning/45 bg-warning/8 text-warning" : "border-line-strong bg-raised text-fg",
      )}
    >
      <button type="button" onClick={onOpen} title={title} className="pressable flex h-full min-w-0 items-center gap-2 rounded-full pr-1 pl-2 text-left hover:text-action-fg">
        {item.contribution && !item.problem ? <ContributionIcon kind={item.contribution.kind} /> : <TriangleAlert aria-hidden className="size-4 shrink-0" />}
        <span className={cn("truncate text-body", !item.contribution && "machine text-data")}>{label}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("從這個專案移除「{label}」", { label })}
        title={t("從這個專案移除「{label}」", { label })}
        className="pressable mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-tertiary hover:bg-overlay hover:text-fg [&_svg]:size-3.5"
      >
        <X aria-hidden />
      </button>
    </motion.li>
  );
}

export function ActiveChips({
  items,
  onOpen,
  onRemove,
  className,
}: {
  items: readonly SelectedItem[];
  /** 在插件管理視窗看這個項目。 */
  onOpen: (ref: StudioPluginRef) => void;
  onRemove: (ref: StudioPluginRef) => void;
  className?: string;
}) {
  return (
    <ul aria-label={t("套用中的插件項目")} className={cn("flex min-w-0 flex-wrap gap-1.5", className)}>
      <AnimatePresence mode="popLayout">
        {items.map((item, index) => (
          <Chip key={item.ref} item={item} index={index} onOpen={() => onOpen(item.ref)} onRemove={() => onRemove(item.ref)} />
        ))}
      </AnimatePresence>
    </ul>
  );
}
