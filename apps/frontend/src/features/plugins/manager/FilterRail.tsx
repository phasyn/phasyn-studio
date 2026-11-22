// 管理視窗左欄的篩選（類型、來源、狀態…）：每組一個標題與幾個選項，選項附數量；目前選項的底色在同一組內滑動。
import type { LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";

export interface RailOption<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  count: number;
}

export interface RailGroup<T extends string> {
  id: string;
  title: string;
  value: T;
  options: readonly RailOption<T>[];
  onChange: (value: T) => void;
}

function RailButton<T extends string>({ group, option }: { group: RailGroup<T>; option: RailOption<T> }) {
  const active = group.value === option.id;
  const Icon = option.icon;
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={() => { group.onChange(option.id); }}
      className={cn(
        "pressable relative flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-body",
        active ? "text-fg" : "text-fg-secondary hover:bg-raised/70 hover:text-fg",
      )}
    >
      {active ? (
        <motion.span
          layoutId={`plugin-rail-${group.id}`}
          transition={motionTransition("spring-snappy", "spring-snappy")}
          aria-hidden
          className="absolute inset-0 rounded-md border border-brand-blue/40 bg-brand-gradient-soft"
        />
      ) : null}
      <Icon aria-hidden className={cn("relative size-4 shrink-0", active ? "text-brand-cyan" : "text-fg-tertiary")} />
      <span className="relative min-w-0 flex-1 truncate">{option.label}</span>
      <span className="machine relative text-caption text-fg-tertiary">{option.count}</span>
    </button>
  );
}

/** 每組的型別不同（類型、來源…），所以以各自的 RailGroup 傳入。 */
export function FilterRail({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <aside aria-label={label} className={cn("flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-line-subtle bg-canvas/40 p-3", className)}>
      {children}
    </aside>
  );
}

export function RailSection<T extends string>({ group }: { group: RailGroup<T> }) {
  return (
    <nav aria-label={group.title} className="grid gap-0.5">
      <h3 className="px-2.5 pb-1 text-caption font-semibold text-fg-tertiary">{group.title}</h3>
      {group.options.map((option) => (
        <RailButton key={option.id} group={group} option={option} />
      ))}
    </nav>
  );
}
