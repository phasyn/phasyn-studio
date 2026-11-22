// One @ name in 換參考檔案 (BatchReplaceDialog): the alias, its kind and how many of the selected shots use it; the files it
// points at now (thumbnail, name, how many shots); the files of the same kind in the project library as one group of
// choices, newest first (native radios: the arrow keys move and choose, Tab leaves the group; the first choice is 不換;
// the files it uses now are marked 目前); 上傳新檔案 (the file is chosen once it is in the library; its row shows under the
// choices); and what the choice changes. Whole files are shown (object-contain), so a full-body sheet and a
// head-and-shoulders crop look different.
// Motion: the card and its tiles rise in one after another (motion.reveal), the chosen tile's check pops in, the line
// under the choices fades when it changes; tiles and buttons press.
import { Check, Undo2, Upload } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { CARD, HUD_CHIP, OPTION_SELECTED, THUMB_ZOOM, TILE } from "@/components/ui/look";
import { reveal, useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { cn } from "@/lib/cn";
import type { AliasGroup } from "../../references/batchReplace";
import { itemFacts } from "../../references/display";
import { KindIcon } from "../../references/KindIcon";
import { KIND_LABEL } from "../../references/materials";
import { LibraryThumb } from "../../references/ReferenceRow";
import { ReferenceThumb } from "../../references/ReferenceThumb";

/** Current files named in the card; the rest are counted (every one is also marked among the choices). */
const CURRENT_SHOWN = 4;
/** When a file joined the library, short enough for a tile (tells apart two files with the same name). */
const ADDED_AT: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" };

function Choice({
  name,
  index,
  checked,
  onChoose,
  visual,
  badge = null,
  title,
  detail,
}: {
  name: string;
  index: number;
  checked: boolean;
  onChoose: () => void;
  visual: ReactNode;
  badge?: string | null;
  title: string;
  detail: string;
}) {
  return (
    <label
      ref={reveal(index)}
      title={title}
      className={cn(
        TILE,
        "pressable relative grid min-w-0 cursor-pointer content-start has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus",
        checked ? OPTION_SELECTED : "hover:border-line-strong hover:bg-raised/60",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onChoose} className="sr-only" />
      <span className="relative grid aspect-video w-full place-items-center overflow-hidden bg-stage">
        {visual}
        {(badge != null && badge !== "") ? <span className={cn(HUD_CHIP, "absolute bottom-1 left-1 max-w-[calc(100%-0.5rem)] truncate px-1.5 text-[11px]")}>{badge}</span> : null}
        {checked ? (
          <span aria-hidden className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-brand-gradient text-on-accent animate-pop-in">
            <Check className="size-3" />
          </span>
        ) : null}
      </span>
      <span className="grid min-w-0 gap-0.5 px-1.5 pt-1 pb-1.5">
        <span className="truncate text-caption text-fg">{title}</span>
        <span className="truncate text-[11px] leading-4 text-fg-tertiary">{detail}</span>
      </span>
    </label>
  );
}

export interface BatchReplaceGroupProps {
  group: AliasGroup;
  /** Place among the cards (the entrance stagger). */
  index: number;
  /** The library's files of the group's kind, newest first (no Image Studio masks). */
  choices: readonly StudioLibraryItem[];
  /** Every library file by id (names and thumbnails of the current files). */
  items: ReadonlyMap<string, StudioLibraryItem>;
  /** The chosen file; null = 不換. */
  pick: string | null;
  /** How many of the group's shots the choice changes. */
  changed: number;
  /** How many of the changed shots lose their clip window (the chosen file does not hold it, or its length is unknown). */
  unclipped: number;
  onPick: (itemId: string | null) => void;
  onUpload: (file: File) => void;
  /** This name's uploads (their rows), under the choices. */
  children?: ReactNode;
}

export function BatchReplaceGroup({ group, index, choices, items, pick, changed, unclipped, onPick, onUpload, children }: BatchReplaceGroupProps) {
  const id = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const kind = KIND_LABEL[group.kind];
  const total = group.shotIds.length;
  const uses = new Map(group.files.map((file) => [file.itemId, file.shots]));
  const shown = group.files.slice(0, CURRENT_SHOWN);
  const more = group.files.length - shown.length;
  const note =
    pick !== null
      ? changed === 0
        ? t("{count} 個鏡頭的 @{alias} 都已經是這個檔案，不會改變", { count: total, alias: group.alias })
        : changed < total
          ? t("會換掉 {count} 個鏡頭的 @{alias}；另外 {already} 個已經是這個檔案", { count: changed, alias: group.alias, already: total - changed })
          : t("會換掉 {count} 個鏡頭的 @{alias}", { count: changed, alias: group.alias })
      : // Only when no choice would change a shot: every file there is the one all of these shots already use
        choices.every((item) => uses.get(item.item_id) === total)
        ? t("素材庫沒有其他{kind}", { kind })
        : null;
  // Two files with the same name (an upload repeated) are told apart by when they joined the library
  const repeated = new Set(choices.map((item) => item.name).filter((name, at, names) => names.indexOf(name) !== at));
  // Videos and sounds keep each shot's clip where the new file holds it; say when some go back to the whole file
  const pickedLength = pick === null ? null : (items.get(pick)?.duration_seconds ?? null);
  const clipNote =
    pick === null || unclipped === 0
      ? null
      : pickedLength === null
        ? t("讀不到這個檔案的長度：{count} 個鏡頭的片段會回到整個檔案", { count: unclipped })
        : t("{count} 個鏡頭的片段超出這個檔案的長度，會回到整個檔案", { count: unclipped });
  const noteRef = useChangeFade<HTMLParagraphElement>(`${note ?? ""}\n${clipNote ?? ""}`);
  const upload = t("上傳新檔案並選為 @{alias} 的檔案", { alias: group.alias });

  return (
    <section ref={reveal(index)} aria-labelledby={`${id}-title`} className={cn(CARD, "grid min-w-0 gap-2 p-3")}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={`${id}-title`} className="flex min-w-0 items-center gap-2 text-data">
          <span className="machine shrink-0 rounded-full border border-brand-blue/40 bg-brand-soft px-2 text-action-fg">{`@${group.alias}`}</span>
          <KindIcon kind={group.kind} className="size-3.5" />
          <span className="min-w-0 truncate text-fg-secondary">{t("{kind}・在 {count} 個鏡頭", { kind, count: total })}</span>
        </h3>
        <Button size="sm" variant="quiet" className="ml-auto min-h-7 px-2" icon={<Upload aria-hidden />} aria-label={upload} title={upload} onClick={() => fileInputRef.current?.click()}>
          {t("上傳新檔案")}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept={`${group.kind}/*`}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-caption text-fg-tertiary">{t("目前")}</span>
        {shown.map((file) => {
          const item = items.get(file.itemId);
          return (
            <span key={file.itemId} title={item?.name} className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line-subtle bg-sunken/40 py-0.5 pr-2 pl-0.5">
              <ReferenceThumb item={item ?? null} kind={group.kind} className="size-8" />
              <span className={cn("max-w-[14rem] min-w-0 truncate text-caption", item ? "text-fg" : "text-warning")}>{item?.name ?? t("檔案已不在素材庫")}</span>
              <span className="shrink-0 text-caption text-fg-tertiary">{t("{count} 個鏡頭", { count: file.shots })}</span>
            </span>
          );
        })}
        {more > 0 ? <span className="text-caption text-fg-tertiary">{t("還有 {count} 個檔案", { count: more })}</span> : null}
      </div>

      <div
        role="radiogroup"
        aria-label={t("@{alias} 要換成的檔案", { alias: group.alias })}
        className="grid max-h-[16.5rem] auto-rows-max grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2 overflow-y-auto p-1"
      >
        <Choice
          name={id}
          index={0}
          checked={pick === null}
          onChoose={() => { onPick(null); }}
          visual={<Undo2 aria-hidden className="size-5 text-fg-tertiary" />}
          title={t("不換")}
          detail={t("保留目前的檔案")}
        />
        {choices.map((item, at) => {
          const count = uses.get(item.item_id);
          return (
            <Choice
              key={item.item_id}
              name={id}
              index={at + 1}
              checked={pick === item.item_id}
              onChoose={() => { onPick(item.item_id); }}
              visual={<LibraryThumb item={item} className={cn("object-contain", THUMB_ZOOM)} />}
              badge={count === undefined ? null : t("目前・{count} 個鏡頭", { count })}
              title={item.name}
              detail={repeated.has(item.name) ? formatDateTime(item.created_at, ADDED_AT) : itemFacts(item) || kind}
            />
          );
        })}
      </div>

      {children}

      <p ref={noteRef} className={cn("min-h-[18px] text-caption", pick !== null && changed > 0 ? "text-fg" : "text-fg-tertiary")}>
        {note}
        {(clipNote != null && clipNote !== "") ? <span className="block text-warning">{clipNote}</span> : null}
      </p>
    </section>
  );
}
