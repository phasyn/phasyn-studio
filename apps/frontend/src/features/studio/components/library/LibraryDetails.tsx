// 素材庫右側的詳細資料：大預覽、名稱（就地改名，F2）、媒體資訊、使用處（可以跳到使用它的鏡頭）、備註、下載與移除。
// 選了幾個素材時改成選取摘要（總大小、使用中數量、移除沒有使用的）。
// 名稱與備註都寫回專案文件（setLibrary）：名稱在素材庫內不分大小寫唯一；一鍵換角來源影片的備註帶著換角工作的設定，
// 不能在這裡編輯；Image Studio 遮罩的固定備註也不能拿來當一般備註（否則素材會被當成遮罩藏起來）。
import { useLayoutEffect } from "react";
import { AssetAudio } from "@/components/common/AssetMedia";
import { AtSign, ChevronDown, Download, ExternalLink, Film, Images, Link2, Maximize2, MousePointerClick, Pencil, Replace, SquareDashed, Trash2, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { imageStudioPath } from "@/app/paths";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/controls";
import { motionTransition } from "@/components/ui/motion";
import { buttonVariants } from "@/components/ui/variants";
import { formatList, joinInline } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { formatBytesExact, formatTimestamp } from "@/lib/format";
import { LIBRARY_NOTE_MAX, libraryRenameProblem, libraryUseCount, libraryUseKey, withLibraryItemPatch, type LibraryUse } from "../../model/library";
import { KindIcon } from "../../references/KindIcon";
import { IMAGE_MASK_NOTE, KIND_LABEL } from "../../references/materials";
import { LibraryThumb } from "../../references/ReferenceRow";
import { useStudio } from "../../studioContext";
import { LibraryFixButton } from "../../fix";
import { itemAudioTrack, itemDimensions, itemDuration, itemSize, itemSource, totalSize } from "./display";
import { t } from "@/i18n";

const USE_ICON: Record<LibraryUse["kind"], LucideIcon> = {
  reference: AtSign,
  first_frame: Link2,
  previs: Film,
  image_reference: Images,
  image_mask: SquareDashed,
  swap_source: Replace,
  timeline: Film,
};

function describeUse(use: LibraryUse): string {
  switch (use.kind) {
    case "reference":
      return t("參考 {aliases}", { aliases: formatList(use.aliases) });
    case "previs":
      return t("構圖預演");
    case "first_frame":
      return t("首幀");
    case "image_reference":
      return t("參考圖片");
    case "image_mask":
      return t("遮罩");
    case "swap_source":
      return t("來源影片");
    case "timeline":
      return t("時間軸上 {count} 個片段", { count: use.clips });
  }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-tertiary">{label}</dt>
      <dd className="min-w-0 truncate text-fg-secondary">{children}</dd>
    </>
  );
}

/** 大預覽：圖片完整顯示，影片與聲音有播放控制。 */
function LargePreview({ item, onExpand }: { item: StudioLibraryItem; onExpand: () => void }) {
  const url = mediaUrl(item.file.node_id, item.file.file_id);
  return (
    <div className="group/tile relative grid aspect-video w-full place-items-center overflow-hidden rounded-xl border border-line-subtle bg-stage">
      {item.kind === "image" ? (
        <img src={url} alt="" draggable={false} className="size-full object-contain" />
      ) : item.kind === "video" ? (
        <video key={url} src={url} controls muted playsInline preload="metadata" className="size-full object-contain" />
      ) : (
        <div className="grid w-full justify-items-center gap-3 px-4">
          <KindIcon kind="audio" className="size-8" />
          <AssetAudio key={url} src={url} controls preload="metadata" className="w-full" />
        </div>
      )}
      <button
        type="button"
        onClick={onExpand}
        aria-label={t("放大預覽")}
        title={t("放大預覽（Enter）")}
        className="pressable material-hud absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-full border border-white/10 text-fg opacity-0 transition-opacity duration-(--duration-fast) group-hover/tile:opacity-100 focus-visible:opacity-100 [&_svg]:size-3.5"
      >
        <Maximize2 aria-hidden />
      </button>
    </div>
  );
}

function NameField({ item, renaming, onRenaming, inputRef }: { item: StudioLibraryItem; renaming: boolean; onRenaming: (on: boolean) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  const { project, dispatch } = useStudio();
  const [draft, setDraft] = useState(item.name);
  const library = project.library ?? [];
  const problem = renaming ? libraryRenameProblem(library, item.item_id, draft) : null;
  const errorId = useId();
  useLayoutEffect(() => { if (renaming) inputRef.current?.focus({ preventScroll: true }); }, [inputRef, renaming]);
  const commit = () => {
    if (problem != null && problem !== "") return;
    if (draft.trim() !== item.name) dispatch({ type: "setLibrary", library: withLibraryItemPatch(library, item.item_id, { name: draft }) });
    onRenaming(false);
  };
  if (!renaming) {
    return (
      <div className="flex min-w-0 items-start gap-1">
        <h3 className="min-w-0 flex-1 text-data font-semibold break-words text-fg">{item.name}</h3>
        <Button
          size="icon-sm"
          variant="quiet"
          className="size-7 shrink-0 [&_svg]:size-3.5"
          aria-label={t("改名")}
          title={t("改名（F2）")}
          aria-keyshortcuts="F2"
          onClick={() => {
            setDraft(item.name);
            onRenaming(true);
          }}
          icon={<Pencil aria-hidden />}
        />
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      <Input
        ref={inputRef}
        compact
        data-library-local-escape=""
        value={draft}
        maxLength={240}
        aria-label={t("素材名稱")}
        aria-invalid={(problem != null && problem !== "") ? true : undefined}
        aria-describedby={(problem != null && problem !== "") ? errorId : undefined}
        onChange={(event) => { setDraft(event.target.value); }}
        onFocus={(event) => { event.currentTarget.select(); }}
        onBlur={() => {
          if (problem != null && problem !== "") onRenaming(false);
          else commit();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onRenaming(false);
          }
        }}
      />
      <p id={errorId} className={cn("text-caption", (problem != null && problem !== "") ? "text-danger" : "text-fg-tertiary")}>
        {problem ?? t("Enter 儲存、Esc 取消")}
      </p>
    </div>
  );
}

function NoteField({ item, locked }: { item: StudioLibraryItem; locked: string | null }) {
  const { project, dispatch } = useStudio();
  const saved = item.note ?? "";
  const [draft, setDraft] = useState(saved);
  const id = useId();
  const problem = draft.length > LIBRARY_NOTE_MAX ? t("備註最多 {max} 個字元", { max: LIBRARY_NOTE_MAX }) : draft === IMAGE_MASK_NOTE ? t("這段文字是 Image Studio 遮罩的標記，不能當備註") : null;
  const dirty = draft !== saved;
  const save = () => {
    if (!dirty || (problem != null && problem !== "") || (locked != null && locked !== "")) return;
    dispatch({ type: "setLibrary", library: withLibraryItemPatch(project.library ?? [], item.item_id, { note: draft }) });
  };
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="flex items-center justify-between text-caption font-medium text-fg-secondary">
        {t("備註")}
        <span className={cn("machine text-[11px] font-normal", (problem != null && problem !== "") ? "text-danger" : "text-fg-tertiary")}>
          {draft.length}/{LIBRARY_NOTE_MAX}
        </span>
      </label>
      {(locked != null && locked !== "") ? (
        <p className="rounded-md border border-line-subtle bg-sunken/60 px-2.5 py-2 text-caption text-fg-tertiary">{locked}</p>
      ) : (
        <>
          <Textarea
            id={id}
            compact
            data-library-local-escape=""
            value={draft}
            placeholder={t("寫下這個素材的用途、角色或注意事項")}
            aria-invalid={(problem != null && problem !== "") ? true : undefined}
            onChange={(event) => { setDraft(event.target.value); }}
            onBlur={save}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft(saved);
              }
            }}
            className="min-h-20"
          />
          <p className={cn("text-caption", (problem != null && problem !== "") ? "text-danger" : "text-fg-tertiary")}>{problem ?? (dirty ? t("離開欄位或 Ctrl／⌘＋Enter 儲存，Esc 還原") : t("已儲存在專案"))}</p>
        </>
      )}
    </div>
  );
}

function UsesSection({ uses, projectId, onJumpToShot }: { uses: readonly LibraryUse[]; projectId: string; onJumpToShot: (shotId: string) => void }) {
  const [open, setOpen] = useState(true);
  const count = libraryUseCount(uses);
  const listId = useId();
  if (uses.length === 0) return <p className="text-caption text-fg-tertiary">{t("還沒有鏡頭使用")}</p>;
  return (
    <div className="grid gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => { setOpen(!open); }}
        className="pressable flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-caption font-medium text-brand-cyan hover:bg-raised"
      >
        <Link2 aria-hidden className="size-3.5" />
        {t("{count} 處使用", { count })}
        <ChevronDown aria-hidden className={cn("ml-auto size-3.5 transition-transform duration-(--duration-fast)", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            id={listId}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={motionTransition("base", "standard")}
            className="grid overflow-hidden rounded-lg border border-line-subtle bg-canvas/60"
          >
            {uses.map((use) => {
              const Icon = USE_ICON[use.kind];
              return (
                <li key={libraryUseKey(use)} className="flex min-w-0 items-center gap-2 border-b border-line-subtle/60 px-2 py-1.5 last:border-b-0">
                  <Icon aria-hidden className="size-3.5 shrink-0 text-fg-tertiary" />
                  <span className="grid min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-1.5 text-caption text-fg">
                      {use.kind === "reference" || use.kind === "first_frame" || use.kind === "previs" ? (
                        <>
                          <span className="machine shrink-0 text-fg-tertiary">{String(use.index + 1).padStart(2, "0")}</span>
                          <span className="truncate">{use.title}</span>
                        </>
                      ) : use.kind === "swap_source" ? (
                        t("一鍵換角")
                      ) : use.kind === "timeline" ? (
                        t("時間軸")
                      ) : (
                        <span className="truncate">{use.title ? joinInline(["Image Studio", use.title]) : "Image Studio"}</span>
                      )}
                    </span>
                    <span className="truncate text-[11px] leading-4 text-fg-tertiary">{describeUse(use)}</span>
                  </span>
                  {use.kind === "reference" || use.kind === "first_frame" || use.kind === "previs" ? (
                    <Button size="sm" variant="quiet" className="min-h-7 shrink-0 px-2" icon={<MousePointerClick aria-hidden />} onClick={() => { onJumpToShot(use.shotId); }}>
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
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export interface DetailsProps {
  item: StudioLibraryItem | null;
  selected: readonly StudioLibraryItem[];
  uses: ReadonlyMap<string, readonly LibraryUse[]>;
  swapSourceId: string | null;
  renaming: boolean;
  onRenaming: (on: boolean) => void;
  renameRef: RefObject<HTMLInputElement | null>;
  onExpand: (itemId: string) => void;
  onRemove: () => void;
  onJumpToShot: (shotId: string) => void;
  onClearSelection: () => void;
}

function SingleDetails({ item, uses, swapSourceId, renaming, onRenaming, renameRef, onExpand, onRemove, onJumpToShot }: Omit<DetailsProps, "item" | "selected" | "onClearSelection"> & { item: StudioLibraryItem }) {
  const { project } = useStudio();
  const itemUses = uses.get(item.item_id) ?? [];
  const url = mediaUrl(item.file.node_id, item.file.file_id);
  const audio = itemAudioTrack(item);
  const locked = item.item_id === swapSourceId ? t("這段影片是一鍵換角的來源影片：備註存著換角工作的設定，不能在這裡編輯。") : null;
  return (
    <div className="grid content-start gap-4 p-4">
      <LargePreview item={item} onExpand={() => { onExpand(item.item_id); }} />
      <div className="grid gap-1.5">
        <NameField key={`${item.item_id}:${renaming ? "edit" : "view"}`} item={item} renaming={renaming} onRenaming={onRenaming} inputRef={renameRef} />
        <p className="flex items-center gap-1.5 text-caption text-fg-tertiary">
          <KindIcon kind={item.kind} className="size-3.5" />
          {joinInline([KIND_LABEL[item.kind], itemSize(item)])}
        </p>
      </div>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-caption">
        {item.kind !== "audio" ? <Fact label={t("解析度")}>{itemDimensions(item)}</Fact> : null}
        {item.kind !== "image" ? <Fact label={t("長度")}>{itemDuration(item)}</Fact> : null}
        {(audio != null && audio !== "") ? <Fact label={t("音軌")}>{audio}</Fact> : null}
        <Fact label={t("大小")}>
          <span title={formatBytesExact(item.file.size_bytes)}>{itemSize(item)}</span>
        </Fact>
        <Fact label={t("格式")}>
          <span className="machine">{item.file.media_type}</span>
        </Fact>
        <Fact label={t("加入時間")}>{formatTimestamp(item.created_at)}</Fact>
        <Fact label={t("來源")}>{itemSource(item)}</Fact>
        <Fact label="ID">
          <span className="machine" title={item.item_id}>
            {item.item_id}
          </span>
        </Fact>
        <Fact label="SHA-256">
          <span className="machine" title={item.file.sha256}>
            {item.file.sha256.slice(0, 16)}…
          </span>
        </Fact>
      </dl>
      <section className="grid gap-1.5" aria-label={t("使用處")}>
        <h4 className="text-caption font-medium text-fg-secondary">{t("使用處")}</h4>
        <UsesSection uses={itemUses} projectId={project.project_id} onJumpToShot={onJumpToShot} />
      </section>
      <NoteField key={item.item_id} item={item} locked={locked} />
      <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
        <LibraryFixButton key={JSON.stringify([item.item_id, item.file.sha256])} item={item} />
        <a href={url} download={item.name} className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}>
          <Download aria-hidden />
          {t("下載")}
        </a>
        <Button
          size="sm"
          variant="danger"
          className="ml-auto"
          icon={<Trash2 aria-hidden />}
          aria-haspopup="dialog"
          aria-keyshortcuts="Delete"
          title={itemUses.length > 0 ? t("還在使用中，不能移除") : t("從專案素材庫移除")}
          onClick={onRemove}
        >
          {t("移除")}
        </Button>
      </div>
    </div>
  );
}

function MultiDetails({ selected, uses, onRemove, onClearSelection }: { selected: readonly StudioLibraryItem[]; uses: ReadonlyMap<string, readonly LibraryUse[]>; onRemove: () => void; onClearSelection: () => void }) {
  const inUse = selected.filter((item) => uses.has(item.item_id)).length;
  const kinds = (["image", "video", "audio"] as const).map((kind) => ({ kind, count: selected.filter((item) => item.kind === kind).length })).filter((entry) => entry.count > 0);
  return (
    <div className="grid content-start gap-4 p-4">
      <div className="grid grid-cols-3 gap-1.5">
        {selected.slice(0, 6).map((item) => (
          <span key={item.item_id} className="grid aspect-video place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage">
            <LibraryThumb item={item} />
          </span>
        ))}
      </div>
      <h3 className="text-data font-semibold text-fg">{t("已選取 {count} 個素材", { count: selected.length })}</h3>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-caption">
        <Fact label={t("類型")}>{joinInline(kinds.map((entry) => `${KIND_LABEL[entry.kind]} ${String(entry.count)}`))}</Fact>
        <Fact label={t("合計大小")}>{totalSize(selected)}</Fact>
        <Fact label={t("使用中")}>{inUse}</Fact>
      </dl>
      <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
        <Button size="sm" variant="quiet" onClick={onClearSelection}>
          {t("取消選取")}
        </Button>
        <Button size="sm" variant="danger" className="ml-auto" icon={<Trash2 aria-hidden />} aria-haspopup="dialog" onClick={onRemove} disabled={inUse === selected.length} title={inUse === selected.length ? t("選取的素材都還在使用中，不能移除") : undefined}>
          {t("移除沒有使用的")}
        </Button>
      </div>
    </div>
  );
}

export function LibraryDetails(props: DetailsProps) {
  const { item, selected } = props;
  const key = selected.length > 1 ? "multi" : (item?.item_id ?? "none");
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={key} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }} transition={motionTransition("fast", "standard")}>
        {selected.length > 1 ? (
          <MultiDetails selected={selected} uses={props.uses} onRemove={props.onRemove} onClearSelection={props.onClearSelection} />
        ) : item ? (
          <SingleDetails {...props} item={item} />
        ) : (
          <div className="grid h-full content-center justify-items-center gap-2 p-6 text-center">
            <span aria-hidden className="grid size-10 place-items-center rounded-xl border border-line bg-sunken text-fg-tertiary">
              <MousePointerClick className="size-5" />
            </span>
            <p className="text-data text-fg-secondary">{t("選一個素材查看詳細資料")}</p>
            <p className="text-caption text-fg-tertiary">{t("Shift／Ctrl＋點選可以選取多個")}</p>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
