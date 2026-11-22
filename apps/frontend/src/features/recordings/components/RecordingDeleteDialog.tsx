// Deleting a recording (the Controller's copy): after the confirmation it is deleted and the page returns to the list.
// The Node's own records stay, and the dialog names where they can be fetched back: the recording's page ("Fetch from
// Node" under "recording not found") and, for a run's recording, the run page ("Query Node-local records").
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { contractJson } from "@/api/http";
import { recordingApiPath } from "@/api/recordings";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { shortId } from "@/lib/format";
import { recordingKeys } from "../api";
import { CopyButton } from "./Feedback";
import { PATHS, runPath } from "@/app/paths";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export function RecordingDeleteButton({ recordingId, runId, label }: { recordingId: string; runId: string | null; label: string }) {
  const [open, setOpen] = useState(false);
  // The safe choice takes focus first (the run link and the copy button come before it in the dialog)
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => contractJson("DeletedRecording", recordingApiPath(recordingId), { method: "DELETE" }),
    retry: false,
    onSuccess: () => {
      client.removeQueries({ queryKey: recordingKeys.detail(recordingId) });
      void client.invalidateQueries({ queryKey: recordingKeys.all });
      setOpen(false);
      void navigate(PATHS.recordings, { replace: true });
    },
  });
  return (
    <>
      <Button size="sm" variant="danger" icon={<Trash2 aria-hidden />} onClick={() => { setOpen(true); }}>
        {t("刪除")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (!(remove.isPending)) { setOpen(next); } }}>
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelButtonRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("刪除效能紀錄「{label}」？", { label })}</DialogTitle>
            <DialogDescription>
              {t("刪除主控上的這筆 recording（索引、事件、trace 檔）。Node 本機的原始紀錄仍保留，之後可以從 Node 補回；若 Node 還在上報同一筆紀錄，它會再次出現。要連同影片與中間檔一起刪除，請到「執行紀錄」刪除整個 run。")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-2">
            <p className="text-caption text-fg-secondary">{t("刪除後從 Node 補回的入口：")}</p>
            <ul className="grid list-disc gap-1 pl-5 text-caption text-fg-secondary">
              {(runId != null && runId !== "") ? (
                <li>
                  <T source={"所屬 run <0>{runId}</0> 的頁面：會列出主控缺少的紀錄，用「查詢 Node 本機紀錄」補回。"} values={{ runId: shortId(runId) }} slots={[<Link key="slot-0" to={runPath(runId)} className="machine" />]} />
                </li>
              ) : null}
              <li>{t("這筆紀錄的頁面（ID 見下方，可複製）：會顯示「找不到此 recording」，用「從 Node 補抓」補回。")}</li>
            </ul>
            <p className="flex min-w-0 items-center gap-1">
              <code className="machine min-w-0 text-caption break-all text-fg-tertiary">{recordingId}</code>
              <CopyButton text={recordingId} label={t("複製 recording ID")} />
            </p>
            {remove.isError ? <ErrorCallout error={remove.error} write title={t("沒有刪除")} /> : null}
          </DialogBody>
          <DialogFooter>
            <Button ref={cancelButtonRef} variant="quiet" onClick={() => { setOpen(false); }} disabled={remove.isPending}>
              {t("取消")}
            </Button>
            <Button variant="danger-confirm" icon={<Trash2 aria-hidden />} pending={remove.isPending} onClick={() => { remove.mutate(); }}>
              {t("刪除紀錄")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
