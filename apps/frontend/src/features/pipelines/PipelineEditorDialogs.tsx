// The pipeline editor's confirmations: delete the saved pipeline, save a draft that still has errors, leave with unsaved
// changes. Each one is explicit; nothing is retried automatically.
import { CircleAlert, Save, Trash2 } from "lucide-react";
import type { Blocker } from "react-router";
import { useDeletePipeline } from "@/api/pipelines";
import type { WirePipeline } from "@/api/types";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { leaveAfterDeleteError } from "./listNotice";
import type { PipelineIssue } from "./pipelineModel";
import { t } from "@/i18n";

export type ListLeaveState = ReturnType<typeof leaveAfterDeleteError>;

export function DeletePipelineDialog({
  open,
  onOpenChange,
  pipeline,
  dirty,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipeline: WirePipeline;
  dirty: boolean;
  /** Back to the list; `state` explains a pipeline that was already gone. */
  onDeleted: (state?: ListLeaveState) => void;
}) {
  const remove = useDeletePipeline();
  return (
    <Dialog open={open} onOpenChange={(next) => (remove.isPending ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("刪除元件組合「{value}」？", { value: pipeline.label || pipeline.pipeline_id })}</DialogTitle>
          <DialogDescription>{t("刪除主控上保存的元件組合定義；左欄與清單會立即移除它。已建立的 run 各自保有執行當時的副本，不受影響；這個動作無法復原。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-2">
          <p className="machine text-caption text-fg-tertiary">{pipeline.pipeline_id}</p>
          {dirty ? <p className="text-caption text-warning">{t("這個草稿還有未儲存的修改，會一起捨棄。")}</p> : null}
          {remove.isError ? <ErrorCallout error={remove.error} write title={t("沒有刪除")} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={() => onOpenChange(false)} disabled={remove.isPending}>
            {t("取消")}
          </Button>
          <Button
            variant="danger-confirm"
            icon={<Trash2 aria-hidden />}
            pending={remove.isPending}
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(pipeline.pipeline_id, {
                onSuccess: () => onDeleted(),
                // Already deleted elsewhere: useDeletePipeline drops it from the cache (this page unmounts next), so go
                // back to the list and explain it there.
                onError: (error) => {
                  const state = leaveAfterDeleteError(error, pipeline.pipeline_id);
                  if (state) onDeleted(state);
                },
              })
            }
          >
            {t("刪除元件組合")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SaveWithErrorsDialog({
  open,
  onOpenChange,
  errors,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  errors: readonly PipelineIssue[];
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("儲存有 {errorsCount} 個錯誤的元件組合？", { errorsCount: errors.length })}</DialogTitle>
          <DialogDescription>{t("草稿可以先儲存；但用它建立 run 時，伺服器會以 422 拒絕，直到這些問題修正。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-2">
          <ul className="grid gap-1 text-caption text-danger" aria-label={t("錯誤")}>
            {errors.slice(0, 8).map((issue, index) => (
              <li key={`${index}:${issue.message}`} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
                <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="machine text-fg-tertiary">{issue.code}</span> {issue.message}
                </span>
              </li>
            ))}
          </ul>
          {errors.length > 8 ? <p className="text-caption text-fg-tertiary">{t("另外還有 {errorsCount} 個，見底部「問題」。", { errorsCount: errors.length - 8 })}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("回去修正")}
          </Button>
          <Button variant="secondary" icon={<Save aria-hidden />} pending={pending} onClick={onConfirm}>
            {t("仍要儲存草稿")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveDraftDialog({ blocker }: { blocker: Blocker }) {
  return (
    <Dialog open={blocker.state === "blocked"} onOpenChange={(open) => (open ? undefined : blocker.reset?.())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("離開元件組合編輯？")}</DialogTitle>
          <DialogDescription>{t("草稿有未儲存的修改；離開會捨棄。")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-data text-fg-secondary">{t("已保存的元件組合與已建立的 run 不受影響。")}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={() => blocker.reset?.()}>
            {t("留在此頁")}
          </Button>
          <Button variant="danger" onClick={() => blocker.proceed?.()}>
            {t("捨棄並離開")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
