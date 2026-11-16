// 屬性「圖片」分頁（圖生圖）：參考圖片 1–4 張（上傳或從專案素材庫加入；上移／下移決定送出順序；選一張當底圖）、
// 參考圖編碼解析度、局部遮罩。文生圖時只說明並保留既有設定（切回圖生圖時使用）。
import { ArrowDown, ArrowUp, CircleX, FolderOpen, ImagePlus, Layers, Upload, X } from "lucide-react";
import { lazy, Suspense, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Select } from "@/components/ui/controls";
import { reveal, useFlipList } from "@/components/ui/motion";
import { HUD_CHIP, THUMB_ZOOM } from "@/components/ui/look";
import { LoadingPanels, SectionTitle, UploadTaskRow } from "@/features/studio-shell";
import { cn } from "@/lib/cn";
import { IMAGE_ACCEPT, useImageUploads } from "../hooks/useImageUploads";
import { useSetMode } from "../hooks/useShotMode";
import { useImageStudio } from "../imageStudioContext";
import { LIMITS, REFERENCE_RESOLUTIONS } from "../model/constants";
import { MASK_NOTE } from "../model/project";
import { addReference, moveReference, orderedReferences, referenceProblems, removeReference, setBaseReference } from "../model/references";
import { imageShots } from "../model/shots";
import type { ImageLibraryItem, StudioImageShot } from "../types";
import { Row } from "./fields";
import { ImageThumb } from "./ImageThumb";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { LazyBoundary } from "@/components/common/LazyBoundary";

// The mask painter (canvas tools) loads when an image-to-image shot first shows it
const MaskPainter = lazy(() => import("./MaskPainter").then((m) => ({ default: m.MaskPainter })));

function sourceLabel(item: ImageLibraryItem): string {
  if (item.note === MASK_NOTE) return t("遮罩");
  if (item.source?.kind === "image_take") return t("Image Studio 生成");
  return t("上傳");
}

function LibraryPicker({ id, shot, onClose }: { id: string; shot: StudioImageShot; onClose: () => void }) {
  const { project, dispatch } = useImageStudio();
  const [search, setSearch] = useState("");
  const used = new Set(shot.references.map((ref) => ref.item_id));
  const q = search.trim().toLowerCase();
  const items = (project.library ?? [])
    .filter((item) => item.kind === "image" && (q.length === 0 || item.name.toLowerCase().includes(q)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const full = orderedReferences(shot.references).length >= LIMITS.references;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <div id={id} role="region" aria-label={t("從專案素材庫加入參考圖片")} onKeyDown={onKeyDown} className="grid min-w-0 gap-2 rounded-lg border border-line-subtle bg-canvas p-2 animate-rise-in">
      <Input compact autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜尋檔名")} aria-label={t("搜尋素材庫檔名")} />
      {items.length === 0 ? (
        <p className="px-1 text-caption text-fg-tertiary">{(project.library ?? []).some((item) => item.kind === "image") ? t("沒有符合的圖片。") : t("專案素材庫還沒有圖片；先上傳，或把生成的圖片「加入素材庫」。")}</p>
      ) : (
        <ul className="grid max-h-64 min-w-0 gap-0.5 overflow-y-auto" aria-label={t("素材庫圖片（{itemsCount}）", { itemsCount: items.length })}>
          {items.map((item) => {
            const added = used.has(item.item_id);
            const blocked = added ? null : full ? t("參考圖片最多 {references} 張", { references: LIMITS.references }) : null;
            return (
              <li key={item.item_id} className="group group/tile grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1.5 py-1 hover:bg-raised/60">
                <ImageThumb file={item.file} className="size-10 rounded-md" imgClassName={THUMB_ZOOM} />
                <span className="grid min-w-0">
                  <span className="truncate text-data text-fg" title={item.name}>
                    {item.name}
                  </span>
                  <span className="truncate text-caption text-fg-tertiary">{`${sourceLabel(item)}${item.width !== null && item.height !== null ? t("・{width}×{height}", { width: item.width, height: item.height }) : t("・尺寸未知")}${blocked ? t("・{blocked}", { blocked }) : ""}`}</span>
                </span>
                {added ? (
                  <span className="text-caption text-fg-tertiary">{t("已加入")}</span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-h-7 px-2"
                    disabled={blocked !== null}
                    aria-label={t("加入「{name}」", { name: item.name })}
                    onClick={() => dispatch({ type: "addImageReference", shotId: shot.image_shot_id, itemId: item.item_id })}
                  >
                    {t("加入")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function References({ shot, disabled }: { shot: StudioImageShot; disabled: boolean }) {
  const { project, dispatch, getProject } = useImageStudio();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const uploads = useImageUploads(project.project_id);
  const listRef = useRef<HTMLOListElement>(null);
  const library = project.library ?? [];
  const items = new Map(library.map((item) => [item.item_id, item]));
  const ordered = orderedReferences(shot.references);
  const full = ordered.length >= LIMITS.references;
  const problems = referenceProblems(shot, library);
  const shotId = shot.image_shot_id;
  const orderKey = ordered.map((ref) => ref.item_id).join("|");
  // 上移／下移後，其他參考圖從舊位置滑到新位置（共用 FLIP）
  useFlipList(listRef, orderKey);
  // After a move, focus stays on the moved image: its button for the same direction while it can still move that way,
  // otherwise the other one. Without this, focus falls to the page: the pressed button may have just become disabled
  // (first or last row), or React may have moved its row in the DOM.
  const moved = useRef<{ itemId: string; delta: -1 | 1 } | null>(null);
  useLayoutEffect(() => {
    const target = moved.current;
    moved.current = null;
    if (!target) return;
    const row = Array.from(listRef.current?.children ?? []).find((child) => child instanceof HTMLElement && child.dataset.itemId === target.itemId);
    const moveButton = (delta: -1 | 1) => row?.querySelector<HTMLButtonElement>(`button[data-move="${delta}"]`);
    const same = moveButton(target.delta);
    (same && !same.disabled ? same : moveButton(target.delta === -1 ? 1 : -1))?.focus();
  }, [orderKey]);
  const patch = (next: Pick<StudioImageShot, "references" | "base_index"> | null) => {
    if (next) dispatch({ type: "updateImageShot", shotId, patch: next });
  };
  const move = (itemId: string, delta: -1 | 1) => {
    const next = moveReference(shot, itemId, delta);
    if (!next) return;
    moved.current = { itemId, delta };
    patch(next);
  };
  const upload = (files: readonly File[]) => {
    if (files.length === 0) return;
    uploads.addFiles(files, (item) => {
      dispatch({ type: "addLibraryItems", items: [item] });
      // 上傳完成時以最新的參考清單判斷（上傳期間可能已加了別張）；圖片已被刪除時只加進素材庫
      const latest = imageShots(getProject()).find((entry) => entry.image_shot_id === shotId);
      if (!latest) return t("已加入專案素材庫（圖片已刪除，沒有加成參考）");
      const result = addReference(latest, item.item_id);
      dispatch({ type: "addImageReference", shotId, itemId: item.item_id });
      return result.patch ? t("已加入素材庫與「{value}」的參考圖片", { value: latest.title || t("這張圖片") }) : t("已加入素材庫，但沒有加成參考圖片：{problem}", { problem: result.problem });
    });
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    upload(Array.from(event.dataTransfer.files));
  };
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        "relative grid min-w-0 gap-2 rounded-lg transition-[outline-color,background-color] duration-(--duration-fast)",
        dragging && "bg-brand-gradient-soft outline-2 outline-offset-4 outline-brand-cyan outline-dashed",
      )}
      onDragOver={(event) => {
        if (disabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {dragging ? (
        <span aria-hidden className="pointer-events-none absolute inset-0 z-[3] grid place-items-center rounded-lg animate-fade-in">
          <span className={cn(HUD_CHIP, "inline-flex items-center gap-1.5 border-brand-cyan/50 px-3 py-1 text-data shadow-glow-sm")}>
            <Upload className="size-4 text-brand-cyan" />
            {t("放開以上傳參考圖片")}
          </span>
        </span>
      ) : null}
      <div className="flex items-center gap-2">
        <h3 id={`${id}-title`} className="flex items-center gap-1.5 text-data font-semibold text-fg-secondary">
          <Layers aria-hidden className="size-3.5 text-fg-tertiary" />
          {t("參考圖片")}
        </h3>
        <span className={cn("machine ml-auto rounded-full px-1.5 text-caption", full ? "bg-warning/12 text-warning" : "bg-overlay text-fg-tertiary")}>{`${ordered.length}/${LIMITS.references}`}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          className="min-h-7 px-2"
          icon={<Upload aria-hidden />}
          disabled={disabled || full}
          title={full ? t("參考圖片最多 {references} 張", { references: LIMITS.references }) : t("也可以把圖片拖進這裡")}
          onClick={() => fileInput.current?.click()}
        >
          {t("上傳圖片")}
        </Button>
        <Button
          ref={pickerButton}
          size="sm"
          variant={pickerOpen ? "secondary" : "quiet"}
          className="min-h-7 px-2"
          icon={<FolderOpen aria-hidden />}
          disabled={disabled}
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? `${id}-picker` : undefined}
          onClick={() => setPickerOpen((open) => !open)}
        >
          <T source={"從素材庫加入<0>{filterCount}</0>"} values={{ filterCount: library.filter((item) => item.kind === "image").length }} slots={[<span className="machine rounded-full bg-overlay px-1.5 text-caption text-fg-tertiary" />]} />
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
      {uploads.tasks.length > 0 ? (
        <ul className="grid gap-0.5 rounded-lg border border-line-subtle bg-canvas p-1" aria-label={t("上傳")} aria-live="polite">
          {uploads.tasks.map((task) => (
            <UploadTaskRow key={task.key} task={task} icon={<ImagePlus aria-hidden className="mt-0.5 size-3.5 text-entity" />} onRetry={() => uploads.retry(task.key)} onDismiss={() => uploads.dismiss(task.key)} />
          ))}
        </ul>
      ) : null}
      {pickerOpen ? (
        <LibraryPicker
          id={`${id}-picker`}
          shot={shot}
          onClose={() => {
            setPickerOpen(false);
            pickerButton.current?.focus();
          }}
        />
      ) : null}
      {ordered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong bg-canvas/60">
          <EmptyState
            illustration="drop"
            size="compact"
            title={t("把參考圖片拖進這裡")}
            description={t("圖生圖至少需要一張參考圖片（也可以按上方的「上傳圖片」或「從素材庫加入」）。送出順序就是這裡的順序；第一張預設是遮罩合成的底圖。")}
          />
        </div>
      ) : (
        <ol ref={listRef} className="grid gap-1.5" aria-label={t("參考圖片的送出順序（{orderedCount}）", { orderedCount: ordered.length })}>
          {ordered.map((ref, index) => {
            const item = items.get(ref.item_id);
            const base = shot.base_index === index;
            const name = item?.name ?? t("（已不在素材庫）");
            return (
              <li
                key={ref.item_id}
                data-item-id={ref.item_id}
                ref={reveal(index)}
                className={cn("group group/tile grid min-w-0 grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border bg-canvas p-1.5", base ? "border-brand-blue/55" : "border-line-subtle")}
              >
                <ImageThumb file={item?.file} alt={t("參考圖片 {index}", { index: index + 1 })} className="size-12 rounded-md" imgClassName={THUMB_ZOOM} />
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-data text-fg">
                    <span className="machine shrink-0 text-caption text-fg-tertiary">{String(index + 1).padStart(2, "0")}</span>
                    {base ? <span className="shrink-0 rounded-full border border-brand-blue/40 bg-brand-gradient-soft px-1.5 text-caption text-fg">{t("底圖")}</span> : null}
                    <span className={cn("truncate", item ? "" : "text-danger")} title={name}>
                      {name}
                    </span>
                  </span>
                  <span className="truncate text-caption text-fg-tertiary">{item ? `${sourceLabel(item)}${item.width !== null && item.height !== null ? t("・{width}×{height}", { width: item.width, height: item.height }) : ""}` : t("這張圖已從素材庫移除")}</span>
                </span>
                <span className="flex items-center gap-0.5">
                  <Button size="icon-sm" variant="quiet" className="size-7" data-move={-1} aria-label={t("把參考圖片 {index} 上移", { index: index + 1 })} title={t("上移")} disabled={disabled || index === 0} onClick={() => move(ref.item_id, -1)}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button size="icon-sm" variant="quiet" className="size-7" data-move={1} aria-label={t("把參考圖片 {index} 下移", { index: index + 1 })} title={t("下移")} disabled={disabled || index === ordered.length - 1} onClick={() => move(ref.item_id, 1)}>
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    size="sm"
                    variant={base ? "secondary" : "quiet"}
                    className="min-h-7 px-1.5"
                    aria-pressed={base}
                    aria-label={t("把參考圖片 {index} 設為底圖", { index: index + 1 })}
                    disabled={disabled}
                    title={t("遮罩合成時保留這張的畫面")}
                    onClick={() => patch(setBaseReference(shot, base ? null : ref.item_id))}
                  >
                    {t("底圖")}
                  </Button>
                  <Button size="icon-sm" variant="quiet" className="size-7" aria-label={t("移除參考圖片 {index}", { index: index + 1 })} title={t("移除（素材庫的檔案保留）")} disabled={disabled} onClick={() => patch(removeReference(shot, ref.item_id))}>
                    <X aria-hidden />
                  </Button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {problems.length > 0 ? (
        <ul className="grid gap-1" aria-label={t("會擋下生成的問題")}>
          {problems.map((problem) => (
            <li key={problem} className="flex items-start gap-1.5 text-caption text-danger">
              <CircleX aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {problem}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ImageTab({ shot }: { shot: StudioImageShot }) {
  const { dispatch } = useImageStudio();
  const id = useId();
  const setMode = useSetMode(shot);
  if (shot.mode !== "i2i") {
    return (
      <div className="grid gap-3 p-3">
        <Callout tone="info" title={t("文生圖不使用參考圖片與遮罩")}>
          <p>{shot.references.length > 0 || shot.mask_item_id ? t("這張圖片已有的參考圖片與遮罩會保留，切回圖生圖時使用；文生圖不會送出它們。") : t("要從參考圖修改或局部重繪，改成圖生圖。")}</p>
          <div className="pt-1">
            <Button size="sm" variant="secondary" icon={<ImagePlus aria-hidden />} onClick={() => setMode("i2i")}>
              {t("改成圖生圖")}
            </Button>
          </div>
        </Callout>
      </div>
    );
  }
  return (
    <div className="grid gap-4 p-3">
      <References shot={shot} disabled={false} />
      <Row label={t("參考圖編碼解析度")} htmlFor={`${id}-resolution`} info={t("每張參考圖縮放到約這個邊長平方的面積（邊長 32 的倍數），文字條件與參考編碼用同一份；越高細節越多，也越耗時與記憶體。")}>
        <Select id={`${id}-resolution`} compact value={shot.reference_resolution} onChange={(event) => dispatch({ type: "updateImageShot", shotId: shot.image_shot_id, patch: { reference_resolution: Number(event.target.value) } })}>
          {REFERENCE_RESOLUTIONS.map((size) => (
            <option key={size} value={size}>
              {size} px
            </option>
          ))}
          {(REFERENCE_RESOLUTIONS as readonly number[]).includes(shot.reference_resolution) ? null : <option value={shot.reference_resolution}>{t("{reference_resolution} px（目前的值）", { reference_resolution: shot.reference_resolution })}</option>}
        </Select>
      </Row>
      <div className="grid gap-2">
        <SectionTitle icon={Layers}>{t("局部遮罩（選用）")}</SectionTitle>
        <LazyBoundary>
          <Suspense fallback={<LoadingPanels label={t("載入遮罩工具…")} panels={1} className="p-0" />}>
            <MaskPainter key={shot.image_shot_id} shot={shot} disabled={false} />
          </Suspense>
        </LazyBoundary>
      </div>
    </div>
  );
}
