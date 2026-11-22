// 鏡頭參考清單的一列：拖曳把手（拖到同類參考之間調整送出順序；聚焦時 ↑／↓ 也能移）、56 px 縮圖、@ 名稱（按一下插入
// prompt）、檔名（雙擊或 F2 重新命名＝改素材庫名稱）、類型與媒體資訊；影片／聲音另有「片段」可展開裁切、預覽與原聲
// （影片還有終點之後凍結最後一格，片段摘要寫「・之後凍結」）。
// 其他動作在列的「…」選單：重新命名、換成其他檔案（@ 名稱與 prompt 不變）、往前／往後移、從這個鏡頭移除（prompt 還在用它時先確認）。
// 外觀：群組卡列（不發光、不抬升：裡面有輸入欄位）；拖曳中的列以 DRAG_LIFT 浮起；@ 名稱是膠囊小籤。
import { ArrowDown, ArrowUp, ChevronDown, Ellipsis, GripVertical, ImageOff, Pencil, Replace, Scissors, Trash2, TriangleAlert } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CARD, DRAG_LIFT, THUMB_ZOOM, TOOL_BUTTON } from "@/components/ui/look";
import type { MenuAnchor, MenuItem } from "@/components/ui/menuModel";
import { cn } from "@/lib/cn";
import { formatSeconds } from "../prompt/blocks";
import { itemFacts } from "./display";
import { KindIcon } from "./KindIcon";
import { heldReference, KIND_LABEL, type PresentationLabel } from "./materials";
import { ReferenceClip } from "./ReferenceClip";
import { ReferenceName } from "./ReferenceName";
import { ReferenceReplace, type ReplaceChoices } from "./ReferenceReplace";
import { t } from "@/i18n";

/**
 * 素材庫項目的縮圖（圖片、影片首格；聲音用圖示）；讀不到時顯示破圖示，不放假畫面。
 * className 只套在圖片／影片上（例如縮圖磚的 Photos 式 hover 放大 THUMB_ZOOM）。
 */
export function LibraryThumb({ item, className }: { item: StudioLibraryItem | undefined; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!item || failed) return <ImageOff aria-hidden className="size-4 text-fg-disabled" />;
  const url = mediaUrl(item.file.node_id, item.file.file_id);
  if (item.kind === "image") return <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => { setFailed(true); }} className={cn("size-full object-cover", className)} />;
  if (item.kind === "video") return <video src={`${url}#t=0.1`} preload="metadata" muted playsInline aria-hidden onError={() => { setFailed(true); }} className={cn("size-full object-cover", className)} />;
  return <KindIcon kind="audio" className="size-5" />;
}

/** 「0–12.5 秒」：送出的片段（沒有終點且長度未知時寫「結尾」）；終點之後凍結最後一格時「0.0–3.1 秒・之後凍結」。 */
function clipSpan(reference: StudioReference, item: StudioLibraryItem | undefined): string {
  const end = reference.end_seconds ?? item?.duration_seconds ?? null;
  const span = t("{start}–{end} 秒", { start: formatSeconds(reference.start_seconds ?? 0, 1), end: end === null ? t("結尾") : formatSeconds(end, 1) });
  return heldReference(reference) ? t("{span}・之後凍結", { span }) : span;
}

export interface ReferenceDrag {
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  /** This row is being dragged. */
  active: boolean;
}

export function ReferenceRow({
  reference,
  item,
  label,
  mentions,
  tagUses = 0,
  disabled,
  onChange,
  onRemove,
  onInsertMention,
  rename,
  replace,
  move,
  drag,
  className,
  ref,
}: {
  reference: StudioReference;
  item: StudioLibraryItem | undefined;
  label: PresentationLabel | undefined;
  /** prompt 裡 @ 名稱用到幾次；不知道 prompt 時為 null。 */
  mentions: number | null;
  /** prompt 裡直接寫它的 H3 標籤（<Picture n>…，含影片原聲的 <Audio n>）的次數。 */
  tagUses?: number;
  disabled: boolean;
  onChange: (patch: Partial<StudioReference>) => void;
  onRemove: () => void;
  onInsertMention?: (alias: string) => void;
  /** 重新命名素材庫檔案（沒提供＝檔名唯讀）；problem 回傳新名稱的問題，可以用＝null。 */
  rename?: { problem: (name: string) => string | null; onRename: (name: string) => void };
  /** 換成其他檔案（同一類）；沒提供＝不能換。 */
  replace?: ReplaceChoices;
  /** 同類中往前／往後移（交換送出順序）；沒提供＝不能調整順序（沒有把手）。 */
  move?: { up: boolean; down: boolean; onMove: (delta: -1 | 1) => void };
  drag?: ReferenceDrag;
  className?: string;
  /** 清單層的逐項進場（motion.reveal）。 */
  ref?: Ref<HTMLLIElement>;
}) {
  const id = useId();
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; element: HTMLElement; focus: "first" | "last" } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [replacing, setReplacing] = useState(false);
  // The row's 「…」 button: focus comes back to it when the rename field or the removal question leaves
  const menuSlotRef = useRef<HTMLSpanElement>(null);
  const alias = `@${reference.alias}`;
  const timed = reference.kind !== "image";
  const uses = mentions === null ? null : mentions + tagUses;
  const canRename = rename !== undefined && item !== undefined && !disabled;
  const focusMenuButton = () => menuSlotRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });

  // The video's own sound is sent (or may be, when the browser cannot tell): shown on the row, not only in its clip settings
  const originalSound = reference.kind === "video" && (label?.soundtrack?.state === "used" || label?.soundtrack?.state === "unknown");
  const h3Note = `${t("H3：{value}", { value: label?.label ?? "—" })}${label?.soundtrack?.state === "used" ? t(" ＋ 原聲 {value}", { value: label.soundtrack.label ?? "<Audio ?>" }) : ""}${
    uses !== null ? (uses > 0 ? t(" · prompt 用了 {mentions} 次", { mentions: uses }) : t(" · prompt 還沒用到")) : ""
  }`;
  // F2（焦點在這一列的任何按鈕上）：重新命名；輸入欄位裡的 F2 不攔
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.key !== "F2" || !canRename || event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    setRenaming(true);
  };
  const askRemove = () => {
    // prompt 還用到它時先確認；沒用到就直接移除（檔案仍在素材庫）
    if (uses !== null && uses > 0) setConfirmRemove(true);
    else onRemove();
  };
  const items: MenuItem[] = [
    ...(rename && item ? [{ id: "rename", label: t("重新命名"), icon: Pencil, shortcut: "F2", disabledReason: disabled ? t("目前無法編輯") : null, onSelect: () => { setRenaming(true); } }] : []),
    ...(move
      ? [
          { id: "up", label: t("往前移（送出順序）"), icon: ArrowUp, shortcut: "↑", disabledReason: move.up ? null : t("已經是同類的第一個"), onSelect: () => { move.onMove(-1); } },
          { id: "down", label: t("往後移（送出順序）"), icon: ArrowDown, shortcut: "↓", disabledReason: move.down ? null : t("已經是同類的最後一個"), onSelect: () => { move.onMove(1); } },
        ]
      : []),
    ...(replace ? [{ id: "replace", label: replacing ? t("收起換檔") : t("換成其他檔案…"), icon: Replace, disabledReason: disabled ? t("目前無法編輯") : null, onSelect: () => { setReplacing((open) => !open); } }] : []),
    ...(timed && item ? [{ id: "clip", label: clipOpen ? t("收起片段設定") : t("片段與原聲…"), icon: Scissors, onSelect: () => { setClipOpen((open) => !open); } }] : []),
    { id: "remove", label: t("從這個鏡頭移除…"), icon: Trash2, tone: "danger" as const, separatorBefore: true, disabledReason: disabled ? t("目前無法編輯") : null, onSelect: askRemove },
  ];

  return (
    <li /* eslint-disable-line jsx-a11y-x/no-noninteractive-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */
      ref={ref}
      data-ref-id={reference.ref_id}
      data-ref-kind={reference.kind}
      onKeyDown={onKeyDown}
      className={cn(
        CARD,
        "relative grid min-w-0 gap-1.5 p-1.5 transition-[scale,rotate,box-shadow] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)",
        (drag?.active === true) && cn(DRAG_LIFT, "z-[2] shadow-raised ring-1 ring-brand-blue/50"),
        className,
      )}
    >
      <div className={cn("grid min-w-0 items-center gap-x-2", move ? "grid-cols-[1.25rem_3.5rem_minmax(0,1fr)_auto]" : "grid-cols-[3.5rem_minmax(0,1fr)_auto]")}>
        {move ? (
          <button
            type="button"
            aria-label={t("調整 {alias} 的送出順序", { alias })}
            title={t("拖曳到同類參考之間調整送出順序；也可以按 ↑／↓")}
            aria-keyshortcuts="ArrowUp ArrowDown"
            aria-disabled={disabled || (!move.up && !move.down) || undefined}
            onPointerDown={disabled ? undefined : drag?.onPointerDown}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              if (disabled || !(event.key === "ArrowUp" ? move.up : move.down)) return;
              move.onMove(event.key === "ArrowUp" ? -1 : 1);
            }}
            className={cn(TOOL_BUTTON, "h-14 w-5 touch-none text-fg-tertiary", !move.up && !move.down ? "opacity-40" : "cursor-grab active:cursor-grabbing")}
          >
            <GripVertical aria-hidden />
          </button>
        ) : null}
        <div className="group/tile grid size-14 place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage">
          <LibraryThumb item={item} className={THUMB_ZOOM} />
        </div>
        {/* 兩行：上＝@ 名稱與檔名；下＝類型與媒體資訊（H3 標籤與使用次數在 @ 名稱的提示） */}
        <div className="grid min-w-0 gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {onInsertMention ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => { onInsertMention(reference.alias); }}
                title={`${t("插入 {alias} 到 prompt", { alias })}\n${h3Note}`}
                aria-label={t("插入 {alias} 到 prompt", { alias })}
                className="pressable machine shrink-0 rounded-full border border-brand-blue/40 bg-brand-soft px-2 text-data text-action-fg hover:border-brand-blue/70 hover:bg-brand-blue/20 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-fg-disabled"
              >
                {alias}
              </button>
            ) : (
              <span title={h3Note} className="machine shrink-0 rounded-full border border-line bg-raised px-2 text-data text-fg">
                {alias}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <ReferenceName name={item?.name ?? null} alias={reference.alias} {...(rename === undefined ? {} : { rename })} editing={renaming} onEditingChange={setRenaming} onFinished={focusMenuButton} disabled={disabled} />
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-1 text-caption text-fg-tertiary">
            <KindIcon kind={reference.kind} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate" title={item ? `${KIND_LABEL[reference.kind]} · ${itemFacts(item)}` : KIND_LABEL[reference.kind]}>
              {KIND_LABEL[reference.kind]}
              {item ? ` · ${itemFacts(item)}` : ""}
            </span>
            {uses === 0 ? <span className="shrink-0 text-warning">{t("· prompt 沒用到")}</span> : null}
            {originalSound ? (
              <span className="shrink-0 text-warning" title={t("原片的台詞是原角色的聲音：嘴型與聲線會對不上新角色。要角色說話時，關掉「使用原片聲音當參考」，在 prompt 寫 <d> 台詞。")}>
                {t("· 用原片聲音")}
              </span>
            ) : null}
            {timed && item ? (
              <button
                type="button"
                aria-expanded={clipOpen}
                aria-controls={clipOpen ? `${id}-clip` : undefined}
                aria-label={t("{alias} 的片段與原聲", { alias })}
                title={t("片段：{span}", { span: clipSpan(reference, item) })}
                onClick={() => { setClipOpen((open) => !open); }}
                className="pressable ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-fg-secondary hover:bg-raised hover:text-fg aria-expanded:bg-brand-gradient-soft aria-expanded:text-fg [&_svg]:size-3"
              >
                <Scissors aria-hidden />
                <span className="machine">{clipSpan(reference, item)}</span>
                <ChevronDown aria-hidden className={cn("transition-transform duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)", clipOpen && "rotate-180")} />
              </button>
            ) : null}
          </div>
        </div>
        <span ref={menuSlotRef} data-row-menu="" className="contents">
          <MenuTriggerButton
            menuId={`${id}-menu`}
            open={menu !== null}
            label={t("{alias} 的動作", { alias })}
            onOpen={(element, focus) => { setMenu({ anchor: { kind: "element", element }, element, focus }); }}
            onClose={() => { setMenu(null); }}
            className="size-8 self-center [&_svg]:size-4"
          >
            <Ellipsis aria-hidden />
          </MenuTriggerButton>
        </span>
      </div>

      {replace && replacing ? (
        <ReferenceReplace
          reference={reference}
          choices={replace}
          disabled={disabled}
          onDone={() => {
            setReplacing(false);
            focusMenuButton();
          }}
        />
      ) : null}

      {timed && item && clipOpen ? (
        <div id={`${id}-clip`}>
          <ReferenceClip reference={reference} item={item} label={label} disabled={disabled} onChange={onChange} />
        </div>
      ) : null}

      {confirmRemove ? (
        <Callout tone="warning" icon={<TriangleAlert />} title={t("從這個鏡頭移除 {alias}？", { alias })} className="animate-reveal">
          {mentions !== null && mentions > 0 ? <p>{t("prompt 中有 {mentions} 處 {alias}；移除後它們會變成找不到的參考，渲染會被擋下，直到改掉或再加入同名參考。", { mentions, alias })}</p> : null}
          {mentions !== null && tagUses > 0 ? (
            <p>{t("prompt 直接寫了 {tagUses} 處它的 H3 標籤（{value}）；移除後同類參考會重新編號，這些標籤會改指向其他參考或超出數量。", { tagUses, value: label?.label ?? "—" })}</p>
          ) : null}
          <p>{t("檔案仍保留在專案素材庫，可以再加回來（可能會拿到不同的 @ 名稱）。")}</p>
          <div className="flex gap-1.5 pt-1">
            <Button
              size="sm"
              variant="danger-confirm"
              onClick={() => {
                setConfirmRemove(false);
                onRemove();
              }}
            >
              {t("移除")}
            </Button>
            {/* 確認框連同按鈕一起消失：焦點回到列的「…」按鈕，不掉到頁面 */}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setConfirmRemove(false);
                focusMenuButton();
              }}
            >
              {t("取消")}
            </Button>
          </div>
        </Callout>
      ) : null}

      {menu ? (
        // Esc 只關閉選單，不關閉外層的專業編輯器
        <div data-escape-local="true" className="contents">
          <ActionMenu id={`${id}-menu`} label={t("{alias} 的動作", { alias })} items={items} anchor={menu.anchor} returnFocus={menu.element} initialFocus={menu.focus} onClose={() => { setMenu(null); }} />
        </div>
      ) : null}
    </li>
  );
}
