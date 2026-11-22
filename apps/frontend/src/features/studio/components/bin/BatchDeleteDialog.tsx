// Confirms deleting several selected shots. A shot that is rendering stays (its result would have nowhere to land), and
// so does one whose clips sit on a locked track; the dialog names them and why. The others leave the project together:
// their clips leave the timeline (the following clips close up) and, as when one shot is deleted, the edit history
// starts over. Their videos, runs and records are kept: deleting videos as well goes shot by shot through a shot's
// 「刪除鏡頭…」, the flow that first works out what else uses each run.
import { Trash2 } from "lucide-react";
import { useRef } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { useEditor } from "../../editor/editorContext";
import { clipDuration } from "../../editor/model";
import { withoutShot } from "../../editor/shotRemoval";
import { shotClips } from "../../editor/sources";
import { formatDuration } from "../../model/frames";
import { deleteBlockedReason } from "../../model/shotActions";

export interface BatchDeleteDialogProps {
  /**
   * The selected shots to delete (list order); null while closed. They are read from the project on every render, so a
   * shot that starts rendering (or is deleted elsewhere) while the dialog is open is judged as it is now.
   */
  shotIds: readonly string[] | null;
  onClose: () => void;
  /** After the shots left the project, with their ids (the list picks the next current shot and takes the focus). */
  onRemoved: (shotIds: readonly string[]) => void;
  /** Where the focus goes once the shots are gone (the button that opened the dialog went with the selection). */
  onFocusList: () => void;
}

interface Kept {
  shot: StudioShot;
  reason: string;
}

export function BatchDeleteDialog({ shotIds, onClose, onRemoved, onFocusList }: BatchDeleteDialogProps) {
  const { project, timeline, fps, dispatch, notify } = useEditor();
  const removedRef = useRef(false);
  const kept: Kept[] = [];
  const removable: StudioShot[] = [];
  const shots = (shotIds ?? []).flatMap((shotId) => project.shots.filter((shot) => shot.shot_id === shotId));
  for (const shot of shots) {
    const removal = project.timeline ? withoutShot(project.timeline, shot.shot_id) : null;
    const reason = deleteBlockedReason(shot) ?? (removal && !removal.ok ? t("時間軸上這個鏡頭的片段無法移除：{reason}", { reason: removal.error }) : null);
    if (reason != null && reason !== "") kept.push({ shot, reason });
    else removable.push(shot);
  }
  const clips = removable.flatMap((shot) => shotClips(timeline, shot.shot_id));
  const frames = clips.filter((clip) => timeline.tracks.find((track) => track.track_id === clip.track_id)?.kind === "video").reduce((sum, clip) => sum + clipDuration(clip), 0);
  const takes = removable.reduce((sum, shot) => sum + shot.takes.length, 0);
  const remove = () => {
    if (removable.length === 0) return;
    for (const shot of removable) dispatch({ type: "removeShot", shotId: shot.shot_id });
    notify({ tone: "success", title: t("已移除 {count} 個鏡頭", { count: removable.length }) });
    removedRef.current = true;
    onRemoved(removable.map((shot) => shot.shot_id));
    onClose();
  };
  return (
    <Dialog
      open={shotIds !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {shotIds ? (
        <DialogContent
          onKeyDown={(event) => { event.stopPropagation(); }}
          onCloseAutoFocus={(event) => {
            if (!removedRef.current) return;
            removedRef.current = false;
            event.preventDefault();
            onFocusList();
          }}
        >
          <DialogHeader>
            <DialogTitle>{removable.length > 0 ? t("刪除 {count} 個鏡頭？", { count: removable.length }) : t("選取的鏡頭都不能刪除")}</DialogTitle>
            <DialogDescription>
              {takes > 0
                ? t("鏡頭會從專案移除；它們的 {takesCount} 個 take 的影片、run 與紀錄保留，可在「紀錄・執行紀錄」找到或之後刪除。要連影片一起永久刪除，請用鏡頭選單的「刪除鏡頭…」逐一刪除。", { takesCount: takes })
                : t("這些鏡頭還沒有任何 take，刪除只會把鏡頭從專案移除。")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-line-subtle bg-canvas/60 px-3 py-2 text-data">
              <dt className="text-fg-tertiary">{t("鏡頭")}</dt>
              <dd className="line-clamp-3 text-fg [overflow-wrap:anywhere]">{formatList(removable.map((shot) => shot.title || t("未命名鏡頭")))}</dd>
              <dt className="text-fg-tertiary">{t("時間軸")}</dt>
              <dd className="text-fg">
                {clips.length > 0 ? t("{clipsCount} 個片段・{duration}；刪除後後面的片段會往前接上", { clipsCount: clips.length, duration: formatDuration(frames, fps) }) : t("不在時間軸上")}
              </dd>
              {kept.length > 0 ? (
                <>
                  <dt className="text-warning">{t("保留")}</dt>
                  <dd className="grid gap-0.5 text-warning [overflow-wrap:anywhere]">
                    {kept.map(({ shot, reason }) => (
                      <span key={shot.shot_id}>{t("{label}：{detail}", { label: shot.title || t("未命名鏡頭"), detail: reason })}</span>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{t("取消")}</Button>
            </DialogClose>
            <Button
              variant="danger-confirm"
              icon={<Trash2 aria-hidden />}
              disabled={removable.length === 0}
              title={removable.length === 0 ? t("選取的鏡頭都不能刪除") : undefined}
              onClick={remove}
            >
              {takes > 0 ? t("移除 {count} 個鏡頭（保留影片）", { count: removable.length }) : t("刪除 {count} 個鏡頭", { count: removable.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
