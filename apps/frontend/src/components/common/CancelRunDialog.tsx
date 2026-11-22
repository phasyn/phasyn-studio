import { hasSlotContent } from "@/lib/dom";
// Confirming the cancellation of one run, shared by the shell's active-run chip, Video Studio and the run pages.
// One click sends one POST /api/runs/{id}/cancel (never retried automatically; a click while it is in flight does
// nothing); the server's answer shows as accepted or not accepted, and a failed request as a write error.
import { Ban } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { useCancelRun } from "@/api/runs";
import type { WireRun } from "@/api/types";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { runDisplayName } from "@/lib/runName";
import { t, tServer } from "@/i18n";

export interface CancelRunDialogProps {
  run: WireRun;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One extra line about what stops with the run (for example every shot of a batch). */
  scope?: ReactNode;
  /**
   * Focus when the dialog has closed (DialogContent's onCloseAutoFocus). By default it returns to the control that
   * opened the dialog; a caller whose control can leave the page with the run calls preventDefault and moves focus.
   */
  onCloseAutoFocus?: (event: Event) => void;
}

export function CancelRunDialog({ run, open, onOpenChange, scope, onCloseAutoFocus }: CancelRunDialogProps) {
  const cancel = useCancelRun(run.run_id);
  const inFlightRef = useRef(false);
  const label = runDisplayName(run);
  const send = () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    cancel.mutate(undefined, {
      onSettled: () => {
        inFlightRef.current = false;
      },
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("取消 run「{label}」？", { label })}</DialogTitle>
          <DialogDescription>{t("進行中的步驟會被中止（只結束這個 run 呼叫的元件程序），run 會變成「已取消」；不會自動重跑，已完成步驟的輸出保留。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          {hasSlotContent(scope) ? <p className="text-data text-fg-secondary">{scope}</p> : null}
          <p className="machine text-caption text-fg-tertiary">{run.run_id}</p>
          {cancel.isSuccess ? (
            <Callout tone={cancel.data.accepted ? "info" : "warning"} title={cancel.data.accepted ? t("已受理取消") : t("取消未受理")}>
              <p>{tServer(cancel.data.message)}</p>
            </Callout>
          ) : null}
          {cancel.isError ? <ErrorCallout error={cancel.error} write title={t("取消請求失敗")} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={() => { onOpenChange(false); }}>
            {cancel.isSuccess ? t("關閉") : t("不要取消")}
          </Button>
          {cancel.isSuccess ? null : (
            <Button variant="danger" icon={<Ban aria-hidden />} pending={cancel.isPending} onClick={send}>
              {t("取消 run")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
