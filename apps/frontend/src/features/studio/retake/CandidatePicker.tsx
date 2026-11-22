// The candidate cards of the range dialog: a frame of each take or result with 「take 3」 and its seed (or when it was
// made) under it; the chosen one carries the brand outline. A radio group: one tab stop, arrows move the choice.
import { AudioLines, Film } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { mediaUrl } from "@/api/http";
import { CHOICE_BASE, CHOICE_IDLE, CHOICE_SELECTED, THUMB_ZOOM } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { useFilmstrip } from "../hooks/useMediaPreview";
import type { Candidate } from "./candidates";

function Thumb({ item }: { item: Candidate }) {
  const url = mediaUrl(item.file.node_id, item.file.file_id);
  const frame = useFilmstrip(item.media === "video" ? url : null, 1, 160)[0];
  const picture = item.media === "image" ? url : frame;
  return (
    <span className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-md bg-stage">
      {picture != null && picture !== ""
        ? <img src={picture} alt="" draggable={false} className={cn("size-full object-cover animate-fade-in", THUMB_ZOOM)} />
        : item.media === "audio" ? <AudioLines aria-hidden className="size-5 text-fg-disabled" /> : <Film aria-hidden className="size-5 text-fg-disabled" />}
    </span>
  );
}

export function CandidatePicker({ items, value, onChange, label }: { items: readonly Candidate[]; value: string; onChange: (key: string) => void; label: string }) {
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  const current = items.findIndex((item) => item.key === value);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = items[(index + step + items.length) % items.length];
    if (!next) return;
    onChange(next.key);
    buttonsRef.current.get(next.key)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
      {items.map((item, index) => {
        const selected = item.key === value;
        return (
          <button
            key={item.key}
            ref={(node) => { if (node) buttonsRef.current.set(item.key, node); else buttonsRef.current.delete(item.key); }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (current < 0 && index === 0) ? 0 : -1}
            title={item.detail ? `${item.title} · ${item.detail}` : item.title}
            onClick={() => { onChange(item.key); }}
            onKeyDown={(event) => { move(event, index); }}
            className={cn(CHOICE_BASE, "group/tile grid min-w-0 gap-1 rounded-lg p-1.5 text-left animate-reveal [animation-fill-mode:both]", selected ? CHOICE_SELECTED : CHOICE_IDLE)}
            style={{ animationDelay: `${String(Math.min(index, 12) * 24)}ms` }}
          >
            <Thumb item={item} />
            <span className="truncate px-0.5 text-data font-medium text-fg">{item.title}</span>
            <span className="machine h-4 truncate px-0.5 text-caption text-fg-tertiary">{item.detail}</span>
          </button>
        );
      })}
    </div>
  );
}
