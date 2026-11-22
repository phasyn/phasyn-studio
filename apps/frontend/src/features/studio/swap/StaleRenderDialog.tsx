// 重新渲染設定已改的段落 (the one-click swap panel): the segments whose prompt, references or settings changed after their
// take, each with what changed and the take it uses now, chosen one by one (all at first). It renders the chosen ones as
// one batch, like the next batch (the same per-run limit, batch size and preflight reason); a new take becomes the one in
// use when it finishes and the old one stays in the take strip, so the dialog says so before anything is sent. Mounted
// once per opening (the panel keys it), so every opening starts with all of them chosen.
// Keyboard: the first checkbox has the focus; Ctrl/⌘+Enter renders; Esc cancels. Motion: the shared dialog entrance and
// exit; the rows rise in one after another; the footer's status fades when it changes.
import { RotateCcw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reveal, useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { activeTake, changedSinceTake } from "../model/project";
import { takeNumber } from "../model/takeDownload";
import { useStudio } from "../studioContext";

export interface StaleRenderDialogProps {
  open: boolean;
  /** The segments rendered before their settings changed (shot ids, film order). */
  shotIds: readonly string[];
  /** The batch the chosen segments make (per-run limit and batch size, like the next batch). */
  batchOf: (shotIds: string[]) => string[];
  /** Why that batch cannot be sent now; null when it can. */
  reasonOf: (shotIds: string[]) => string | null;
  onRender: (shotIds: string[]) => void;
  onClose: () => void;
}

export function StaleRenderDialog({ open, shotIds, batchOf, reasonOf, onRender, onClose }: StaleRenderDialogProps) {
  const { project } = useStudio();
  const contentRef = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(shotIds));
  const rows = useMemo(
    () =>
      shotIds.flatMap((shotId) => {
        const shot = project.shots.find((item) => item.shot_id === shotId);
        if (!shot) return [];
        const take = activeTake(shot);
        return [{ shot, changes: take ? changedSinceTake(take, shot, project) : [], takeNumber: take ? takeNumber(shot, take) : null }];
      }),
    [project, shotIds],
  );
  const picked = rows.flatMap((row) => (chosen.has(row.shot.shot_id) ? [row.shot.shot_id] : []));
  const batch = batchOf(picked);
  const reason = picked.length === 0 ? t("勾選要重新渲染的段落") : reasonOf(batch);
  const status =
    reason ??
    (batch.length < picked.length
      ? t("這次渲染前 {batchCount} 段，其餘 {rest} 段下一批再送", { batchCount: batch.length, rest: picked.length - batch.length })
      : t("會重新渲染 {count} 段", { count: batch.length }));
  const statusRef = useChangeFade<HTMLParagraphElement>(status);
  const shortcut = t("{key}+Enter 渲染・Esc 取消", { key: modifierLabel("Mod", detectApplePlatform()) });

  const toggle = (shotId: string, on: boolean) => { setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(shotId);
      else next.delete(shotId);
      return next;
    }); };
  const render = () => {
    if (reason !== null) return;
    onRender(batch);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          // The first segment's checkbox, so Space and Tab work through the list right away
          const first = contentRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]');
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
          event.preventDefault();
          render();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw aria-hidden className="size-4 text-brand-cyan" />
            {t("重新渲染設定已改的段落")}
          </DialogTitle>
          <DialogDescription>
            {t("這些段落渲染後又改了 prompt、參考或設定。勾選要重新渲染的段落：新 take 完成後會成為使用中，原本的 take 留在 take 列，可以隨時換回或比對。")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid content-start gap-0.5">
          <div className="flex items-center gap-2 pb-1 text-caption">
            <Button size="sm" variant="quiet" className="min-h-7 px-2" onClick={() => { setChosen(new Set(shotIds)); }}>
              {t("全選")}
            </Button>
            <Button size="sm" variant="quiet" className="min-h-7 px-2" onClick={() => { setChosen(new Set()); }}>
              {t("全不選")}
            </Button>
          </div>
          {rows.map((row, index) => (
            <div key={row.shot.shot_id} ref={reveal(index)} className={cn("rounded-md px-2", chosen.has(row.shot.shot_id) ? "bg-brand-soft/40" : "")}>
              <Checkbox
                checked={chosen.has(row.shot.shot_id)}
                onChange={(event) => { toggle(row.shot.shot_id, event.target.checked); }}
                label={row.shot.title}
                description={[
                  row.changes.length > 0 ? t("已變更：{changes}", { changes: formatList(row.changes) }) : null,
                  row.takeNumber === null ? null : t("使用中：take {number}", { number: row.takeNumber }),
                ]
                  .filter(Boolean)
                  .join(t("・"))}
                className="py-1.5"
              />
            </div>
          ))}
        </DialogBody>
        {/* The status on a row of its own: a reason such as a batch still rendering is a full sentence */}
        <DialogFooter className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-2">
          <p ref={statusRef} role="status" aria-live="polite" className={cn("col-span-3 text-caption [overflow-wrap:anywhere]", reason === null ? "text-fg" : "text-fg-tertiary")}>
            {status}
          </p>
          <span className="min-w-0 truncate text-caption text-fg-tertiary">{shortcut}</span>
          <DialogClose asChild>
            <Button>{t("取消")}</Button>
          </DialogClose>
          <ActionButton variant="primary" icon={<RotateCcw aria-hidden />} disabledReason={reason} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={render}>
            {batch.length > 0 ? t("重新渲染 {count} 段", { count: batch.length }) : t("重新渲染")}
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
