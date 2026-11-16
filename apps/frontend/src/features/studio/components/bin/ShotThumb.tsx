// A shot row's 64×36 thumbnail: the first frame of its active take. While the shot renders it is a generating frame
// (brand edge, slow glow, shimmering placeholder instead of the black "no picture" tile) with the render ring on top; in
// a multi-selection a selected shot carries a check mark.
import { Check, ImageOff } from "lucide-react";
import { mediaUrl } from "@/api/http";
import type { StudioTake } from "@/api/generated/contracts";
import { GeneratingFrame } from "@/components/common/GeneratingFrame";
import { SHIMMER, THUMB_ZOOM } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { useFilmstrip } from "../../hooks/useMediaPreview";
import { RenderRing } from "./RenderRing";

export interface ThumbRender {
  /** Measured share of the denoising (0–1); null = nothing measured yet. */
  fraction: number | null;
  waiting: boolean;
}

export function ShotThumb({ take, render, checked, dimmed }: { take: StudioTake | null; render: ThumbRender | null; checked: boolean; dimmed: boolean }) {
  const file = take?.state === "succeeded" ? take.asset?.file : undefined;
  const frames = useFilmstrip(file ? mediaUrl(file.node_id, file.file_id) : null, 1, 128);
  const frame = frames[0];
  return (
    <GeneratingFrame active={render !== null} className="h-9 w-16 shrink-0 rounded-md">
      <span className={cn("relative grid size-full place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage", dimmed && "opacity-60")}>
        {frame ? (
          <img src={frame} alt="" draggable={false} className={cn("size-full object-cover", THUMB_ZOOM, render && "opacity-45")} />
        ) : render ? (
          <span aria-hidden className={cn("absolute inset-0 bg-brand-gradient-soft", SHIMMER)} />
        ) : (
          <ImageOff aria-hidden className="size-4 text-fg-disabled" />
        )}
        {render ? <RenderRing fraction={render.fraction} waiting={render.waiting} className="absolute" /> : null}
      </span>
      {checked ? (
        <span aria-hidden className="absolute -top-1 -left-1 z-[3] grid size-4 place-items-center rounded-full bg-action text-[#fff] shadow-edge ring-2 ring-surface animate-pop-in [&_svg]:size-3">
          <Check />
        </span>
      ) : null}
    </GeneratingFrame>
  );
}
