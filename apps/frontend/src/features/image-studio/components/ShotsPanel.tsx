// 左側面板：圖片清單（縮圖、狀態、模式、take 數；Alt+↑↓ 調整順序、Delete 刪除、右鍵或 Shift+F10 動作選單）與
// 紀錄（這個專案所有的生成 run，最新的在上；同一個批次＝同一個 run；封存、永久刪除、到執行紀錄）。專案還沒有圖片時
// 清單只有「新增圖片」（空狀態只在主區出現一次）。
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Copy, Ellipsis, ExternalLink, History, Images, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { PANEL, ROW_MARKER, ROW_SELECTED, THUMB_ZOOM } from "@/components/ui/look";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reveal, usePanelEnter } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { PanelCollapseButton } from "@/features/studio-shell";
import type { MenuAnchor, MenuItem } from "@/components/ui/menuModel";
import { isMenuKey } from "@/lib/keyboard";
import { useImageStudio } from "../imageStudioContext";
import { MODE_LABELS } from "../model/constants";
import { changedSinceTake } from "../model/params";
import { activeImageTake, imageShots, imageShotStatus, localId, neighbourImageShotId } from "../model/shots";
import type { ImageTakeState, StudioImageShot, StudioImageTake } from "../types";
import { ImageThumb } from "./ImageThumb";
import { ModeBadge, ShotStatusMark, TakeStateMark } from "./marks";
import { PANEL_NAMES } from "./panels";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

interface MenuState {
  id: string;
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
  focus: "first" | "last";
}

/** 下一個畫面再聚焦某一列（移動、刪除後清單換位置會失去焦點）。 */
function focusRowLater(selector: string) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: false }));
}

function ShotRow({ shot, index, count, selected, menuId, menuOpen, onOpenMenu, onCloseMenu, onRequestDelete }: {
  shot: StudioImageShot;
  index: number;
  count: number;
  selected: boolean;
  menuId: string;
  menuOpen: boolean;
  onOpenMenu: (shotId: string, anchor: MenuAnchor, returnFocus: HTMLElement | null, focus: "first" | "last") => void;
  onCloseMenu: () => void;
  onRequestDelete: (shotId: string) => void;
}) {
  const { dispatch, selectShot, notSent } = useImageStudio();
  const status = imageShotStatus(shot, (take) => changedSinceTake(take, shot), notSent.get(shot.image_shot_id) ?? null);
  const take = activeImageTake(shot);
  const move = (delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= count) return;
    dispatch({ type: "moveImageShot", shotId: shot.image_shot_id, toIndex: to });
    focusRowLater(`[data-image-row="${shot.image_shot_id}"]`);
  };
  return (
    <li
      onContextMenu={(event) => {
        event.preventDefault();
        const row = event.currentTarget.querySelector<HTMLElement>("[data-image-row]");
        onOpenMenu(shot.image_shot_id, { kind: "point", x: event.clientX, y: event.clientY }, row, "first");
      }}
      ref={reveal(index)}
      className={cn("group group/tile relative mx-1.5 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-(--duration-fast) active:bg-sunken", selected ? cn(ROW_SELECTED, ROW_MARKER) : "hover:bg-raised")}
    >
      <button
        type="button"
        data-image-row={shot.image_shot_id}
        onClick={() => selectShot(shot.image_shot_id)}
        onKeyDown={(event) => {
          if (isMenuKey(event)) {
            event.preventDefault();
            onOpenMenu(shot.image_shot_id, { kind: "element", element: event.currentTarget }, event.currentTarget, "first");
          } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            move(event.key === "ArrowUp" ? -1 : 1);
          } else if ((event.key === "Delete" || event.key === "Backspace") && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            onRequestDelete(shot.image_shot_id);
          }
        }}
        aria-current={selected ? "true" : undefined}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete Shift+F10"
        title={t("Alt+↑／↓ 調整順序、Delete 刪除、右鍵或 Shift+F10 開啟動作選單")}
        className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ImageThumb file={take?.state === "succeeded" ? take.image?.file : null} className={cn("size-11 rounded-md", selected && "border-brand-blue/50")} imgClassName={THUMB_ZOOM} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-data text-fg">
            <span className="machine shrink-0 text-caption text-fg-tertiary">{String(index + 1).padStart(2, "0")}</span>
            <span className={cn("min-w-0 truncate", selected && "font-medium")} title={shot.title || t("未命名圖片")}>
              {shot.title || t("未命名圖片")}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-caption text-fg-tertiary">
            <ShotStatusMark status={status} compact />
            <ModeBadge mode={shot.mode} />
            <span className="truncate">{`${shot.width}×${shot.height}${shot.takes.length > 0 ? t("・{takesCount} take", { takesCount: shot.takes.length }) : ""}`}</span>
          </span>
        </span>
      </button>
      <MenuTriggerButton
        menuId={menuId}
        open={menuOpen}
        label={t("「{value}」的動作", { value: shot.title || t("未命名圖片") })}
        onOpen={(element, focus) => onOpenMenu(shot.image_shot_id, { kind: "element", element }, element, focus)}
        onClose={onCloseMenu}
        className="size-7 opacity-70 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [&_svg]:size-4"
      >
        <Ellipsis aria-hidden />
      </MenuTriggerButton>
    </li>
  );
}

function DeleteShotDialog({ shotId, onClose }: { shotId: string | null; onClose: () => void }) {
  const { project, dispatch, selectShot, selectedShotId } = useImageStudio();
  const shot = imageShots(project).find((item) => item.image_shot_id === shotId) ?? null;
  const runs = new Set(shot?.takes.map((take) => take.run_id) ?? []);
  const rendering = shot?.takes.some((take) => take.state === "rendering") ?? false;
  return (
    <Dialog open={shot !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("刪除「{value}」？", { value: shot?.title || t("未命名圖片") })}</DialogTitle>
          <DialogDescription>{t("只從專案移除這張圖片的設定與 {value} 個 take 的紀錄。", { value: shot?.takes.length ?? 0 })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-2 text-data text-fg-secondary">
          <p>{t("已生成的圖片檔與 {runsCount} 個 run 不會刪除：要永久刪除，到「紀錄」分頁對 run 選「永久刪除」。", { runsCount: runs.size })}</p>
          <p>{t("已加入素材庫的白底版保留在素材庫（影片鏡頭可能正在使用）。")}</p>
          {rendering ? <p className="text-warning">{t("這張圖片還有生成中的 take：run 會繼續執行，但結果不會再寫回專案。")}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button
            variant="danger-confirm"
            icon={<Trash2 aria-hidden />}
            onClick={() => {
              if (!shot) return;
              const next = neighbourImageShotId(project, shot.image_shot_id);
              dispatch({ type: "removeImageShot", shotId: shot.image_shot_id });
              if (selectedShotId === shot.image_shot_id) selectShot(next);
              onClose();
              if (next) focusRowLater(`[data-image-row="${next}"]`);
            }}
          >
            {t("從專案刪除")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShotList() {
  const { project, selectedShotId, addShot, dispatch, selectShot } = useImageStudio();
  const shots = imageShots(project);
  const menuId = useId();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const openShot = menu ? shots.find((shot) => shot.image_shot_id === menu.id) : undefined;
  const openIndex = openShot ? shots.indexOf(openShot) : -1;
  const items: MenuItem[] = openShot
    ? [
        {
          id: "duplicate",
          label: t("複製設定（新的圖片）"),
          icon: Copy,
          onSelect: () => {
            const id = localId("i");
            dispatch({ type: "duplicateImageShot", shotId: openShot.image_shot_id, newShotId: id, title: t("{title}（複本）", { title: openShot.title }) });
            selectShot(id);
          },
        },
        {
          id: "up",
          label: t("上移"),
          icon: ArrowUp,
          shortcut: "Alt+↑",
          disabledReason: openIndex <= 0 ? t("已經是第一張") : null,
          onSelect: () => dispatch({ type: "moveImageShot", shotId: openShot.image_shot_id, toIndex: openIndex - 1 }),
        },
        {
          id: "down",
          label: t("下移"),
          icon: ArrowDown,
          shortcut: "Alt+↓",
          disabledReason: openIndex >= shots.length - 1 ? t("已經是最後一張") : null,
          onSelect: () => dispatch({ type: "moveImageShot", shotId: openShot.image_shot_id, toIndex: openIndex + 1 }),
        },
        { id: "delete", label: t("刪除…"), icon: Trash2, tone: "danger", shortcut: "Delete", separatorBefore: true, onSelect: () => setPendingDelete(openShot.image_shot_id) },
      ]
    : [];
  return (
    <div className="grid gap-2 py-2">
      <div className="px-2">
        <Button size="sm" variant="secondary" icon={<Plus aria-hidden />} onClick={addShot} className="w-full">
          {t("新增圖片")}
        </Button>
      </div>
      {shots.length === 0 ? null : (
        <ul aria-label={t("圖片清單")} className="grid gap-0.5">
          {shots.map((shot, index) => (
            <ShotRow
              key={shot.image_shot_id}
              shot={shot}
              index={index}
              count={shots.length}
              selected={shot.image_shot_id === selectedShotId}
              menuId={menuId}
              menuOpen={menu?.id === shot.image_shot_id}
              onOpenMenu={(id, anchor, returnFocus, focus) => {
                if (selectedShotId !== id) selectShot(id);
                setMenu({ id, anchor, returnFocus, focus });
              }}
              onCloseMenu={() => setMenu(null)}
              onRequestDelete={setPendingDelete}
            />
          ))}
        </ul>
      )}
      {menu && openShot ? (
        <ActionMenu id={menuId} label={t("「{value}」的動作", { value: openShot.title || t("未命名圖片") })} items={items} anchor={menu.anchor} returnFocus={menu.returnFocus} initialFocus={menu.focus} onClose={() => setMenu(null)} />
      ) : null}
      <DeleteShotDialog shotId={pendingDelete} onClose={() => setPendingDelete(null)} />
    </div>
  );
}

interface RunEntry {
  runId: string;
  shot: StudioImageShot;
  takes: StudioImageTake[];
  createdAt: string;
  state: ImageTakeState;
}

function aggregate(states: ImageTakeState[]): ImageTakeState {
  if (states.includes("rendering")) return "rendering";
  if (states.every((state) => state === "succeeded")) return "succeeded";
  return states.find((state) => state !== "succeeded") ?? "failed";
}

function runEntries(shots: readonly StudioImageShot[]): RunEntry[] {
  const map = new Map<string, RunEntry>();
  for (const shot of shots) {
    for (const take of shot.takes) {
      const entry = map.get(take.run_id) ?? { runId: take.run_id, shot, takes: [], createdAt: take.created_at, state: take.state };
      entry.takes.push(take);
      map.set(take.run_id, entry);
    }
  }
  for (const entry of map.values()) entry.state = aggregate(entry.takes.map((take) => take.state));
  return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function RunHistory() {
  const { project, selectShot, archivedRunIds, setRunArchived, deleteRuns } = useImageStudio();
  const navigate = useNavigate();
  const menuId = useId();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState<string | null>(null);
  const entries = runEntries(imageShots(project));
  const archivedCount = entries.filter((entry) => archivedRunIds.has(entry.runId)).length;
  const shown = showArchived ? entries : entries.filter((entry) => !archivedRunIds.has(entry.runId));
  const open = menu ? entries.find((entry) => entry.runId === menu.id) : undefined;
  const view = (entry: RunEntry) => selectShot(entry.shot.image_shot_id, entry.takes[0]?.take_id ?? null);
  const items: MenuItem[] = open
    ? [
        { id: "view", label: t("在監看器查看"), icon: Images, onSelect: () => view(open) },
        {
          id: "archive",
          label: archivedRunIds.has(open.runId) ? t("取消封存") : t("封存（檔案與紀錄保留）"),
          icon: archivedRunIds.has(open.runId) ? ArchiveRestore : Archive,
          disabledReason: open.state === "rendering" ? t("生成中的 run 不能封存") : archiving ? t("正在處理另一個封存") : null,
          onSelect: () => {
            setArchiving(open.runId);
            void setRunArchived(open.runId, !archivedRunIds.has(open.runId)).finally(() => setArchiving(null));
          },
        },
        { id: "records", label: t("在「紀錄・執行紀錄」開啟"), icon: ExternalLink, onSelect: () => void navigate(`/records/runs/${encodeURIComponent(open.runId)}`) },
        {
          id: "delete",
          label: t("永久刪除…"),
          icon: Trash2,
          tone: "danger",
          separatorBefore: true,
          disabledReason: open.state === "rendering" ? t("生成中的 run 不能刪除：先取消或等它結束") : null,
          onSelect: () => deleteRuns([open.runId]),
        },
      ]
    : [];
  return (
    <div className="grid gap-1 py-2">
      {archivedCount > 0 ? (
        <label className="pressable mx-1.5 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-caption text-fg-secondary hover:bg-raised has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
          <input type="checkbox" className="size-3.5 accent-action" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          <Archive aria-hidden className="size-3.5 text-fg-tertiary" />
          {t("顯示已封存（{archivedCount}）", { archivedCount })}
        </label>
      ) : null}
      {shown.length === 0 ? (
        <EmptyState icon={<History />} size="compact" title={entries.length === 0 ? t("還沒有生成紀錄") : t("紀錄都已封存")} description={t("每次按「生成」是一個 run；批次的多張圖共用同一個 run。")} />
      ) : (
        <ul aria-label={t("生成紀錄")} className="grid gap-0.5">
          {shown.map((entry, index) => {
            const archived = archivedRunIds.has(entry.runId);
            const seeds = entry.takes.map((take) => take.seed);
            return (
              <li key={entry.runId} ref={reveal(index)} className={"group group/tile flex items-center gap-1 px-1"}>
                <button
                  type="button"
                  onClick={() => view(entry)}
                  onKeyDown={(event) => {
                    if (!isMenuKey(event)) return;
                    event.preventDefault();
                    setMenu({ id: entry.runId, anchor: { kind: "element", element: event.currentTarget }, returnFocus: event.currentTarget, focus: "first" });
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ id: entry.runId, anchor: { kind: "point", x: event.clientX, y: event.clientY }, returnFocus: event.currentTarget, focus: "first" });
                  }}
                  title={t("在監看器查看；右鍵或 Shift+F10 開啟動作選單")}
                  className="grid min-w-0 flex-1 gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-(--duration-fast) outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus active:bg-sunken"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ImageThumb file={entry.takes.find((take) => take.state === "succeeded")?.image?.file} className="size-8 rounded-md" imgClassName={THUMB_ZOOM} />
                    <span className={cn("min-w-0 flex-1 truncate text-data", archived ? "text-fg-tertiary" : "text-fg")}>{`${entry.shot.title || t("未命名圖片")}${entry.takes.length > 1 ? t("・{takesCount} 張", { takesCount: entry.takes.length }) : ""}`}</span>
                    {archived ? <Archive aria-label={t("已封存")} className="size-3 shrink-0 text-fg-tertiary" /> : null}
                    <TakeStateMark state={entry.state} compact />
                  </span>
                  <span className="machine truncate pl-10 text-caption text-fg-tertiary">
                    {t("{createdAt}・{mode}・seed {value}", { createdAt: formatTimestamp(entry.createdAt), mode: MODE_LABELS[entry.shot.mode], value: seeds.length > 3 ? `${formatList(seeds.slice(0, 3))}…` : formatList(seeds) })}
                  </span>
                </button>
                <MenuTriggerButton
                  menuId={menuId}
                  open={menu?.id === entry.runId}
                  label={t("run {runId} 的動作", { runId: entry.runId.slice(0, 8) })}
                  onOpen={(element, focus) => setMenu({ id: entry.runId, anchor: { kind: "element", element }, returnFocus: element, focus })}
                  onClose={() => setMenu(null)}
                  className="size-7 [&_svg]:size-4"
                >
                  <Ellipsis aria-hidden />
                </MenuTriggerButton>
              </li>
            );
          })}
        </ul>
      )}
      {menu && open ? <ActionMenu id={menuId} label={t("run {runId} 的動作", { runId: open.runId.slice(0, 8) })} items={items} anchor={menu.anchor} returnFocus={menu.returnFocus} initialFocus={menu.focus} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

export function ShotsPanel({ onCollapse }: { onCollapse?: () => void }) {
  const { project } = useImageStudio();
  const [tab, setTab] = useState("shots");
  const enter = usePanelEnter<HTMLElement>(PANEL_NAMES.shots, "left");
  const shots = imageShots(project);
  const runCount = new Set(shots.flatMap((shot) => shot.takes.map((take) => take.run_id))).size;
  return (
    <section ref={enter} aria-label={t("圖片")} className={PANEL}>
      <PanelTabs
        variant="studio"
        idPrefix="image-shots"
        label={PANEL_NAMES.shots}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "shots", label: t("圖片"), icon: Images, count: shots.length },
          { id: "history", label: t("紀錄"), icon: History, count: runCount },
        ]}
        actions={onCollapse ? <PanelCollapseButton side="left" label={PANEL_NAMES.shots} onCollapse={onCollapse} /> : undefined}
      />
      <div role="tabpanel" id={`image-shots-panel-${tab}`} aria-labelledby={`image-shots-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {tab === "shots" ? <ShotList /> : <RunHistory />}
      </div>
    </section>
  );
}
