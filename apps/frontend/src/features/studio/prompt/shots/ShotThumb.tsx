// A shot's picture in the 逐鏡描述 dialog: the motion reference's frame just after the shot's cut, read in this browser by
// the swap wizard's thumbnail reader (one read at a time, kept while the page lives). Loading shows the shared skeleton
// and the picture fades in; a frame that cannot be read, or a shot without a picture, says why on hover.
import { Film, ImageOff } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { useSourceThumb } from "../../swap/sourceThumbs";

export type ShotPicture = { url: string; seconds: number; title: string } | { reason: string };

export function ShotThumb({ picture, label }: { picture: ShotPicture; label: string }) {
  const readable = "url" in picture;
  const state = useSourceThumb(readable ? picture.url : null, readable ? picture.seconds : 0, readable);
  const failed = state?.status === "failed" ? t("讀不到這一格畫面：{reason}", { reason: state.reason }) : null;
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md border border-line-subtle bg-stage" title={failed ?? (readable ? picture.title : picture.reason)}>
      {state?.status === "ready" ? (
        <img src={state.src} alt={label} draggable={false} className="size-full object-contain animate-fade-in" />
      ) : failed !== null || !readable ? (
        <span className="grid size-full place-items-center text-fg-tertiary">
          {failed !== null ? <ImageOff aria-hidden className="size-4" /> : <Film aria-hidden className="size-4" />}
          <span className="sr-only">{failed ?? (readable ? "" : picture.reason)}</span>
        </span>
      ) : (
        <Skeleton className="size-full rounded-none" />
      )}
    </div>
  );
}
