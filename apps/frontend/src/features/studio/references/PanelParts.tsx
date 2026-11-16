// Parts of the references tab: the limit badges (only once a limit is near, materials.nearLimit) and the drop highlight
// over the whole tab while files are dragged over it (useFileDropZone).
import { Upload } from "lucide-react";
import { createPortal } from "react-dom";
import type { StudioReference } from "@/api/generated/contracts";
import { Badge } from "@/components/ui/badge";
import { REF2VA_LIMITS } from "@/lib/h3Materials";
import { KIND_LABEL, nearLimit, type ReferenceKind } from "./materials";
import type { DropHighlight } from "./useFileDropZone";
import { t } from "@/i18n";

const KINDS: ReferenceKind[] = ["image", "video", "audio"];

/** Badges of the H3 limits that are near or reached; nothing while there is room. */
export function LimitBadges({ references }: { references: readonly StudioReference[] }) {
  const badges = KINDS.flatMap((kind): { key: string; label: string; count: number; limit: number }[] => {
    const count = references.filter((ref) => ref.kind === kind).length;
    return nearLimit(count, REF2VA_LIMITS[kind]) ? [{ key: kind, label: KIND_LABEL[kind], count, limit: REF2VA_LIMITS[kind] }] : [];
  });
  if (nearLimit(references.length, REF2VA_LIMITS.maxTotal)) badges.push({ key: "total", label: t("合計"), count: references.length, limit: REF2VA_LIMITS.maxTotal });
  if (badges.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1" aria-label={t("接近 H3 上限的參考素材數量")}>
      {badges.map((badge) => (
        <Badge key={badge.key} tone={badge.count > badge.limit ? "danger" : badge.count === badge.limit ? "warning" : "neutral"} className="animate-pop-in">
          {badge.label} <span className="machine">{badge.count}/{badge.limit}</span>
        </Badge>
      ))}
    </span>
  );
}

/** The whole tab as the drop target (top layer, never takes the pointer). */
export function DropOverlay({ highlight }: { highlight: DropHighlight }) {
  const { box, host } = highlight;
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-40 grid place-items-center rounded-xl bg-brand-soft outline-2 -outline-offset-4 outline-brand-cyan outline-dashed animate-fade-in"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <span className="material-popover flex items-center gap-2 rounded-full px-3.5 py-2 text-data text-fg animate-pop-in">
        <Upload aria-hidden className="size-4 text-brand-cyan" />
        {t("放開以上傳並加到這個鏡頭")}
      </span>
    </div>,
    host,
  );
}
