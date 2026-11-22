// B of an A/B comparison in the take preview: the B take's video kept in step with A (seek, play, pause), shown right
// of a split line that is dragged (or moved with the arrow keys), or beside A. A stays SourceView's own video element,
// so picking another B or switching the mode never reloads or rewinds A. The A and B chips name a variant take by its
// number and variant badge (「A #3・seed 42・@Video1 …」), cut to their half of the picture.
import { ChevronsLeftRight } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { HUD_CHIP } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import type { CompareMode } from "./monitorTakes";

/** While playing, B is corrected only when it drifts this far (seconds); paused, it shows A's exact frame. */
const PLAYING_DRIFT = 0.1;

/** What the A and B chips say after their letter (a variant take's number and badge); null = the letter alone. */
export interface CompareChips {
  a: string | null;
  b: string | null;
}

function Chip({ letter, text, className }: { letter: string; text: string | null; className: string }) {
  return (
    <span aria-hidden className={cn(HUD_CHIP, "pointer-events-none absolute top-2 z-10 max-w-[calc(50%-1rem)] truncate", className)}>
      {(text != null && text !== "") ? `${letter} ${text}` : letter}
    </span>
  );
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/** The split line: drag it anywhere along its height, or focus it and use ← → (Shift: 10 %), Home, End. */
function WipeHandle({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    if (box && box.width > 0) onChange(clampPercent(((event.clientX - box.left) / box.width) * 100));
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 2;
    const next = ({ ArrowLeft: value - step, ArrowRight: value + step, Home: 0, End: 100 } as Record<string, number>)[event.key];
    if (next === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    onChange(clampPercent(next));
  };
  const percent = Math.round(value);
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={t("A/B 分割位置")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${String(percent)}%`}
      data-arrow-keys=""
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        follow(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) follow(event);
      }}
      onKeyDown={keys}
      className="group/wipe absolute inset-y-0 z-10 w-6 -translate-x-1/2 cursor-ew-resize touch-none outline-none"
      style={{ left: `${String(value)}%` }}
    >
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-brand-cyan shadow-glow-sm" />
      <span
        aria-hidden
        className="material-hud pointer-events-none absolute top-1/2 left-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/15 text-fg transition-[scale] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) group-hover/wipe:scale-110 group-focus-visible/wipe:ring-2 group-focus-visible/wipe:ring-focus"
      >
        <ChevronsLeftRight className="size-3.5" />
      </span>
    </div>
  );
}

export function CompareLayer({ primary, src, mode, fps, chips }: { primary: RefObject<HTMLVideoElement | null>; src: string; mode: CompareMode; fps: number; chips: CompareChips }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [wipe, setWipe] = useState(50);

  useEffect(() => {
    const a = primary.current;
    const b = ref.current;
    if (!a || !b) return;
    const sync = () => {
      const allowed = a.paused ? 0.5 / fps : PLAYING_DRIFT;
      if (Math.abs(b.currentTime - a.currentTime) > allowed) b.currentTime = a.currentTime;
    };
    const play = () => void b.play().catch(() => undefined);
    const pause = () => { b.pause(); };
    // A new B joins where A is (and plays along when A plays)
    const join = () => {
      sync();
      if (!a.paused) play();
    };
    a.addEventListener("seeked", sync);
    a.addEventListener("timeupdate", sync);
    a.addEventListener("play", play);
    a.addEventListener("pause", pause);
    b.addEventListener("loadeddata", join);
    join();
    return () => {
      a.removeEventListener("seeked", sync);
      a.removeEventListener("timeupdate", sync);
      a.removeEventListener("play", play);
      a.removeEventListener("pause", pause);
      b.removeEventListener("loadeddata", join);
    };
  }, [primary, src, fps]);

  const side = mode === "side";
  return (
    <>
      <video
        ref={ref}
        src={src}
        muted
        playsInline
        preload="auto"
        aria-hidden
        className={cn("pointer-events-none absolute object-contain animate-fade-in", side ? "inset-y-0 right-0 h-full w-1/2" : "inset-0 size-full")}
        style={side ? undefined : { clipPath: `inset(0 0 0 ${String(wipe)}%)` }}
      />
      {side ? <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-line-strong" /> : <WipeHandle value={wipe} onChange={setWipe} />}
      <Chip letter="A" text={chips.a} className="left-2" />
      <Chip letter="B" text={chips.b} className={cn("ring-1 ring-entity/60", side ? "left-[calc(50%+0.5rem)]" : "right-2")} />
    </>
  );
}
