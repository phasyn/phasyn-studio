// The 素材 tab of the project panel: the project's reference media (images, videos and sounds that shots use with @) as a
// two-column grid of thumbnails, newest first, with one 上傳 at the top right. Files dropped anywhere on the tab upload
// the same way; uploads only add to the library, never to a shot. Rendered takes and exports live in the asset library
// (渲染結果, 匯出成片), as does everything else about an item; the explanation shows only while the library is empty.
import { AtSign, Trash2, Upload, ZoomIn } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { CARD } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { libraryUses } from "../../model/library";
import { videoLibrary } from "../../references/materials";
import { ReferenceUploadRow } from "../../references/UploadRow";
import { findSwapJob } from "../../swap/job";
import { useStudio } from "../../studioContext";
import { openAssetLibrary } from "../library/libraryOpen";
import { LibraryRemoveDialog } from "../LibraryRemoveDialog";
import { MediaTile } from "./MediaTile";
import type { LibraryUploads } from "./useLibraryUploads";

const NO_USES: never[] = [];

interface TileMenu {
  itemId: string;
  element: HTMLButtonElement;
  focus: "first" | "last";
}

const acceptsFiles = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes("Files");

/** After a removal the focus goes to the neighbouring tile, or to 上傳 when the library is empty. */
function focusLater(itemId: string | null) {
  requestAnimationFrame(() => {
    const tile = (itemId != null && itemId !== "") ? document.querySelector<HTMLElement>(`[data-library-open="${CSS.escape(itemId)}"]`) : null;
    (tile ?? document.querySelector<HTMLElement>("[data-library-upload]"))?.focus();
  });
}

export function MediaTab({ uploads }: { uploads: LibraryUploads }) {
  const { project } = useStudio();
  const headingId = useId();
  const menuId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const [menu, setMenu] = useState<TileMenu | null>(null);
  /** The item in the remove confirmation, and the tile the focus goes to afterwards (decided when it opens). */
  const [removing, setRemoving] = useState<{ itemId: string; focusAfter: string | null } | null>(null);
  const all = project.library ?? [];
  // Image Studio masks are only used there: not listed (the empty state counts them)
  const library = videoLibrary(all);
  const masks = all.length - library.length;
  const uses = libraryUses(project, findSwapJob(project)?.source.item_id ?? null);
  const items = [...library].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const menuItem = menu ? items.find((item) => item.item_id === menu.itemId) : undefined;
  const addFiles = (files: File[]) => {
    const media = files.filter((file) => /^(image|video|audio)\//.test(file.type));
    if (media.length > 0) uploads.addFiles(media, false);
  };
  return (
    <section /* eslint-disable-line jsx-a11y-x/no-noninteractive-element-interactions -- This drop target complements the keyboard-accessible file picker in the same panel. */
      aria-labelledby={headingId}
      className={cn("relative flex min-h-0 flex-1 flex-col transition-[background-color,box-shadow] duration-(--duration-fast)", dropping && "bg-brand-soft ring-2 ring-brand-blue/70 ring-inset")}
      onDragEnter={(event) => {
        if (!acceptsFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragOver={(event) => {
        if (!acceptsFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        if (!acceptsFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle pr-2 pl-3">
        <h3 id={headingId} className="flex min-w-0 items-center gap-1.5 text-data font-semibold text-fg-secondary">
          <AtSign aria-hidden className="size-3.5 shrink-0 text-brand-cyan/80" />
          <span className="truncate">
            <T source={"參考素材庫<0>{libraryCount}</0>"} values={{ libraryCount: library.length }} slots={[<span key="slot-0" className="machine pl-1.5 font-normal text-fg-tertiary" />]} />
          </span>
        </h3>
        <Button
          data-library-upload=""
          size="sm"
          variant="secondary"
          className="ml-auto"
          icon={<Upload aria-hidden />}
          onClick={() => fileInputRef.current?.click()}
          title={t("上傳圖片、影片或聲音到專案素材庫（不會加到任何鏡頭）")}
        >
          {t("上傳")}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            addFiles(files);
          }}
        />
      </div>
      {uploads.tasks.length > 0 ? (
        <ul className={cn(CARD, "m-2 mb-0 grid shrink-0 gap-0.5 p-1")} aria-label={t("上傳")} aria-live="polite">
          {uploads.tasks.map((task) => (
            <ReferenceUploadRow key={task.key} task={task} onRetry={() => { uploads.retry(task.key); }} onDismiss={() => { uploads.dismiss(task.key); }} />
          ))}
        </ul>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-gutter:stable]">
        {items.length > 0 ? (
          <ul aria-label={t("參考素材庫")} className="grid grid-cols-2 gap-2">
            {items.map((item, index) => (
              <MediaTile
                key={item.item_id}
                item={item}
                uses={uses.get(item.item_id) ?? NO_USES}
                index={index}
                menuOpen={menu?.itemId === item.item_id}
                menuId={menuId}
                onOpen={(itemId) => { openAssetLibrary(itemId); }}
                onMenu={(itemId, element, focus) => { setMenu({ itemId, element, focus }); }}
                onCloseMenu={() => { setMenu(null); }}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            size="compact"
            illustration="drop"
            title={t("還沒有上傳參考素材")}
            description={
              <>
                <p>{t("把圖片、影片或聲音拖到這裡，或按「上傳」。")}</p>
                <p className="mt-2 text-caption text-fg-tertiary">
                  {t("要用在鏡頭：選取鏡頭 →「參考」分頁 →「從素材庫加入」（運算路由需支援參考素材，也就是 ref2va 元件組合）；圖片也可以在「生成」分頁當首幀（fl2va）。{value}", {
                    value: masks > 0 ? t(" 另有 {masks} 個 Image Studio 遮罩，只在 Image Studio 使用，這裡不列出。", { masks }) : "",
                  })}
                </p>
              </>
            }
          />
        )}
      </div>
      {dropping ? (
        <div aria-hidden className="material-popover pointer-events-none absolute inset-x-3 top-14 z-10 grid place-items-center rounded-lg py-3 text-caption text-fg animate-pop-in">
          {t("放開以上傳到參考素材庫")}
        </div>
      ) : null}
      {menu && menuItem ? (
        <ActionMenu
          id={menuId}
          label={t("「{title}」的動作", { title: menuItem.name })}
          anchor={{ kind: "element", element: menu.element }}
          returnFocus={menu.element}
          initialFocus={menu.focus}
          onClose={() => { setMenu(null); }}
          items={[
            { id: "open", label: t("在素材庫查看"), icon: ZoomIn, onSelect: () => { openAssetLibrary(menuItem.item_id); } },
            {
              id: "remove",
              label: t("從專案素材庫移除…"),
              icon: Trash2,
              tone: "danger",
              separatorBefore: true,
              onSelect: () => {
                const index = items.findIndex((item) => item.item_id === menuItem.item_id);
                setRemoving({ itemId: menuItem.item_id, focusAfter: (items[index + 1] ?? items[index - 1])?.item_id ?? null });
              },
            },
          ]}
        />
      ) : null}
      <LibraryRemoveDialog
        itemId={removing?.itemId ?? null}
        uses={(removing && uses.get(removing.itemId)) ?? NO_USES}
        onClose={() => { setRemoving(null); }}
        onRemoved={() => { focusLater(removing?.focusAfter ?? null); }}
      />
    </section>
  );
}
