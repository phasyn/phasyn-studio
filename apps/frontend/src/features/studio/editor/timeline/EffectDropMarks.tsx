// What a dragged item of the Effects browser would land on, drawn over one track: the clips an effect goes onto, the
// frames a transition or a fade covers; red where the release would be refused (the status line says why).
import { cn } from "@/lib/cn";
import type { EffectDropPreview } from "./useEffectDrop";

export function EffectDropMarks({ effect, trackId, zoom }: { effect: EffectDropPreview | null; trackId: string; zoom: number }) {
  if (!effect) return null;
  return effect.marks
    .filter((mark) => mark.trackId === trackId)
    .map((mark) => {
      // A refused edit point is a frame wide: it is drawn as a short bar centred on it
      const width = Math.max(4, (mark.end - mark.start) * zoom);
      return (
        <span
          key={`${mark.start}-${mark.end}`}
          className={cn(
            "pointer-events-none absolute inset-y-[2px] z-20 animate-fade-in rounded-[5px] border-2",
            effect.error ? "border-danger bg-danger/15" : "border-brand-cyan bg-brand-cyan/15",
          )}
          style={{ left: ((mark.start + mark.end) / 2) * zoom - width / 2, width }}
        />
      );
    });
}
