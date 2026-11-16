// 一次移除幾個選取的素材：只移除沒有地方使用的（規則同 LibraryRemoveDialog／model/library），還在使用的留著並說明數量。
import { Trash2 } from "lucide-react";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { withoutLibraryItem, type LibraryUse } from "../../model/library";
import { LibraryThumb } from "../../references/ReferenceRow";
import { useStudio } from "../../studioContext";
import { t } from "@/i18n";

export function LibraryBulkRemoveDialog({
  items,
  uses,
  onClose,
  onRemoved,
}: {
  /** 要移除的素材（null＝關閉）。 */
  items: readonly StudioLibraryItem[] | null;
  uses: ReadonlyMap<string, readonly LibraryUse[]>;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { project, dispatch, notify } = useStudio();
  const removable = (items ?? []).filter((item) => !uses.has(item.item_id));
  const kept = (items?.length ?? 0) - removable.length;
  const remove = () => {
    let next = project;
    let count = 0;
    for (const item of removable) {
      // 與 reducer 同一個判斷：剛好開始被使用的素材不移除
      const after = withoutLibraryItem(next, item.item_id);
      if (after === next) continue;
      next = after;
      count += 1;
      dispatch({ type: "removeLibraryItem", itemId: item.item_id });
    }
    if (count > 0) notify({ tone: "success", title: t("已從專案素材庫移除 {count} 個素材", { count }), detail: t("檔案沒有刪除，已渲染的 take 不受影響。") });
    onClose();
    onRemoved();
  };
  return (
    <Dialog
      open={items !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {items ? (
        <DialogContent onKeyDown={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t("從專案素材庫移除 {count} 個素材？", { count: removable.length })}</DialogTitle>
            <DialogDescription>
              {kept > 0
                ? t("{kept} 個還在使用中的素材會留著；先在使用它的鏡頭或時間軸拿掉，才能移除。", { kept })
                : t("只從這個專案的素材庫拿掉，不會刪除檔案，已渲染的 take 也不受影響。Image Studio 共用同一份素材庫，那邊也會看不到它。")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ul aria-label={t("要移除的素材")} className="grid max-h-72 gap-1 overflow-y-auto">
              {removable.map((item) => (
                <li key={item.item_id} className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2 rounded-md border border-line-subtle bg-canvas/60 p-1.5">
                  <span className="grid aspect-video place-items-center overflow-hidden rounded border border-line-subtle bg-stage">
                    <LibraryThumb item={item} />
                  </span>
                  <span className="truncate text-caption text-fg">{item.name}</span>
                </li>
              ))}
            </ul>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{t("取消")}</Button>
            </DialogClose>
            <Button variant="danger-confirm" icon={<Trash2 aria-hidden />} disabled={removable.length === 0} onClick={remove}>
              {t("移除")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
