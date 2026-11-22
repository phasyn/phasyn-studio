import { takeLabel } from "../model/takeLabel";
// The first frame of a shot (MiniMax H3 fl2va), shown in the 方式 popover of the generation row for 接續上一鏡 and
// 首幀圖片. Continuing: which frame of which previous shot it starts from (a browser preview) or why it cannot continue
// yet. Library image: the chosen image with 換一張, and the picker of library images (images only, no Image Studio masks;
// an image whose aspect ratio differs from the project's frame cannot be chosen, with the reason on it, because H3
// stretches the first frame to the frame). Also the first frame the active take actually used, and a note when that take
// was made from another first frame. The shot's continuity changes only through the 方式 choice
// (model/generationMode.ts); renderPlan.ts plans the run.
import { ArrowLeft, Images, Search, TriangleAlert } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { FileRef, StudioLibraryItem, StudioShot } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { CARD, OPTION_SELECTED, THUMB_ZOOM } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { useFramePreview } from "../hooks/useFramePreview";
import {
  CONTINUITY_MODE_CHANGED,
  continuityChange,
  continuityMode,
  continuitySource,
  firstFrameCandidates,
  firstFrameImageNote,
  firstFrameImageProblem,
  firstFrameItemId,
  imageFirstFrameSource,
  sourceFrameIndex,
  type ContinuitySource,
} from "../model/continuity";
import { H3_FPS } from "../model/frames";
import { activeTake } from "../model/project";
import { LibraryThumb } from "../references/ReferenceRow";
import { useStudio } from "../studioContext";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

const THUMB_WIDTH = 132;

function thumbHeight(width: number, height: number): number {
  return Math.max(1, Math.round((THUMB_WIDTH * height) / Math.max(1, width)));
}

function Note({ tone, children }: { tone: "warning" | "muted"; children: ReactNode }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-caption [overflow-wrap:anywhere]", tone === "warning" ? "text-warning" : "text-fg-tertiary")}>
      {tone === "warning" ? <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : null}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function SourcePreview({ source }: { source: ContinuitySource }) {
  const { asset, shot, take, frame } = source;
  const fps = asset.fps && asset.fps.den > 0 ? asset.fps.num / asset.fps.den : H3_FPS;
  const index = sourceFrameIndex(source);
  const preview = useFramePreview(mediaUrl(asset.file.node_id, asset.file.file_id), index, fps, THUMB_WIDTH);
  const height = thumbHeight(asset.width, asset.height);
  const name = shot.title || t("未命名鏡頭");
  return (
    <figure className={cn(CARD, "flex items-start gap-2 p-2")}>
      <div className="shrink-0 overflow-hidden rounded-md border border-line-subtle bg-stage" style={{ width: THUMB_WIDTH, height }}>
        {preview.status === "ready" ? (
          <img src={preview.src} alt={t("「{name}」第 {index} 影格的預覽", { name, index })} width={THUMB_WIDTH} height={height} className="block size-full object-contain animate-fade-in" />
        ) : (
          <span className="grid size-full place-items-center px-1 text-center text-caption text-fg-tertiary">{preview.status === "error" ? t("無法預覽") : t("載入預覽…")}</span>
        )}
      </div>
      <figcaption className="grid min-w-0 gap-0.5 text-caption text-fg-secondary">
        <span className="[overflow-wrap:anywhere]">{t("接續「{name}」", { name })}</span>
        <span className="machine text-fg-tertiary">{takeLabel(shot.takes.indexOf(take) + 1, take.seed)}</span>
        <span className="machine text-fg-tertiary">{frame.position === "index" ? t("第 {index} 影格（出點前一個影格）", { index }) : t("第 {index} 影格（最後一個影格）", { index })}</span>
        <span className="text-fg-tertiary">{t("瀏覽器預覽，可能差一個影格；渲染時從原檔取出原解析度的影格。")}</span>
      </figcaption>
    </figure>
  );
}

function UsedFrame({ file, label }: { file: FileRef; label: string }) {
  const meta = file.metadata;
  const width = typeof meta["width"] === "number" ? meta["width"] : null;
  const height = typeof meta["height"] === "number" ? meta["height"] : null;
  const index = typeof meta["frame_index"] === "number" ? meta["frame_index"] : null;
  const shownHeight = (width != null && Boolean(width)) && (height != null && Boolean(height)) ? thumbHeight(width, height) : Math.round((THUMB_WIDTH * 9) / 16);
  return (
    <figure className={cn(CARD, "flex items-start gap-2 p-2")}>
      <img
        src={mediaUrl(file.node_id, file.file_id)}
        alt={t("使用中 take 實際使用的首幀")}
        width={THUMB_WIDTH}
        height={shownHeight}
        loading="lazy"
        className="block shrink-0 rounded-md border border-line-subtle bg-stage object-contain"
        style={{ width: THUMB_WIDTH, height: shownHeight }}
      />
      <figcaption className="grid min-w-0 gap-0.5 text-caption text-fg-secondary">
        <span>{t("使用中 take 實際使用的首幀")}</span>
        <span className="machine text-fg-tertiary">
          {label}
          {index !== null ? t("・來源第 {index} 影格", { index }) : ""}
          {(width != null && Boolean(width)) && (height != null && Boolean(height)) ? t("・{width}×{height} PNG", { width, height }) : ""}
        </span>
      </figcaption>
    </figure>
  );
}

function itemSize(item: Pick<StudioLibraryItem, "width" | "height">): string {
  return item.width !== null && item.height !== null ? `${String(item.width)}×${String(item.height)}` : t("尺寸未知");
}

function itemOrigin(item: StudioLibraryItem): string {
  return item.source?.kind === "image_take" ? t("Image Studio 生成") : t("上傳");
}

/** The chosen first-frame image (or that it left the library) with 換一張. */
function ImageFrameCard({ item, onChange }: { item: StudioLibraryItem | null; onChange: () => void }) {
  const height = item?.width != null && item.height !== null ? thumbHeight(item.width, item.height) : Math.round((THUMB_WIDTH * 9) / 16);
  return (
    <figure className={cn(CARD, "flex items-start gap-2 p-2")}>
      <div className="grid shrink-0 place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage" style={{ width: THUMB_WIDTH, height }}>
        {item ? (
          <img src={mediaUrl(item.file.node_id, item.file.file_id)} alt={t("首幀圖片「{name}」", { name: item.name })} width={THUMB_WIDTH} height={height} loading="lazy" className="block size-full object-contain" />
        ) : (
          <span className="px-1 text-center text-caption text-fg-tertiary">{t("已不在素材庫")}</span>
        )}
      </div>
      <figcaption className="grid min-w-0 gap-1 text-caption text-fg-secondary">
        {item ? (
          <>
            <span className="[overflow-wrap:anywhere]">{item.name}</span>
            <span className="text-fg-tertiary">
              <T source={"<0>{item}</0>・{item2}"} values={{ item: itemSize(item), item2: itemOrigin(item) }} slots={[<span key="slot-0" className="machine" />]} />
            </span>
          </>
        ) : (
          <span className="text-fg-tertiary">{t("這張首幀圖片已從專案素材庫移除。")}</span>
        )}
        <Button size="sm" variant="secondary" icon={<Images aria-hidden />} onClick={onChange} className="justify-self-start">
          {item ? t("換一張") : t("重新選擇")}
        </Button>
      </figcaption>
    </figure>
  );
}

/** The library images to pick a first frame from: search by name; one that cannot be used stays focusable with its reason. */
export function FirstFrameImagePicker({ shot, onPick, onBack }: { shot: StudioShot; onPick: (item: StudioLibraryItem) => void; onBack: () => void }) {
  const { project } = useStudio();
  const [query, setQuery] = useState("");
  const items = firstFrameCandidates(project.library ?? []);
  const currentId = firstFrameItemId(shot);
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((item) => item.name.toLowerCase().includes(q)) : items;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    // Esc steps back to the 方式 list first; the popover closes on the next Esc
    event.preventDefault();
    event.stopPropagation();
    onBack();
  };
  return (
    <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */  className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/8 px-1.5">
        <Button size="icon-sm" variant="quiet" icon={<ArrowLeft aria-hidden />} aria-label={t("回到生成方式")} title={t("回到生成方式")} onClick={onBack} />
        <p className="text-data font-semibold text-fg">{t("選一張首幀圖片")}</p>
      </div>
      <div className="relative m-2 mb-1 shrink-0">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
        <Input compact data-autofocus="" type="search" value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder={t("搜尋檔名")} aria-label={t("搜尋素材庫圖片")} autoComplete="off" className="pl-8" />
      </div>
      {items.length === 0 ? (
        <p className="px-3 pt-1 pb-3 text-caption text-fg-tertiary">{t("專案素材庫沒有可用的圖片。")}</p>
      ) : shown.length === 0 ? (
        <p className="px-3 pt-1 pb-3 text-caption text-fg-tertiary">{t("沒有符合「{query}」的圖片。", { query: query.trim() })}</p>
      ) : (
        <ul className="grid min-h-0 gap-1 overflow-y-auto p-2 pt-1" aria-label={t("素材庫圖片（{shownCount}）", { shownCount: shown.length })}>
          {shown.map((item, index) => {
            const problem = firstFrameImageProblem(item, project.format);
            const note = firstFrameImageNote(item, project.format);
            const current = item.item_id === currentId;
            return (
              <li key={item.item_id} ref={reveal(index)}>
                <button
                  type="button"
                  aria-disabled={(problem != null && problem !== "") ? true : undefined}
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    if (!(problem != null && problem !== "")) onPick(item);
                  }}
                  title={problem ?? note ?? item.name}
                  className={cn(
                    "group/tile grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2 rounded-lg border p-1.5 text-left transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-focus",
                    current ? OPTION_SELECTED : "border-line-subtle bg-surface/60",
                    (problem != null && problem !== "") ? "cursor-not-allowed" : !current && "pressable hover:border-line-strong active:bg-sunken",
                  )}
                >
                  <span className={cn("grid size-14 place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage", ((problem != null && problem !== "") ? "opacity-60" : problem))}>
                    <LibraryThumb item={item} {...((problem != null && problem !== "") ? {} : { className: THUMB_ZOOM })} />
                  </span>
                  <span className="grid min-w-0 gap-0.5">
                    <span className={cn("truncate text-caption", (problem != null && problem !== "") ? "text-fg-tertiary" : "text-fg")}>{item.name}</span>
                    <span className="truncate text-[11px] text-fg-tertiary">
                      <T source={"<0>{item}</0>・{item2}{value}"} values={{ item: itemSize(item), item2: itemOrigin(item), value: current ? t("・目前的首幀") : "" }} slots={[<span key="slot-0" className="machine" />]} />
                    </span>
                    {(problem != null && problem !== "") ? (
                      <span className="text-[11px] text-warning">{t("比例與專案畫面（{width}×{height}）不同：會被拉伸變形，不能當首幀", { width: project.format.width, height: project.format.height })}</span>
                    ) : (note != null && note !== "") ? (
                      <span className="line-clamp-2 text-[11px] text-fg-tertiary">{note}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The first-frame detail of the current 方式 (接續上一鏡 or 首幀圖片); nothing for the other 方式. */
export function FirstFrameDetail({ shot, onChangeImage }: { shot: StudioShot; onChangeImage: () => void }) {
  const { project } = useStudio();
  const mode = continuityMode(shot);
  if (mode === "none") return null;
  const take = activeTake(shot);
  const change = take?.state === "succeeded" ? continuityChange(take, shot, project) : null;
  const used = take?.continuity ?? null;
  // A library image the active take already used is the card above; it is not shown twice
  const showUsed = used?.first_frame && !(mode === "image" && used.mode === "image" && change === null);
  const stale = change !== null && change !== CONTINUITY_MODE_CHANGED;
  return (
    <div className="grid gap-1.5">
      {mode === "previous_last" ? <PreviousFrame shot={shot} /> : <LibraryFrame shot={shot} onChange={onChangeImage} />}
      {stale ? (
        <Note tone="warning">{mode === "image" ? t("使用中的 take 用的是另一張首幀圖片；重新渲染這個鏡頭才會套用。") : t("使用中的 take 接的是舊的來源（已變更：{change}）；重新渲染這個鏡頭才會套用。", { change })}</Note>
      ) : null}
      {showUsed === true && used.first_frame ? <UsedFrame file={used.first_frame} label={used.mode === "image" ? t("素材庫圖片") : t("取自前一個鏡頭")} /> : null}
    </div>
  );
}

function PreviousFrame({ shot }: { shot: StudioShot }) {
  const { project } = useStudio();
  const { source, problem } = continuitySource(project, shot);
  return (
    <>
      {(problem != null && problem !== "") ? <Note tone="warning">{t("目前不能接續：{problem}", { problem })}</Note> : null}
      {source ? <SourcePreview source={source} /> : null}
      <Note tone="muted">{t("首幀只是條件、會被重新生成，接點接近但不逐像素相同；接點看起來重複時可把入點設為 1。")}</Note>
    </>
  );
}

function LibraryFrame({ shot, onChange }: { shot: StudioShot; onChange: () => void }) {
  const { project } = useStudio();
  const image = imageFirstFrameSource(project, shot);
  const itemId = firstFrameItemId(shot);
  const item = image.source?.item ?? (project.library ?? []).find((entry) => entry.item_id === itemId) ?? null;
  return (
    <>
      <ImageFrameCard item={item} onChange={onChange} />
      {(image.problem != null && image.problem !== "") ? <Note tone="warning">{t("目前不能用這張圖片：{problem}", { problem: image.problem })}</Note> : null}
      {(image.source?.note != null && image.source.note !== "") ? <Note tone="muted">{image.source.note}</Note> : null}
    </>
  );
}
