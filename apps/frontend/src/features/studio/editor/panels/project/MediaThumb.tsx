// The thumbnail of a Project panel grid cell: a frame of a video (moving the pointer across it scrubs through the
// clip), the picture itself for an image, a glyph for sound, and a hatched placeholder for a shot that is not
// rendered yet. The picture is never tinted and nothing here animates on its own.
import { AudioLines, Clapperboard, Film, ImageOff } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { mediaUrl } from "@/api/http";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useFilmstrip } from "../../../hooks/useMediaPreview";
import type { MediaItem } from "./media";

/** The same hatch the timeline draws on the placeholder clip of an unrendered shot. */
const HATCH = "bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.07)_0_6px,transparent_6px_12px)]";
/** Frames a hover scrub steps through. */
const SCRUB_FRAMES = 8;
/** Width the frames are captured at: two device pixels per pixel of the widest cell. */
const CAPTURE_WIDTH = 256;

function VideoThumb({ url }: { url: string }) {
  const frame = useRef<HTMLSpanElement>(null);
  // Frames are captured only for thumbnails that have been on screen: a long grid does not decode every video at once
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = frame.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setSeen(true);
      observer.disconnect();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const poster = useFilmstrip(seen ? url : null, 1, CAPTURE_WIDTH)[0];
  // The scrub frames are captured the first time the pointer comes over the thumbnail; null = it is elsewhere
  const [step, setStep] = useState<number | null>(null);
  const strip = useFilmstrip(step === null ? null : url, SCRUB_FRAMES, CAPTURE_WIDTH);
  const scrub = (event: PointerEvent<HTMLSpanElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    setStep(Math.max(0, Math.min(SCRUB_FRAMES - 1, Math.floor(fraction * SCRUB_FRAMES))));
  };
  const scrubbed = step === null ? undefined : strip[step];
  const shown = scrubbed ?? poster;
  return (
    <span ref={frame} className="absolute inset-0 grid place-items-center" onPointerMove={scrub} onPointerLeave={() => setStep(null)}>
      {shown ? <img src={shown} alt="" draggable={false} className="size-full object-contain" /> : <Film className="size-5 text-fg-disabled" />}
      {step !== null && scrubbed ? <span className="absolute bottom-0 left-0 h-0.5 bg-playhead" style={{ width: `${((step + 1) / SCRUB_FRAMES) * 100}%` }} /> : null}
    </span>
  );
}

function ImageThumb({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ImageOff className="size-5 text-fg-disabled" />;
  return <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} className="size-full object-contain" />;
}

export function MediaThumb({ item, className }: { item: MediaItem; className?: string }) {
  const file = item.source.file;
  const url = file ? mediaUrl(file.node_id, file.file_id) : null;
  return (
    <span aria-hidden className={cn("relative grid aspect-video w-full place-items-center overflow-hidden rounded-md bg-stage", !url && HATCH, className)}>
      {!url ? (
        <span className="grid justify-items-center gap-1 text-fg-tertiary">
          <Clapperboard className="size-5" />
          <span className="text-[11px] leading-none">{t("尚未渲染")}</span>
        </span>
      ) : item.kind === "video" ? (
        <VideoThumb key={url} url={url} />
      ) : item.kind === "image" ? (
        <ImageThumb key={url} url={url} />
      ) : (
        <AudioLines className="size-6 text-clip-audio-edge" />
      )}
    </span>
  );
}
