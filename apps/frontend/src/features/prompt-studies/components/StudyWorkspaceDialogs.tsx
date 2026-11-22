// The study workspace's confirmations: dropping an unsaved scene draft to switch versions, and leaving the study while a
// draft is unsaved or a step is running.
import type { Blocker } from "react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { versionLabel } from "../model/study";
import type { PromptStudy } from "../types";
import { t } from "@/i18n";

export function VersionSwitchDialog({ study, switchTo, onCancel, onConfirm }: { study: PromptStudy; switchTo: string | null; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Dialog open={switchTo !== null} onOpenChange={(next) => { if (!(next)) { onCancel(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("捨棄未儲存的修改？")}</DialogTitle>
          <DialogDescription>{t("切換到 {value} 會捨棄目前場景的修改（已儲存的版本不受影響）。", { value: (switchTo != null && switchTo !== "") ? versionLabel(study, switchTo) : t("另一個版本") })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="quiet" onClick={onCancel}>
            {t("留在目前版本")}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {t("捨棄並切換")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveStudyDialog({ blocker, dirty, busy }: { blocker: Blocker; dirty: boolean; busy: boolean }) {
  return (
      <Dialog open={blocker.state === "blocked"} onOpenChange={(next) => (next ? undefined : blocker.reset?.())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("離開這個研究？")}</DialogTitle>
            <DialogDescription>{dirty ? t("場景有未儲存的修改，離開會捨棄。") : t("正在執行任務的一步。")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-2 text-data text-fg-secondary">
            {busy ? <p>{t("離開只會停止等待：已送出的 run 仍在主控上執行，回來後按「執行下一步」會先讀回它的結果，不會重送。")}</p> : null}
            <p>{t("已保存的版本、任務與圖片都不受影響。")}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="quiet" onClick={() => blocker.reset?.()}>
              {t("留在此頁")}
            </Button>
            <Button variant="danger" onClick={() => blocker.proceed?.()}>
              {t("離開")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
