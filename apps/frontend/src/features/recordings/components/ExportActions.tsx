// Exports: JSONL, CSV and the diagnostic ZIP download straight from the server (streamed, never held by the page); the
// trace is requested first to confirm it exists (404 → "no trace"), and a large one is handed to the browser instead.
// Redaction is opt-in (default off) and applies to the downloaded copy only; the server refuses it for traces and leaves
// them out of a redacted ZIP.
import { useMutation } from "@tanstack/react-query";
import { FileArchive, FileBraces, FileCode, FileSpreadsheet } from "lucide-react";
import { useId, useState } from "react";
import { exportUrl } from "@/api/http";
import { ActionButton } from "@/components/common/ActionButton";
import { buttonVariants } from "@/components/ui/variants";
import { cn } from "@/lib/cn";
import { fetchTrace, isTraceMissing } from "../api";
import { downloadBlob } from "@/lib/download";
import { REDACT_FIELDS, REDACT_LABELS, redactQuery, safeFilePart, type RedactField } from "../model/download";
import { describeError } from "../model/errors";
import { t } from "@/i18n";

const linkClass = cn(buttonVariants({ variant: "secondary", size: "sm" }), "pressable no-underline pointer-coarse:min-h-11");

function clickDownload(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function ExportActions({ recordingId, traceExpected }: { recordingId: string; traceExpected: boolean }) {
  const statusId = useId();
  const redactId = useId();
  const [chosen, setChosen] = useState<ReadonlySet<RedactField>>(() => new Set());
  const redact = redactQuery(chosen);
  const trace = useMutation({
    mutationFn: () => fetchTrace(recordingId),
    retry: false,
    onSuccess: (result) => {
      if (result.kind === "blob") downloadBlob(`trace-${safeFilePart(recordingId)}.json`, result.blob);
      else clickDownload(exportUrl(recordingId, "trace"));
    },
  });
  const traceMissing = trace.isError && isTraceMissing(trace.error);
  const toggle = (field: RedactField, on: boolean) => { setChosen((previous) => {
      const next = new Set(previous);
      if (on) next.add(field);
      else next.delete(field);
      return next;
    }); };
  return (
    <div className="grid gap-2">
      <fieldset className="grid gap-1" aria-describedby={redactId}>
        <legend className="mb-0.5 text-caption font-medium text-fg-secondary">{t("遮蔽（只套用在下載的副本）")}</legend>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {REDACT_FIELDS.map((field) => (
            <label key={field} className="inline-flex min-h-7 items-center gap-1.5 text-caption text-fg-secondary pointer-coarse:min-h-11">
              <input type="checkbox" className="size-3.5 accent-action" checked={chosen.has(field)} onChange={(event) => { toggle(field, event.target.checked); }} />
              {REDACT_LABELS[field]}
            </label>
          ))}
        </div>
        <p id={redactId} className="text-caption text-fg-tertiary">
          {t("預設不遮蔽。分享給別人前建議全部勾選：主機名稱、裝置 ID 與 prompt 會被替換，路徑只留檔名；紀錄本身不變。遮蔽時診斷 ZIP 不含 trace。")}
        </p>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("匯出")}>
        <a href={exportUrl(recordingId, "jsonl", redact)} download className={linkClass} title={t("完整事件（context、event、summary）JSON Lines")}>
          <FileBraces aria-hidden />
          JSONL
        </a>
        <a href={exportUrl(recordingId, "csv", redact)} download className={linkClass} title={t("metric 長表（單位明列，字串已防公式）")}>
          <FileSpreadsheet aria-hidden />
          CSV
        </a>
        <a href={exportUrl(recordingId, "zip", redact)} download className={linkClass} title={t("context、summary、各 stream 事件、設定差異、可用的 trace 與 README")}>
          <FileArchive aria-hidden />
          {t("診斷 ZIP")}
        </a>
        <ActionButton
          size="sm"
          icon={<FileCode aria-hidden />}
          onClick={() => { trace.mutate(); }}
          pending={trace.isPending}
          disabledReason={redact.length > 0 ? t("trace 不支援遮蔽：取消勾選遮蔽後才能下載") : null}
          aria-describedby={statusId}
          className="pointer-coarse:min-h-11"
        >
          trace
        </ActionButton>
      </div>
      <p id={statusId} className="text-caption text-fg-tertiary" aria-live="polite">
        {trace.isPending
          ? t("確認 trace 是否存在…")
          : traceMissing
            ? t("此 recording 沒有 trace。")
            : trace.isError
              ? t("trace 下載失敗：{headline}", { headline: describeError(trace.error).headline })
              : trace.isSuccess
                ? trace.data.kind === "blob"
                  ? t("trace 已下載（Chrome trace JSON，可離線交給相容 viewer）。")
                  : t("trace 檔案較大，已改由瀏覽器直接下載。")
                : traceExpected
                  ? t("下載只存到本機；不會上傳到外部分析服務。")
                  : t("recorder 模式不是 trace，通常沒有 trace 檔。下載只存到本機。")}
      </p>
    </div>
  );
}
