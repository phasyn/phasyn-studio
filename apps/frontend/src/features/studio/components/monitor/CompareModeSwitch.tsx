// How an A/B comparison is laid out (in the monitor's header while B is shown): 分割 (one picture, A left and B right of
// a line that is dragged) or 並排 (two pictures side by side, playing in step). A radio group in the segmented look:
// the selected thumb slides to the new choice; the choice changes at once.
import { Columns2, SquareSplitHorizontal, type LucideIcon } from "lucide-react";
import { useRef } from "react";
import { useThumb } from "@/components/flow/useThumb";
import { StableLabel } from "@/components/ui/stable-label";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { COMPARE_MODES, type CompareMode } from "./monitorTakes";

const CHOICES: Record<CompareMode, { label: string; title: string; icon: LucideIcon }> = {
  split: { label: t("分割"), title: t("同一個畫面：分割線左邊是 A、右邊是 B，拖曳分割線比較"), icon: SquareSplitHorizontal },
  side: { label: t("並排"), title: t("A 與 B 兩個畫面並排，同步播放"), icon: Columns2 },
};

export function CompareModeSwitch({ value, onChange }: { value: CompareMode; onChange: (mode: CompareMode) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  useThumb(listRef, thumbRef, '[role="radio"][aria-checked="true"]');
  const pick = (index: number) => {
    const next = COMPARE_MODES[(index + COMPARE_MODES.length) % COMPARE_MODES.length];
    if (!next) return;
    onChange(next);
    listRef.current?.querySelector<HTMLElement>(`[data-compare-mode="${next}"]`)?.focus();
  };
  return (
    <div ref={listRef} role="radiogroup" aria-label={t("A/B 比較方式")} className="relative inline-flex shrink-0 rounded-lg border border-line-control/70 bg-sunken p-0.5 animate-fade-in">
      <span
        ref={thumbRef}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 rounded-md border border-white/[0.07] bg-overlay opacity-0 shadow-[0_1px_2px_rgb(0_0_0/0.4),inset_0_1px_0_rgb(255_255_255/0.06)] transition-[transform,width,height,opacity] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)"
      />
      {COMPARE_MODES.map((mode, index) => {
        const choice = CHOICES[mode];
        const selected = mode === value;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            data-compare-mode={mode}
            tabIndex={selected ? 0 : -1}
            title={choice.title}
            onClick={() => onChange(mode)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") pick(index + 1);
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") pick(index - 1);
              else return;
              event.preventDefault();
            }}
            className={cn(
              "pressable relative z-[1] inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-focus [&_svg]:size-3.5",
              selected ? "text-fg [&_svg]:text-brand-cyan" : "text-fg-tertiary hover:text-fg-secondary",
            )}
          >
            <choice.icon aria-hidden />
            <StableLabel weight="medium" className={selected ? "font-medium" : undefined}>
              {choice.label}
            </StableLabel>
          </button>
        );
      })}
    </div>
  );
}
