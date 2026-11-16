// 這張圖片的 take 清單（最新的在前）：縮圖、seed、狀態、使用中／比較 B／已在素材庫的標記。點選或 Enter 在監看器查看；
// 方向鍵在格子間移動（↑↓ 跨一列）、Home／End 到頭尾、Shift+F10 或右鍵開啟動作選單（設為使用中、比較、下載、
// 加入素材庫、用在影片鏡頭、載入這組參數、封存、刪除）。已封存的 run 預設隱藏。標題「Takes」：詞彙表的 take 沒有中文名稱，
// 標題保留原文；句子裡寫小寫的 take。專案有圖片才出現（第一張圖片加入時從下緣滑入）。
import { Archive, Columns2, Ellipsis, FolderCheck, LoaderCircle, PanelBottomClose, PanelBottomOpen, Star } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { GeneratingFrame } from "@/components/common/GeneratingFrame";
import { reveal, usePanelEnter } from "@/components/ui/motion";
import { CircularProgress } from "@/components/common/CircularProgress";
import { HUD_BUTTON, HUD_CHIP, LIFT, PANEL, THUMB_ZOOM } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import type { MenuAnchor, MenuItem } from "@/components/ui/menuModel";
import { isMenuKey } from "@/lib/keyboard";
import { useImageStudio } from "../imageStudioContext";
import { takePreview } from "../model/outcome";
import { takeLibraryItem } from "../model/sendToVideo";
import { imageShots, takeNumber } from "../model/shots";
import type { StudioImageShot, StudioImageTake } from "../types";
import { gridColumns, gridStep } from "./display";
import { ImageThumb } from "./ImageThumb";
import { TakeStateMark } from "./marks";
import { PANEL_NAMES } from "./panels";
import { useTakeActions } from "./useTakeActions";
import { t } from "@/i18n";

/** 縮圖上的快速動作（與動作選單同一組項目、同樣的停用原因）：滑過或聚焦格子時浮現；鍵盤用 Shift+F10 開啟完整選單。 */
const QUICK_ACTIONS = ["active", "compare", "library", "video"] as const;

function QuickActions({ items }: { items: readonly MenuItem[] }) {
  const quick = QUICK_ACTIONS.map((id) => items.find((item) => item.id === id)).filter((item): item is MenuItem => item !== undefined);
  return (
    <span
      className={cn(
        "material-hud pointer-events-none absolute inset-x-3 bottom-9 z-[2] flex items-center justify-center gap-1 rounded-full border border-white/10 p-0.5 opacity-0",
        "transition-[opacity,translate] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) translate-y-1",
        "group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100",
      )}
    >
      {quick.map((item) => {
        const Icon = item.icon;
        const reason = item.disabledReason ?? null;
        return (
          <button
            key={item.id}
            type="button"
            tabIndex={-1}
            aria-label={item.label}
            aria-disabled={reason ? true : undefined}
            title={reason ? t("{label}：{reason}", { label: item.label, reason }) : item.label}
            onClick={(event) => {
              event.stopPropagation();
              if (!reason) item.onSelect();
            }}
            className={cn(HUD_BUTTON, "size-6 border-transparent bg-transparent")}
          >
            {Icon ? <Icon aria-hidden /> : null}
          </button>
        );
      })}
    </span>
  );
}

interface MenuState {
  takeId: string;
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
  focus: "first" | "last";
}

function Tile({ shot, take, index, viewing, onKeyDown, onOpenMenu, menuId, menuOpen, onCloseMenu, focusable }: {
  shot: StudioImageShot;
  take: StudioImageTake;
  /** 在格子中的位置（新出現的 take 依序淡入）。 */
  index: number;
  viewing: boolean;
  focusable: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onOpenMenu: (anchor: MenuAnchor, returnFocus: HTMLElement | null, focus: "first" | "last") => void;
  menuId: string;
  menuOpen: boolean;
  onCloseMenu: () => void;
}) {
  const { project, selectTake, compareTakeId, runs } = useImageStudio();
  const { menuItems } = useTakeActions();
  const active = shot.active_take_id === take.take_id;
  const comparing = compareTakeId === take.take_id;
  const inLibrary = takeLibraryItem(project.library ?? [], shot.image_shot_id, take) !== null;
  const number = takeNumber(shot, take.take_id);
  const rendering = take.state === "rendering";
  const preview = rendering ? takePreview(runs.get(take.run_id), take) : null;
  const done = take.state === "succeeded" && take.image !== null;
  return (
    <li
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu({ kind: "point", x: event.clientX, y: event.clientY }, event.currentTarget.querySelector<HTMLElement>("[data-take-tile]"), "first");
      }}
      ref={reveal(index)}
      className={cn("group group/tile relative grid min-w-0 gap-1.5 rounded-xl border p-1.5", LIFT, "has-[[data-take-tile]:active]:scale-[0.97] has-[[data-take-tile]:active]:duration-[90ms]", viewing ? "border-transparent bg-brand-gradient-soft shadow-glow-sm border-brand-gradient" : "border-line-subtle bg-canvas hover:border-line-strong")}
    >
      <button
        type="button"
        data-take-tile={take.take_id}
        tabIndex={focusable ? 0 : -1}
        aria-pressed={viewing}
        aria-keyshortcuts="Shift+F10"
        aria-label={t("take {number}・seed {seed}{value}", { number, seed: take.seed, value: active ? t("・使用中") : "" })}
        onClick={() => selectTake(take.take_id)}
        onKeyDown={onKeyDown}
        className="relative z-[1] grid min-w-0 gap-1.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      >
        {done && take.image ? (
          <ImageThumb file={take.image.file} className="aspect-square w-full rounded-lg" fit="contain" imgClassName={THUMB_ZOOM} />
        ) : rendering ? (
          <GeneratingFrame active progress={preview && preview.total > 0 ? preview.step / preview.total : null} className="aspect-square w-full">
            <span className="relative grid size-full place-items-center overflow-hidden rounded-[inherit] bg-stage">
              {preview ? <img src={preview.url} alt="" aria-hidden draggable={false} className="absolute inset-0 size-full object-contain opacity-80" /> : null}
              {preview && preview.total > 0 ? (
                <CircularProgress value={preview.step / preview.total} label={t("take {number} 的 DiT 步數（預覽）", { number })} size={30} strokeWidth={3} className="relative" />
              ) : (
                <LoaderCircle aria-hidden className="relative size-6 text-brand-cyan animate-spin" />
              )}
              <span className={cn(HUD_CHIP, "absolute bottom-1.5 left-1/2 -translate-x-1/2 py-0 text-[11px] whitespace-nowrap")}>{preview ? t("預覽 {step}／{total}", { step: preview.step, total: preview.total }) : t("生成中")}</span>
            </span>
          </GeneratingFrame>
        ) : (
          <span className="grid aspect-square w-full place-items-center rounded-lg border border-line-subtle bg-stage p-1 text-center">
            <TakeStateMark state={take.state} />
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1 px-0.5 text-caption">
          <span className="machine shrink-0 text-fg-tertiary">{`#${number}`}</span>
          <span className="machine truncate text-fg-secondary">{take.seed}</span>
        </span>
      </button>
      <span aria-hidden className="pointer-events-none absolute top-2.5 left-2.5 z-[2] flex gap-1">
        {active ? (
          <span title={t("使用中")} className={cn(HUD_CHIP, "grid size-5 place-items-center p-0 text-brand-cyan")}>
            <Star className="size-3" />
          </span>
        ) : null}
        {comparing ? (
          <span title={t("比較的 B")} className={cn(HUD_CHIP, "grid size-5 place-items-center p-0 text-entity")}>
            <Columns2 className="size-3" />
          </span>
        ) : null}
        {inLibrary ? (
          <span title={t("已在專案素材庫")} className={cn(HUD_CHIP, "grid size-5 place-items-center p-0 text-file")}>
            <FolderCheck className="size-3" />
          </span>
        ) : null}
      </span>
      {done ? <QuickActions items={menuItems(shot, take)} /> : null}
      <MenuTriggerButton
        menuId={menuId}
        open={menuOpen}
        label={t("take {number} 的動作", { number })}
        onOpen={(element, focus) => onOpenMenu({ kind: "element", element }, element, focus)}
        onClose={onCloseMenu}
        className="material-hud absolute top-2 right-2 z-[3] size-6 rounded-full border border-white/10 opacity-80 group-hover:opacity-100 [&_svg]:size-3.5"
      >
        <Ellipsis aria-hidden />
      </MenuTriggerButton>
    </li>
  );
}

export function TakesGallery({ collapsed, onToggleCollapsed }: { collapsed: boolean; onToggleCollapsed: () => void }) {
  const { project, selectedShotId, selectedTakeId, selectTake, archivedRunIds } = useImageStudio();
  const { menuItems } = useTakeActions();
  const menuId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const shot = imageShots(project).find((item) => item.image_shot_id === selectedShotId) ?? null;
  const all = shot ? [...shot.takes].reverse() : [];
  const archivedCount = all.filter((take) => archivedRunIds.has(take.run_id)).length;
  const takes = showArchived ? all : all.filter((take) => !archivedRunIds.has(take.run_id) || take.take_id === selectedTakeId);
  const focusIndex = Math.max(0, takes.findIndex((take) => take.take_id === selectedTakeId));
  const menuTake = menu && shot ? shot.takes.find((take) => take.take_id === menu.takeId) : undefined;
  const enter = usePanelEnter<HTMLElement>(PANEL_NAMES.takes, "bottom");

  const focusTake = (index: number) => {
    const target = takes[Math.max(0, Math.min(takes.length - 1, index))];
    if (!target) return;
    selectTake(target.take_id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-take-tile="${target.take_id}"]`)?.focus());
  };

  const onKeyDown = (index: number, take: StudioImageTake) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isMenuKey(event)) {
      event.preventDefault();
      setMenu({ takeId: take.take_id, anchor: { kind: "element", element: event.currentTarget }, returnFocus: event.currentTarget, focus: "first" });
      return;
    }
    const next = gridStep(event.key, index, gridColumns(listRef.current), takes.length);
    if (next === undefined) return;
    event.preventDefault();
    focusTake(next);
  };

  return (
    <section ref={enter} aria-label="Takes" className={PANEL}>
      <div className={cn("flex h-11 shrink-0 items-center gap-2 px-2", !collapsed && "border-b border-line-subtle")}>
        <button
          type="button"
          data-panel-toggle=""
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("展開 take 清單") : t("收合 take 清單")}
          title={collapsed ? t("展開 take 清單") : t("收合 take 清單")}
          className="pressable inline-flex size-7 items-center justify-center rounded-md text-fg-tertiary hover:bg-raised hover:text-fg active:bg-sunken [&_svg]:size-3.5"
        >
          {collapsed ? <PanelBottomOpen aria-hidden /> : <PanelBottomClose aria-hidden />}
        </button>
        <h2 className="text-body font-semibold text-fg">Takes</h2>
        <span className="machine rounded-full bg-overlay px-1.5 text-caption text-fg-tertiary">{all.length}</span>
        {archivedCount > 0 ? (
          <label className="pressable ml-auto flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-caption text-fg-secondary hover:bg-raised has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
            <input type="checkbox" className="size-3.5 accent-action" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            <Archive aria-hidden className="size-3.5 text-fg-tertiary" />
            {t("顯示已封存（{archivedCount}）", { archivedCount })}
          </label>
        ) : null}
      </div>
      {collapsed || !shot ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5 animate-fade-in">
          {all.length === 0 ? (
            // 監看器已經說明怎麼生成：這裡只說還沒有，不再放第二個空狀態
            <p className="px-1 py-1.5 text-caption text-fg-tertiary">{t("還沒有 take")}</p>
          ) : takes.length === 0 ? (
            <EmptyState icon={<Archive />} size="compact" className="py-3" title={t("take 都已封存")} description={t("勾選「顯示已封存」可以查看。")} />
          ) : (
            <ul ref={listRef} aria-label={t("「{value}」的 take", { value: shot.title || t("未命名圖片") })} className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2.5">
              {takes.map((take, index) => (
                <Tile
                  key={take.take_id}
                  shot={shot}
                  take={take}
                  index={index}
                  viewing={take.take_id === selectedTakeId}
                  focusable={index === focusIndex}
                  onKeyDown={onKeyDown(index, take)}
                  onOpenMenu={(anchor, returnFocus, focus) => setMenu({ takeId: take.take_id, anchor, returnFocus, focus })}
                  menuId={menuId}
                  menuOpen={menu?.takeId === take.take_id}
                  onCloseMenu={() => setMenu(null)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {menu && shot && menuTake ? (
        <ActionMenu id={menuId} label={t("take {takeNumber} 的動作", { takeNumber: takeNumber(shot, menuTake.take_id) })} items={menuItems(shot, menuTake)} anchor={menu.anchor} returnFocus={menu.returnFocus} initialFocus={menu.focus} onClose={() => setMenu(null)} />
      ) : null}
    </section>
  );
}
