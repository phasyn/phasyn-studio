// One upload in a Studio's upload list: waiting / reading media facts / uploading / done / failed, the message or the
// error, a warning when the controller may already hold the file, and "upload again" for accepted files.
import { CircleX, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { toErrorInfo, writeOutcomeUnknown } from "@/lib/errors";
import { TOOL_BUTTON } from "@/components/ui/look";
import type { UploadTask } from "./useUploadQueue";
import { t } from "@/i18n";

export function UploadTaskRow<TInfo>({ task, icon, onRetry, onDismiss }: { task: UploadTask<TInfo>; icon: ReactNode; onRetry: () => void; onDismiss: () => void }) {
  const working = task.state === "waiting" || task.state === "reading" || task.state === "uploading";
  const info = (task.error != null) ? toErrorInfo(task.error) : null;
  const status = { waiting: t("等待中"), reading: t("讀取媒體資訊…"), uploading: t("上傳中…"), done: t("完成"), failed: t("失敗") }[task.state];
  return (
    <li className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2 rounded-md px-1.5 py-1 text-caption animate-rise-in">
      {working ? <LoaderCircle aria-hidden className="mt-0.5 size-3.5 text-info animate-spin" /> : task.state === "failed" ? <CircleX aria-hidden className="mt-0.5 size-3.5 text-danger" /> : icon}
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-fg" title={task.name}>
          {task.name}
        </span>
        <span className={cn(task.state === "failed" ? "text-danger" : task.state === "done" ? "text-success" : "text-fg-tertiary")}>
          {status}
          {(task.message != null && task.message !== "") ? t("：{message}", { message: task.message }) : ""}
          {info ? t("：{message}（{code}）", { message: info.message, code: info.code }) : ""}
        </span>
        {(task.error != null) && writeOutcomeUnknown(task.error) ? <span className="text-warning">{t("遠端結果未知：檔案可能已存到主控，但沒有加入素材庫；重新上傳會產生新的檔案。")}</span> : null}
      </span>
      <span className="flex items-center gap-0.5">
        {task.state === "failed" && task.retryable ? (
          <Button size="sm" variant="quiet" className="min-h-6 px-1.5" icon={<RotateCcw aria-hidden />} onClick={onRetry}>
            {t("重新上傳")}
          </Button>
        ) : null}
        {working ? null : (
          <button type="button" onClick={onDismiss} aria-label={t("移除「{name}」的上傳紀錄", { name: task.name })} className={cn(TOOL_BUTTON, "size-6 text-fg-tertiary")}>
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </span>
    </li>
  );
}
