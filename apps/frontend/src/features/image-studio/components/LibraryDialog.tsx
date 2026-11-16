// 專案素材庫（工具列左側的「素材庫」，與 Video Studio 共用同一份素材）：這個專案的圖片——上傳的、Image Studio 加入的白底版。
// 左＝搜尋、依來源篩選與縮圖格（方向鍵在格子間移動、Home／End 到頭尾）；右＝選取那張的大圖、尺寸、大小、來源、加入時間、
// 有沒有被使用與備註，以及下載。可以上傳圖片（按鈕或把檔案拖進對話框；只加進素材庫，不加到任何圖片）。遮罩只在各圖片的
// 「圖片」分頁使用，不列在這裡；改名與移除在 Video Studio 的素材庫。篩選、選取與上傳由工具列保管：關閉再打開時都還在，
// 上傳在對話框關閉後仍繼續（換專案或離開頁面才中止）。
import { Download, Library, Search, Upload } from "lucide-react";
import { useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CHOICE_BASE, CHOICE_IDLE, CHOICE_SELECTED, THUMB_ZOOM } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { buttonVariants } from "@/components/ui/variants";
import { UploadTaskRow } from "@/features/studio-shell";
import { cn } from "@/lib/cn";
import { formatBytes, formatTimestamp } from "@/lib/format";
import { IMAGE_ACCEPT, useImageUploads } from "../hooks/useImageUploads";
import { useImageStudio } from "../imageStudioContext";
import { libraryItemInUse, MASK_NOTE } from "../model/project";
import type { ImageLibraryItem, ImageStudioProject } from "../types";
import { fileUrl, gridColumns, gridStep } from "./display";
import { Segmented } from "./fields";
import { ImageThumb } from "./ImageThumb";
import { t } from "@/i18n";

type SourceFilter = "all" | "upload" | "generated";

const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

/** 素材庫裡的圖片（不含遮罩），最新的在前。 */
function libraryImages(project: Pick<ImageStudioProject, "library">): ImageLibraryItem[] {
  return (project.library ?? []).filter((item) => item.kind === "image" && item.note !== MASK_NOTE).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

const generated = (item: ImageLibraryItem) => item.source?.kind === "image_take";

function sourceLabel(item: ImageLibraryItem): string {
  return generated(item) ? t("Image Studio 生成") : t("上傳");
}

/** 下載的檔名：素材名稱，沒有副檔名時依檔案類型補上。 */
function downloadName(item: ImageLibraryItem): string {
  const extension = EXTENSIONS[item.file.media_type] ?? "";
  return extension && !item.name.toLowerCase().endsWith(extension) ? `${item.name}${extension}` : item.name;
}

function Details({ item, inUse }: { item: ImageLibraryItem; inUse: boolean }) {
  const url = fileUrl(item.file);
  return (
    <div className="grid content-start gap-4 animate-fade-in">
      <ImageThumb file={item.file} fit="contain" alt={item.name} className="aspect-square w-full rounded-xl" />
      <div className="grid gap-2">
        <h3 className="text-section font-semibold [overflow-wrap:anywhere] text-fg">{item.name}</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-data">
          <dt className="text-fg-tertiary">{t("尺寸")}</dt>
          <dd className="machine text-fg">{item.width !== null && item.height !== null ? `${item.width}×${item.height}` : t("尺寸未知")}</dd>
          <dt className="text-fg-tertiary">{t("大小")}</dt>
          <dd className="machine text-fg-secondary">{formatBytes(item.file.size_bytes)}</dd>
          <dt className="text-fg-tertiary">{t("來源")}</dt>
          <dd className="text-fg-secondary">{sourceLabel(item)}</dd>
          <dt className="text-fg-tertiary">{t("加入時間")}</dt>
          <dd className="machine text-fg-secondary">{formatTimestamp(item.created_at)}</dd>
          <dt className="text-fg-tertiary">{t("使用狀態")}</dt>
          <dd className={inUse ? "text-fg" : "text-fg-secondary"}>{inUse ? t("使用中") : t("沒有使用")}</dd>
        </dl>
        {item.note ? <p className="text-caption text-fg-secondary [overflow-wrap:anywhere]">{item.note}</p> : null}
      </div>
      {url ? (
        <a href={url} download={downloadName(item)} className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "justify-self-start no-underline")}>
          <Download aria-hidden />
          {t("下載")}
        </a>
      ) : null}
    </div>
  );
}

function Tile({ item, index, selected, focusable, onSelect, onKeyDown }: { item: ImageLibraryItem; index: number; selected: boolean; focusable: boolean; onSelect: () => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void }) {
  return (
    <li ref={reveal(index)} className="min-w-0">
      <button
        type="button"
        data-library-tile={item.item_id}
        tabIndex={focusable ? 0 : -1}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className={cn("group/tile grid w-full min-w-0 gap-1.5 rounded-xl p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus", CHOICE_BASE, selected ? CHOICE_SELECTED : CHOICE_IDLE)}
      >
        <ImageThumb file={item.file} alt="" className="aspect-square w-full rounded-lg" imgClassName={THUMB_ZOOM} />
        <span className="grid min-w-0 gap-0.5 px-0.5">
          <span className="truncate text-data text-fg" title={item.name}>
            {item.name}
          </span>
          <span className="machine truncate text-caption text-fg-tertiary">{item.width !== null && item.height !== null ? `${item.width}×${item.height}` : t("尺寸未知")}</span>
        </span>
      </button>
    </li>
  );
}

export function ImageLibrary() {
  const { project, dispatch } = useImageStudio();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploads = useImageUploads(project.project_id);
  const all = libraryImages(project);
  const needle = query.trim().toLowerCase();
  const items = all.filter((item) => (source === "all" || (source === "generated") === generated(item)) && (!needle || item.name.toLowerCase().includes(needle)));
  const selected = items.find((item) => item.item_id === selectedId) ?? items[0] ?? null;
  const focusIndex = Math.max(0, items.findIndex((item) => item.item_id === selected?.item_id));

  const upload = (files: readonly File[]) => {
    if (files.length === 0) return;
    uploads.addFiles(files, (item) => {
      dispatch({ type: "addLibraryItems", items: [item] });
      return null;
    });
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    upload(Array.from(event.dataTransfer.files));
  };
  const onTileKey = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = gridStep(event.key, index, gridColumns(listRef.current), items.length);
    const target = next === undefined ? undefined : items[next];
    if (!target) return;
    event.preventDefault();
    setSelectedId(target.item_id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-library-tile="${target.item_id}"]`)?.focus());
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" icon={<Library aria-hidden />} title={t("開啟專案素材庫：{count} 張圖片", { count: all.length })} className="h-10 min-w-0 shrink-0 rounded-full px-4 text-body [&_svg]:size-4.5 [&_svg]:text-brand-cyan">
          <span className="truncate">{t("素材庫")}</span>
          <span className="machine inline-flex min-w-6 items-center justify-center rounded-full bg-overlay px-1.5 text-caption leading-5 font-semibold text-fg-secondary">{all.length}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="h-[min(48rem,90vh)] max-w-[min(72rem,96vw)]">
        <DialogHeader>
          <div className="flex flex-wrap items-start gap-3">
            <div className="grid min-w-0 flex-1 gap-1">
              <DialogTitle>{t("素材庫")}</DialogTitle>
              <DialogDescription>{t("這個專案的圖片素材，與 Video Studio 共用。改名與移除在 Video Studio 的素材庫。")}</DialogDescription>
            </div>
            <Button size="sm" variant="secondary" icon={<Upload aria-hidden />} onClick={() => fileInput.current?.click()}>
              {t("上傳圖片")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept={IMAGE_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                upload(files);
              }}
            />
          </div>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section
            aria-label={t("素材")}
            className={cn("flex min-h-0 min-w-0 flex-col border-line-subtle transition-[background-color] duration-(--duration-fast) lg:border-r", dragging && "bg-brand-gradient-soft")}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={onDrop}
          >
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 py-3">
              <label className="relative min-w-48 flex-1">
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
                <Input compact type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜尋檔名")} aria-label={t("搜尋素材庫檔名")} className="pl-8" />
              </label>
              <Segmented
                name={`${id}-source`}
                label={t("來源")}
                value={source}
                onChange={setSource}
                options={[
                  { value: "all", label: t("全部") },
                  { value: "upload", label: t("上傳") },
                  { value: "generated", label: t("Image Studio 生成") },
                ]}
              />
              <span className="machine shrink-0 text-caption text-fg-tertiary">{t("{count} 張", { count: items.length })}</span>
            </div>
            {uploads.tasks.length > 0 ? (
              <ul className="mx-6 mb-2 grid shrink-0 gap-0.5 rounded-lg border border-line-subtle bg-canvas p-1" aria-label={t("上傳")} aria-live="polite">
                {uploads.tasks.map((task) => (
                  <UploadTaskRow key={task.key} task={task} icon={<Upload aria-hidden className="mt-0.5 size-3.5 text-entity" />} onRetry={() => uploads.retry(task.key)} onDismiss={() => uploads.dismiss(task.key)} />
                ))}
              </ul>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
              {items.length === 0 ? (
                <EmptyState
                  illustration="drop"
                  size="compact"
                  title={all.length === 0 ? t("素材庫還沒有圖片") : t("沒有符合的圖片。")}
                  description={all.length === 0 ? t("按「上傳圖片」或把圖片拖進這裡；生成的圖片也可以從 take 的選單加入素材庫。") : undefined}
                />
              ) : (
                <ul ref={listRef} aria-label={t("素材庫圖片（{itemsCount}）", { itemsCount: items.length })} className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5">
                  {items.map((item, index) => (
                    <Tile key={item.item_id} item={item} index={index} selected={item.item_id === selected?.item_id} focusable={index === focusIndex} onSelect={() => setSelectedId(item.item_id)} onKeyDown={onTileKey(index)} />
                  ))}
                </ul>
              )}
            </div>
          </section>
          <aside aria-label={t("素材資訊")} className="hidden min-h-0 overflow-y-auto px-5 py-4 lg:block">
            {selected ? <Details key={selected.item_id} item={selected} inUse={libraryItemInUse(project, selected.item_id)} /> : null}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
