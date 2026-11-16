// 從專案素材庫移除一個素材的確認框（專案面板「素材」分頁每個素材的移除按鈕）。沒有地方使用時確認後移除；還在使用時
// 列出使用處（影片鏡頭的參考與首幀、Image Studio 圖片的參考圖與遮罩、一鍵換角的來源影片、時間軸上的片段）並停用移除：影片鏡頭可以直接
// 選取，Image Studio 的圖片可以直接打開。移除只把項目從專案文件拿掉，不刪除檔案（見 model/library）。
import { AtSign, ExternalLink, Film, Images, Link2, MousePointerClick, Replace, SquareDashed, Trash2, type LucideIcon } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { imageStudioPath } from "@/app/paths";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/variants";
import { formatList, joinInline } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { useShotActions } from "../hooks/useShotActions";
import { libraryUseKey, withoutLibraryItem, type LibraryUse } from "../model/library";
import { itemFacts } from "../references/display";
import { KIND_LABEL } from "../references/materials";
import { LibraryThumb } from "../references/ReferenceRow";
import { useStudio } from "../studioContext";
import { t } from "@/i18n";

const USE_ICON: Record<LibraryUse["kind"], LucideIcon> = {
  reference: AtSign,
  first_frame: Link2,
  image_reference: Images,
  image_mask: SquareDashed,
  swap_source: Replace,
  timeline: Film,
};

/** 用在哪裡（what）與怎麼拿掉（how）。 */
function describeUse(use: LibraryUse): { what: string; how: string } {
  switch (use.kind) {
    case "reference":
      return { what: t("參考 {aliases}", { aliases: formatList(use.aliases) }), how: t("在屬性面板的「參考」分頁移除") };
    case "first_frame":
      return { what: t("首幀"), how: t("在屬性面板的「生成」分頁換一張圖片，或改成「不使用首幀」") };
    case "image_reference":
      return { what: t("參考圖片"), how: t("在 Image Studio 的「圖片」分頁移除") };
    case "image_mask":
      return { what: t("遮罩"), how: t("在 Image Studio 的「圖片」分頁停用或換掉遮罩") };
    case "swap_source":
      return { what: t("來源影片"), how: t("換角工作的設定與匯出用的原音軌都在這段影片上，不能從素材庫移除") };
    case "timeline":
      return { what: t("時間軸上 {count} 個片段", { count: use.clips }), how: t("在「編輯」的時間軸刪除這些片段（專案面板會標出使用次數）") };
  }
}

function UseRow({ use, projectId, onSelectShot }: { use: LibraryUse; projectId: string; onSelectShot: (shotId: string) => void }) {
  const Icon = USE_ICON[use.kind];
  const { what, how } = describeUse(use);
  return (
    <li className="flex min-w-0 items-start gap-2 px-3 py-2">
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-tertiary" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="flex min-w-0 items-baseline gap-1.5 text-data text-fg">
          {use.kind === "reference" || use.kind === "first_frame" ? (
            <>
              {/* 和鏡頭清單一樣的兩位數編號 */}
              <span className="machine shrink-0 text-caption text-fg-tertiary">{String(use.index + 1).padStart(2, "0")}</span>
              <span className="truncate">{use.title}</span>
            </>
          ) : use.kind === "swap_source" ? (
            t("一鍵換角")
          ) : use.kind === "timeline" ? (
            t("時間軸")
          ) : (
            <span className="truncate">{use.title ? joinInline(["Image Studio", use.title]) : "Image Studio"}</span>
          )}
        </p>
        <p className="text-caption text-fg-secondary">{what}</p>
        <p className="text-caption text-fg-tertiary">{how}</p>
      </div>
      {use.kind === "reference" || use.kind === "first_frame" ? (
        <Button size="sm" variant="quiet" className="min-h-7 shrink-0 px-2" icon={<MousePointerClick aria-hidden />} onClick={() => onSelectShot(use.shotId)}>
          {t("選取鏡頭")}
        </Button>
      ) : use.kind === "image_reference" || use.kind === "image_mask" ? (
        <Link to={imageStudioPath(projectId, use.shotId)} className={cn(buttonVariants({ variant: "quiet", size: "sm" }), "min-h-7 shrink-0 px-2")}>
          <ExternalLink aria-hidden />
          {t("在 Image Studio 開啟")}
        </Link>
      ) : null}
    </li>
  );
}

export function LibraryRemoveDialog({
  itemId,
  uses,
  onClose,
  onRemoved,
}: {
  /** 要移除的素材（null＝關閉）。 */
  itemId: string | null;
  /** 這個素材目前的使用處（model/library 的 libraryUses，含一鍵換角的來源影片）；空＝可以移除。 */
  uses: readonly LibraryUse[];
  onClose: () => void;
  /** 移除後（確認框關閉時）把焦點交給呼叫端：被移除那一列的按鈕已不在畫面上。 */
  onRemoved: (item: StudioLibraryItem) => void;
}) {
  const { project, dispatch, notify } = useStudio();
  const actions = useShotActions();
  const removed = useRef<StudioLibraryItem | null>(null);
  const item = itemId ? (project.library ?? []).find((entry) => entry.item_id === itemId) : undefined;
  const blocked = uses.length > 0 ? t("還在使用中，不能移除") : null;
  const facts = item ? itemFacts(item) : "";
  const remove = () => {
    // 與 reducer 同一個判斷：不會移除時（例如剛好有鏡頭開始使用它）不送出、也不說已移除
    if (!item || blocked || withoutLibraryItem(project, item.item_id) === project) return;
    removed.current = item;
    dispatch({ type: "removeLibraryItem", itemId: item.item_id });
    notify({ tone: "success", title: t("已從專案素材庫移除「{name}」", { name: item.name }), detail: t("檔案沒有刪除，已渲染的 take 不受影響。") });
    onClose();
  };
  const selectShot = (shotId: string) => {
    actions.openInSource(shotId);
    onClose();
  };
  return (
    <Dialog
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {item ? (
        <DialogContent
          onKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            const done = removed.current;
            if (!done) return;
            removed.current = null;
            event.preventDefault();
            onRemoved(done);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("從專案素材庫移除「{name}」？", { name: item.name })}</DialogTitle>
            <DialogDescription>
              {uses.some((use) => use.kind === "swap_source")
                ? t("這段影片是一鍵換角的來源影片，不能從素材庫移除。")
                : blocked
                  ? t("這個素材還在使用中：先在下面的地方拿掉它，才能從素材庫移除。")
                  : t("只從這個專案的素材庫拿掉，不會刪除檔案，已渲染的 take 也不受影響。Image Studio 共用同一份素材庫，那邊也會看不到它。")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <div className="grid min-w-0 grid-cols-[4rem_minmax(0,1fr)] items-center gap-3 rounded-lg border border-line-subtle bg-canvas/60 p-2">
              <span className="grid aspect-video w-16 place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage">
                <LibraryThumb item={item} />
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate text-data text-fg" title={item.name}>
                  {item.name}
                </span>
                <span className="truncate text-caption text-fg-tertiary">{joinInline([KIND_LABEL[item.kind], ...(facts ? [facts] : [])])}</span>
              </span>
            </div>
            {uses.length > 0 ? (
              <ul aria-label={t("使用這個素材的地方（{usesCount}）", { usesCount: uses.length })} className="grid divide-y divide-line-subtle rounded-lg border border-warning/40 bg-warning/5">
                {uses.map((use) => (
                  <UseRow key={libraryUseKey(use)} use={use} projectId={project.project_id} onSelectShot={selectShot} />
                ))}
              </ul>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{blocked ? t("關閉") : t("取消")}</Button>
            </DialogClose>
            <Button variant="danger-confirm" icon={<Trash2 aria-hidden />} disabled={Boolean(blocked)} title={blocked ?? undefined} onClick={remove}>
              {t("移除")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
