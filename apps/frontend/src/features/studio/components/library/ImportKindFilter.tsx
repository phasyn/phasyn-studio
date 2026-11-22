// 「從其他專案加入…」的類型篩選（全部／圖片／影片／聲音，附數量）。
import { motion } from "motion/react";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import type { LibraryKindFilter } from "../../model/library";
import { KIND_FILTERS } from "./filters";
import { t } from "@/i18n";

/** 類型篩選（全部／圖片／影片／聲音，附數量）：目前的類型有滑動的品牌底。 */
export function KindFilter({ baseId, value, counts, disabled, onChange }: { baseId: string; value: LibraryKindFilter; counts: Record<LibraryKindFilter, number>; disabled: boolean; onChange: (kind: LibraryKindFilter) => void }) {
  return (
    <div role="group" aria-label={t("類型")} className="flex flex-wrap items-center gap-0.5 rounded-lg border border-line-subtle bg-sunken/60 p-0.5">
      {KIND_FILTERS.map((entry) => {
        const active = value === entry.id;
        return (
          <button
            key={entry.id}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => { onChange(entry.id); }}
            className={cn(
              "pressable relative inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption disabled:cursor-not-allowed disabled:text-fg-disabled",
              active ? "text-fg" : "text-fg-secondary enabled:hover:bg-raised enabled:hover:text-fg",
            )}
          >
            {active ? (
              <motion.span
                layoutId={`${baseId}-kind-mark`}
                aria-hidden
                transition={motionTransition("spring-snappy", "spring-snappy")}
                className="absolute inset-0 rounded-md bg-brand-gradient-soft ring-1 ring-brand-blue/40"
              />
            ) : null}
            <entry.icon aria-hidden className={cn("relative size-3.5", active ? "text-brand-cyan" : "text-fg-tertiary")} />
            <span className="relative">{entry.short}</span>
            <span className="machine relative text-fg-tertiary">{disabled ? "—" : counts[entry.id]}</span>
          </button>
        );
      })}
    </div>
  );
}
