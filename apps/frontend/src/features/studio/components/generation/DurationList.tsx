// The lengths a shot can have: 17n+5 frames within H3's range (model/frames.ts), one option per line with its frame
// count. A current length that is not one of them (an older document) stays listed as it is, so nothing changes until
// another length is chosen. ↑／↓／Home／End move, Enter or Space chooses; the current length has focus on opening.
import { Check } from "lucide-react";
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { formatDuration, frameOptions } from "../../model/frames";
import { t } from "@/i18n";

export function DurationList({ frames, onPick }: { frames: number; onPick: (frames: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const standard = frameOptions();
  const options = standard.includes(frames) ? standard : [...standard, frames].sort((a, b) => a - b);

  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
    const index = items.findIndex((item) => item === document.activeElement);
    const target = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (target === null) return;
    event.preventDefault();
    const item = items[Math.max(0, Math.min(items.length - 1, target))];
    item?.focus();
    item?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div ref={list} role="listbox" aria-label={t("時長")} onKeyDown={onKeyDown} className="grid max-h-80 min-h-0 gap-0.5 overflow-y-auto p-1.5">
      {options.map((value) => {
        const selected = value === frames;
        const unusual = !standard.includes(value);
        const choose = () => onPick(value);
        return (
          <div
            key={value}
            role="option"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-autofocus={selected ? "" : undefined}
            onClick={choose}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              choose();
            }}
            className={cn(
              "flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-data outline-none transition-colors duration-(--duration-fast)",
              "hover:bg-brand-gradient-soft focus:bg-brand-gradient-soft focus-visible:ring-1 focus-visible:ring-brand-blue/55 focus-visible:ring-inset",
              selected ? "text-fg" : "text-fg-secondary",
            )}
          >
            <Check aria-hidden className={cn("size-3.5 shrink-0 text-brand-cyan", selected ? "animate-pop-in" : "invisible")} />
            <span className="min-w-0 flex-1 truncate">{formatDuration(value)}</span>
            <span className="machine shrink-0 text-caption text-fg-tertiary">{unusual ? t("{frames} 影格・目前的值", { frames: value }) : t("{frames} 影格", { frames: value })}</span>
          </div>
        );
      })}
    </div>
  );
}
