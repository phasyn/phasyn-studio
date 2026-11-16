// One reference of the project's library in the 素材 tab: thumbnail (its kind, and the length of a video or a sound, on
// it), name and where it is used. A click opens it in the asset library (preview, rename, notes, uses); its "…" menu
// also removes it from the library (asks first; an item that is still used cannot be removed).
import { Ellipsis } from "lucide-react";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { MenuTriggerButton } from "@/components/ui/action-menu";
import { HUD_BUTTON, HUD_CHIP, LIFT, THUMB_ZOOM, TILE } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { joinInline } from "@/i18n/format";
import type { LibraryUse } from "../../model/library";
import { itemFacts } from "../../references/display";
import { KindIcon } from "../../references/KindIcon";
import { KIND_LABEL } from "../../references/materials";
import { LibraryThumb } from "../../references/ReferenceRow";
import { itemDuration } from "../library/display";

/** Where an item is used: how many video shots, how many Image Studio images, the character swap's source video, timeline clips. */
function usageSummary(uses: readonly LibraryUse[]): string {
  const count = (kinds: readonly LibraryUse["kind"][]) => new Set(uses.flatMap((use) => (kinds.includes(use.kind) && "shotId" in use ? [use.shotId] : []))).size;
  const usedBy = count(["reference", "first_frame"]);
  const images = count(["image_reference", "image_mask"]);
  const parts: string[] = [];
  if (usedBy > 0) parts.push(t("{usedBy} 個鏡頭使用", { usedBy }));
  if (images > 0) parts.push(t("{count} 張 Image Studio 圖片使用", { count: images }));
  if (uses.some((use) => use.kind === "swap_source")) parts.push(t("一鍵換角的來源影片"));
  const clips = uses.reduce((sum, use) => (use.kind === "timeline" ? sum + use.clips : sum), 0);
  if (clips > 0) parts.push(t("時間軸上 {count} 個片段", { count: clips }));
  return parts.length > 0 ? joinInline(parts) : t("還沒有鏡頭使用");
}

export interface MediaTileProps {
  item: StudioLibraryItem;
  uses: readonly LibraryUse[];
  index: number;
  menuOpen: boolean;
  menuId: string;
  onOpen: (itemId: string) => void;
  onMenu: (itemId: string, element: HTMLButtonElement, focus: "first" | "last") => void;
  onCloseMenu: () => void;
}

export function MediaTile({ item, uses, index, menuOpen, menuId, onOpen, onMenu, onCloseMenu }: MediaTileProps) {
  const usage = usageSummary(uses);
  const facts = itemFacts(item);
  return (
    <li ref={reveal(index)} className={cn(LIFT, "relative rounded-xl")}>
      <button
        type="button"
        data-library-open={item.item_id}
        onClick={() => onOpen(item.item_id)}
        aria-label={t("在素材庫查看「{name}」", { name: item.name })}
        title={[item.name, `${KIND_LABEL[item.kind]}${facts ? t("・{item}", { item: facts }) : ""}`, usage].join("\n")}
        className={cn(TILE, "pressable grid w-full gap-1 p-1.5 text-left hover:border-brand-blue/45 active:bg-sunken focus-visible:ring-2 focus-visible:ring-focus")}
      >
        <span className="relative grid aspect-video place-items-center overflow-hidden rounded-lg border border-line-subtle bg-stage">
          <LibraryThumb item={item} className={THUMB_ZOOM} />
          <span className={cn(HUD_CHIP, "absolute bottom-1 left-1 inline-flex items-center gap-1 px-1.5 text-[11px]")}>
            <KindIcon kind={item.kind} className="size-3" />
            {item.kind === "image" ? null : <span className="machine">{itemDuration(item)}</span>}
          </span>
        </span>
        <span className="truncate px-0.5 text-caption text-fg">{item.name}</span>
        <span className="truncate px-0.5 text-[11px] leading-4 text-fg-tertiary">{usage}</span>
      </button>
      <MenuTriggerButton
        menuId={menuId}
        open={menuOpen}
        label={t("「{title}」的動作", { title: item.name })}
        onOpen={(element, focus) => onMenu(item.item_id, element, focus)}
        onClose={onCloseMenu}
        className={cn(HUD_BUTTON, "absolute top-2.5 right-2.5")}
      >
        <Ellipsis aria-hidden />
      </MenuTriggerButton>
    </li>
  );
}
