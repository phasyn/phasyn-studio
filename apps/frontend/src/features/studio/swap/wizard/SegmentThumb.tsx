// A planned segment's picture in the wizard's segment table: the original's frame in the middle of what the segment
// keeps, read once its row comes near the view (sourceThumbs), so the user sees who is in the segment while ticking
// its characters. Loading shows the shared skeleton; a picture that cannot be read says why on hover.
import { ImageOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useSourceThumb } from "../sourceThumbs";
import { t } from "@/i18n";

export function SegmentThumb({ url, seconds, label }: { url: string | null; seconds: number; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = ref.current;
    if (seen || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setSeen(true);
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [seen]);
  const state = useSourceThumb(url, seconds, seen);
  return (
    <div ref={ref} className="relative aspect-video w-full overflow-hidden rounded-md border border-line-subtle bg-stage">
      {state?.status === "ready" ? (
        <img src={state.src} alt={label} className="size-full object-contain animate-fade-in" />
      ) : state?.status === "failed" ? (
        <span className="grid size-full place-items-center text-fg-tertiary" title={t("讀不到這一格畫面：{reason}", { reason: state.reason })}>
          <ImageOff aria-hidden className="size-4" />
          <span className="sr-only">{t("讀不到這一格畫面：{reason}", { reason: state.reason })}</span>
        </span>
      ) : (url != null && url !== "") ? (
        <Skeleton className="size-full rounded-none" />
      ) : null}
    </div>
  );
}
