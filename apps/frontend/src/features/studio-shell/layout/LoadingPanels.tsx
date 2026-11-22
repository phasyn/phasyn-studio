// Placeholder while a lazily loaded Studio part (a workspace, a dialog's content) loads: the rough shape of the panels
// that will appear (decorative skeletons) and one status line for assistive technology. It appears only after a short
// delay, so a chunk that is already cached never flashes a skeleton; `immediate` shows it at once (a first paint that
// must never be blank, such as opening a project).
import { useEffect, useState } from "react";
import { PANEL } from "@/components/ui/look";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

const SHOW_AFTER_MS = 150;

export function LoadingPanels({ label, panels = 3, className, immediate = false }: { label: string; panels?: 1 | 2 | 3; className?: string; immediate?: boolean }) {
  const [visible, setVisible] = useState(immediate);
  useEffect(() => {
    if (immediate) return undefined;
    const timer = window.setTimeout(() => { setVisible(true); }, SHOW_AFTER_MS);
    return () => { window.clearTimeout(timer); };
  }, [immediate]);
  const columns = panels === 3 ? "grid-cols-[minmax(0,16rem)_minmax(0,1fr)_minmax(0,20rem)]" : panels === 2 ? "grid-cols-[minmax(0,1fr)_minmax(0,20rem)]" : "grid-cols-1";
  return (
    <div className={cn("grid min-h-0 flex-1 gap-1.5 p-1.5", columns, className)}>
      <p role="status" className="sr-only">
        {label}
      </p>
      {visible
        ? Array.from({ length: panels }, (_, index) => (
            <div key={index} aria-hidden className={cn(PANEL, "gap-2.5 p-3 animate-fade-in")}>
              <Skeleton className="h-5 w-2/5" />
              <Skeleton className="h-28" />
              <Skeleton className="w-3/4" />
              <Skeleton className="w-1/2" />
            </div>
          ))
        : null}
    </div>
  );
}
