// The shot action menu of the shot list and the delete confirmation. Actions only change the project document;
// removing a shot never deletes files on a Node or run records by itself. The focus goes back to the shot list, whose
// current shot follows the Studio's (a copy, or the neighbour of a deleted shot, becomes the current one).
import { ArrowDown, ArrowUp, CircleCheck, Clapperboard, Copy, Eye, EyeOff, MonitorPlay, SquarePen, Trash2, type LucideIcon } from "lucide-react";
import { useNavigate } from "react-router";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { MenuItem } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { useEditor } from "../editor/editorContext";
import { clipDuration } from "../editor/model";
import { withoutShot } from "../editor/shotRemoval";
import { filmOrder, shotClips } from "../editor/sources";
import { useShotActions } from "../hooks/useShotActions";
import { formatDuration } from "../model/frames";
import { neighbourShotId } from "../model/project";
import { deleteBlockedReason, shotMenuEntries, type ShotActionId, type ShotMenuEntry, type ShotMenuState } from "../model/shotActions";

const ICONS: Record<ShotActionId, LucideIcon> = {
  openSource: MonitorPlay,
  openInEdit: SquarePen,
  duplicate: Copy,
  moveEarlier: ArrowUp,
  moveLater: ArrowDown,
  toggleTimeline: EyeOff,
  useTake: CircleCheck,
  moreTakes: Clapperboard,
  delete: Trash2,
};

interface ShotMenuProps {
  menuId: string;
  onClose: () => void;
  onRequestDelete: (shotId: string) => void;
}

function OpenShotMenu({ menuId, menu, onClose, onRequestDelete }: ShotMenuProps & { menu: ShotMenuState }) {
  const { project, timeline } = useEditor();
  const actions = useShotActions();
  const navigate = useNavigate();
  const shot = project.shots.find((item) => item.shot_id === menu.shotId);
  if (!shot) return null;
  const shotId = shot.shot_id;
  const placed = filmOrder(project, timeline).placed;
  const position = placed.findIndex((item) => item.shot_id === shotId);
  const query = `project=${encodeURIComponent(project.project_id)}`;
  const handlers: Record<ShotActionId, (entry: ShotMenuEntry) => void> = {
    openSource: () => actions.openInSource(shotId),
    openInEdit: () => void navigate(`/studio/edit?${query}&shot=${encodeURIComponent(shotId)}`),
    duplicate: () => void actions.duplicate(shotId),
    moveEarlier: () => void actions.move(shotId, -1),
    moveLater: () => void actions.move(shotId, 1),
    toggleTimeline: () => void actions.setInTimeline(shotId, position < 0),
    useTake: (entry) => {
      if (entry.takeId) actions.useTake(shotId, entry.takeId);
    },
    moreTakes: (entry) => {
      const run = entry.runId ? `&run=${encodeURIComponent(entry.runId)}` : "";
      void navigate(`/studio/render?${query}${run}`);
    },
    delete: () => onRequestDelete(shotId),
  };
  const entries = shotMenuEntries({ project, shotId, position, placedCount: placed.length, alt: modifierLabel("Alt", detectApplePlatform()) });
  const items: MenuItem[] = entries.map((entry) => ({
    id: entry.takeId ? `${entry.id}:${entry.takeId}` : entry.id,
    label: entry.label,
    shortcut: entry.shortcut,
    disabledReason: entry.disabledReason,
    tone: entry.tone,
    separatorBefore: entry.separatorBefore,
    // The row's eye: an eye to put the shot on the timeline, a crossed-out eye to take it off
    icon: entry.id === "toggleTimeline" && position < 0 ? Eye : ICONS[entry.id],
    onSelect: () => handlers[entry.id](entry),
  }));
  return (
    <ActionMenu
      id={menuId}
      label={t("「{title}」的動作", { title: shot.title })}
      items={items}
      anchor={menu.anchor}
      returnFocus={menu.returnFocus}
      initialFocus={menu.focus}
      onClose={onClose}
    />
  );
}

/** The open shot menu; renders nothing while `menu` is null. */
export function ShotActionMenu({ menu, ...rest }: ShotMenuProps & { menu: ShotMenuState | null }) {
  return menu ? <OpenShotMenu key={menu.shotId} menu={menu} {...rest} /> : null;
}

/**
 * Confirms deleting a shot: says what leaves the timeline and which takes go; afterwards the neighbour becomes the
 * current shot and the focus goes back to the list (onFocusList).
 */
export function DeleteShotDialog({ shotId, onClose, onFocusList }: { shotId: string | null; onClose: () => void; onFocusList: () => void }) {
  const { project, timeline, fps, deleteRuns } = useEditor();
  const actions = useShotActions();
  const shot = shotId ? project.shots.find((item) => item.shot_id === shotId) : undefined;
  const clips = shot ? shotClips(timeline, shot.shot_id) : [];
  const frames = clips.filter((clip) => timeline.tracks.find((track) => track.track_id === clip.track_id)?.kind === "video").reduce((sum, clip) => sum + clipDuration(clip), 0);
  // A locked track keeps its clips: say so before anything is removed
  const removal = shot && project.timeline ? withoutShot(project.timeline, shot.shot_id) : null;
  const blocked = shot ? (deleteBlockedReason(shot) ?? (removal && !removal.ok ? t("時間軸上這個鏡頭的片段無法移除：{reason}", { reason: removal.error }) : null)) : null;
  const runIds = shot ? [...new Set(shot.takes.map((take) => take.run_id))] : [];
  // A duplicated shot shares its runs: deleting the videos takes those takes away from it too
  const sharing = shot
    ? project.shots.filter((other) => other.shot_id !== shot.shot_id && other.takes.some((take) => runIds.includes(take.run_id))).map((other) => other.title || other.shot_id)
    : [];
  const removeOnly = () => {
    if (!shot || blocked) return;
    actions.remove(shot.shot_id);
    onClose();
  };
  const removeWithMedia = () => {
    if (!shot || blocked) return;
    const order = filmOrder(project, timeline).placed;
    const at = order.findIndex((item) => item.shot_id === shot.shot_id);
    const next = (at >= 0 ? (order[at + 1] ?? order[at - 1])?.shot_id : undefined) ?? neighbourShotId(project, shot.shot_id);
    onClose();
    deleteRuns(runIds, { removeShotId: shot.shot_id, nextShotId: next });
  };
  return (
    <Dialog
      open={Boolean(shot)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {shot ? (
        <DialogContent
          onKeyDown={(event) => event.stopPropagation()}
          // Opened from the list (its menu or Delete): the focus goes back there, also when the shot is gone
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onFocusList();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("刪除鏡頭「{title}」？", { title: shot.title })}</DialogTitle>
            <DialogDescription>
              {runIds.length > 0
                ? t("會一併永久刪除這個鏡頭的 {takesCount} 個 take 的影片、中間檔與效能紀錄（{runIdsCount} 個 run）；下一步先試算並列出影響範圍。只想收起來請改用 take 的「封存」或「移出時間軸」。", { takesCount: shot.takes.length, runIdsCount: runIds.length })
                : t("這個鏡頭還沒有任何 take，刪除只會把鏡頭從專案移除。")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-line-subtle bg-canvas/60 px-3 py-2 text-data">
              <dt className="text-fg-tertiary">{t("時間軸")}</dt>
              <dd className="text-fg">
                {clips.length > 0
                  ? t("{clipsCount} 個片段・{duration}；刪除後後面的片段會往前接上", { clipsCount: clips.length, duration: formatDuration(frames, fps) })
                  : t("不在時間軸上")}
              </dd>
              <dt className="text-fg-tertiary">Takes</dt>
              <dd className="text-fg">{shot.takes.length > 0 ? t("{takesCount} 個（影片會一起永久刪除）", { takesCount: shot.takes.length }) : t("沒有")}</dd>
              {sharing.length > 0 ? (
                <>
                  <dt className="text-warning">{t("共用")}</dt>
                  <dd className="text-warning [overflow-wrap:anywhere]">{t("「{sharing}」與它共用影片，刪除後也會失去這些 take", { sharing: sharing.join(t("」「")) })}</dd>
                </>
              ) : null}
              {shot.prompt.trim() ? (
                <>
                  <dt className="text-fg-tertiary">Prompt</dt>
                  <dd className="line-clamp-2 text-fg-secondary [overflow-wrap:anywhere]">{shot.prompt}</dd>
                </>
              ) : null}
            </dl>
            {blocked ? <p className="text-data text-warning">{blocked}</p> : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{t("取消")}</Button>
            </DialogClose>
            {runIds.length > 0 ? (
              <>
                <Button variant="quiet" disabled={Boolean(blocked)} title={blocked ?? t("只把鏡頭從專案移除；影片、run 與紀錄保留，可在「紀錄・執行紀錄」找到或之後刪除")} onClick={removeOnly}>
                  {t("只移除鏡頭（保留影片）")}
                </Button>
                <Button variant="danger-confirm" icon={<Trash2 aria-hidden />} disabled={Boolean(blocked)} title={blocked ?? undefined} onClick={removeWithMedia}>
                  {t("刪除鏡頭與影片…")}
                </Button>
              </>
            ) : (
              <Button variant="danger-confirm" icon={<Trash2 aria-hidden />} disabled={Boolean(blocked)} title={blocked ?? undefined} onClick={removeOnly}>
                {t("刪除鏡頭")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
