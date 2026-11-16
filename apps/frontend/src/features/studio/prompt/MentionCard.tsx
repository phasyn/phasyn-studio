// The card a resolved @ name shows while the pointer rests on it or the caret stands in it: the reference's picture
// (160 px wide: the image, a video's first frame, a sound's icon), its @ name and H3 tag, and its file name, or that the
// file has left the library. It sits under the name (above it when the field has no room below), inside the editor box,
// hides while the name is scrolled out of view, never takes the pointer and pops in with the snappy spring.
import { useLayoutEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { ReferenceThumb } from "../references/ReferenceThumb";
import type { MentionOption } from "./mentions";

const GAP = 6;
/** Picture height ÷ width is kept between 16:9 and 4:5, so a tall portrait does not cover the field. */
const MIN_RATIO = 9 / 16;
const MAX_RATIO = 5 / 4;

function pictureRatio(option: MentionOption): number {
  const width = option.item?.width ?? null;
  const height = option.item?.height ?? null;
  if (!width || !height) return MIN_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, height / width));
}

export function MentionCard({
  option,
  start,
  container,
  layer,
  field,
}: {
  option: MentionOption;
  /** Start offset of the name (its mark in the highlight layer carries it). */
  start: number;
  /** The positioned box the card is placed in. */
  container: RefObject<HTMLElement | null>;
  layer: RefObject<HTMLElement | null>;
  field: RefObject<HTMLTextAreaElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const card = ref.current;
    const box = container.current;
    const view = field.current;
    const mark = layer.current?.querySelector<HTMLElement>(`[data-mark-start="${start}"]`);
    if (!card) return;
    const rect = mark?.getClientRects()[0];
    if (!box || !view || !rect) {
      card.style.visibility = "hidden";
      return;
    }
    const frame = box.getBoundingClientRect();
    const visible = view.getBoundingClientRect();
    // The name is scrolled out of the field's visible part: no card
    if (rect.bottom < visible.top + view.clientTop || rect.top > visible.top + view.clientTop + view.clientHeight) {
      card.style.visibility = "hidden";
      return;
    }
    const below = rect.bottom - frame.top + GAP;
    const above = rect.top - frame.top - GAP - card.offsetHeight;
    const room = visible.bottom - frame.top;
    const top = below + card.offsetHeight <= room || above < 0 ? below : above;
    const left = Math.min(Math.max(0, rect.left - frame.left - 4), Math.max(0, box.clientWidth - card.offsetWidth));
    card.style.top = `${Math.round(top)}px`;
    card.style.left = `${Math.round(left)}px`;
    card.style.visibility = "visible";
  });

  return (
    <div ref={ref} aria-hidden className="material-popover pointer-events-none absolute top-0 left-0 z-20 grid w-44 gap-1.5 rounded-xl p-2 text-fg animate-pop-in">
      {option.kind === "audio" ? (
        <ReferenceThumb item={option.item} kind="audio" className="size-10" />
      ) : (
        <span className="block w-40 overflow-hidden rounded-md" style={{ aspectRatio: `1 / ${pictureRatio(option)}` }}>
          <ReferenceThumb item={option.item} kind={option.kind} className="size-full rounded-md" />
        </span>
      )}
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="machine shrink-0 text-data text-fg">@{option.alias}</span>
        {option.label ? <span className="machine truncate text-caption text-fg-tertiary">{option.label}</span> : null}
      </span>
      <span className={cn("truncate text-caption", option.name ? "text-fg-secondary" : "text-warning")}>{option.name ?? t("檔案已不在素材庫")}</span>
    </div>
  );
}
