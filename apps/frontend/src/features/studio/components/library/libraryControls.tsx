// The asset library's small controls: a category button in the left column (the current one carries a brand mark that
// slides between categories), the shot filter under 渲染結果 and the icon toggles of the toolbar.
import { motion } from "motion/react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";

/** 左側分類的一個按鈕：目前的分類有品牌色標記（Motion layoutId 在分類之間滑動）。 */
export function CategoryButton({ group, active, label, icon: Icon, count, onClick }: { group: string; active: boolean; label: string; icon: LucideIcon; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "pressable relative flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-data transition-colors duration-(--duration-fast)",
        active ? "text-fg" : "text-fg-secondary hover:bg-raised/70 hover:text-fg",
      )}
    >
      {active ? (
        <motion.span
          layoutId={`library-category-${group}`}
          transition={motionTransition("spring-snappy", "spring-snappy")}
          aria-hidden
          className="absolute inset-0 rounded-md border border-brand-blue/40 bg-brand-gradient-soft"
        />
      ) : null}
      <Icon aria-hidden className={cn("relative size-4 shrink-0", active ? "text-brand-cyan" : "text-fg-tertiary")} />
      <span className="relative min-w-0 flex-1 truncate">{label}</span>
      <span className="machine relative text-caption text-fg-tertiary">{count}</span>
    </button>
  );
}

export function ToggleButton({ pressed, label, onClick, children }: { pressed: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "pressable inline-flex size-7 items-center justify-center rounded-md transition-colors duration-(--duration-fast) [&_svg]:size-4",
        pressed ? "bg-brand-gradient-soft text-brand-cyan ring-1 ring-brand-blue/40" : "text-fg-tertiary hover:bg-raised hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** 渲染結果的鏡頭篩選（縮排在「渲染結果」下面）。 */
export function ShotFilterButton({ active, index, title, count, onClick }: { active: boolean; index: number; title: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={cn(
        "pressable flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-caption transition-colors duration-(--duration-fast)",
        active ? "bg-brand-gradient-soft text-fg ring-1 ring-brand-blue/40" : "text-fg-secondary hover:bg-raised/70 hover:text-fg",
      )}
    >
      <span className="machine shrink-0 text-fg-tertiary">{String(index + 1).padStart(2, "0")}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="machine shrink-0 text-fg-tertiary">{count}</span>
    </button>
  );
}
