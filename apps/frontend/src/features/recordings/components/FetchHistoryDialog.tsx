// 「讀取此 Node 歷史紀錄」：明確的一次 HTTP 補抓，只把 Node 本地已寫的 log／事件補進主控索引。
// 不會重新執行、派送、重試或恢復任何工作，也不改 run 狀態；失敗不自動重送。
import { CircleCheck, DatabaseBackup, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type { Recording } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { useEventStreams, useFetchHistory } from "../api";
import { describeError } from "../model/errors";
import { t, tServer } from "@/i18n";

export function FetchHistoryDialog({ recording, nodeLabel }: { recording: Recording; nodeLabel: string | null }) {
  const id = recording.context.recording_id;
  const nodeId = recording.context.node_id;
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [streamId, setStreamId] = useState("");
  const [afterSeq, setAfterSeq] = useState("0");
  const [seqError, setSeqError] = useState<string | null>(null);
  const streams = useEventStreams(id, open);
  const mutation = useFetchHistory(id);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) return;
    const trimmed = afterSeq.trim();
    const parsed = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      setSeqError(t("after_seq 必須是 0 以上的整數"));
      return;
    }
    setSeqError(null);
    mutation.mutate({ node_id: nodeId, ...(streamId ? { stream_id: streamId } : {}), after_seq: parsed });
  };

  const errorInfo = mutation.isError ? describeError(mutation.error) : null;
  const outcomeUnknown = errorInfo !== null && (errorInfo.remoteUnknown || errorInfo.status === null || errorInfo.status >= 500);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && !mutation.isPending) mutation.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" icon={<DatabaseBackup aria-hidden />} disabled={!nodeId} title={!nodeId ? t("context 沒有 node_id，無法指定要讀取的 Node") : undefined} className="pointer-coarse:min-h-11">
          {t("讀取此 Node 歷史紀錄")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("讀取此 Node 歷史紀錄")}</DialogTitle>
          <DialogDescription>
            {t("只從 Node 讀回它本地已寫入的 log 與事件，去重後補進主控的紀錄索引。不會重新執行、派送、重試或恢復任何工作，也不改變 run 的狀態。")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <form id={formId} onSubmit={submit} className="grid gap-4" noValidate>
            <div className="grid gap-1 text-data">
              <span className="text-fg-tertiary">Node</span>
              <span className="text-fg">
                {nodeLabel ?? t("（名稱未知）")} <code className="machine text-caption text-fg-tertiary">{nodeId || "—"}</code>
              </span>
            </div>
            <Field id={`${formId}-stream`} label="stream" help={t("不指定時由 Node 補抓此 recording 的所有 stream。")}>
              {(describedBy) => (
                <Select id={`${formId}-stream`} value={streamId} onChange={(event) => setStreamId(event.target.value)} aria-describedby={describedBy}>
                  <option value="">{t("全部 stream")}</option>
                  {(streams.data?.streams ?? []).map((stream) => (
                    <option key={stream.stream_id} value={stream.stream_id}>
                      {stream.stream_id}
                      {t("（主控目前至 seq {last_seq}）", { last_seq: stream.last_seq })}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id={`${formId}-after`} label="after_seq" help={t("只補抓這個 seq 之後的事件；0 表示從頭。")} error={seqError}>
              {(describedBy) => (
                <Input
                  id={`${formId}-after`}
                  inputMode="numeric"
                  value={afterSeq}
                  onChange={(event) => setAfterSeq(event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={seqError ? true : undefined}
                  className="machine"
                />
              )}
            </Field>
          </form>
          {mutation.isSuccess ? (
            <Callout tone={mutation.data.still_partial ? "warning" : "success"} icon={mutation.data.still_partial ? <TriangleAlert /> : <CircleCheck />} title={t("已匯入 {imported_events} 筆事件", { imported_events: mutation.data.imported_events.toLocaleString("en-US") })} role="status" className="animate-rise-in">
              {mutation.data.still_partial ? <p>{t("仍有缺段：Node 端也沒有或無法讀取這些 seq；缺段會繼續標示，不補資料。")}</p> : <p>{t("主控索引已更新；頁面已重新讀取此 recording。")}</p>}
              {mutation.data.message ? <p className="text-fg-secondary">{tServer(mutation.data.message)}</p> : null}
            </Callout>
          ) : null}
          {errorInfo ? (
            <Callout tone="danger" title={errorInfo.headline} role="alert" className="animate-rise-in">
              {errorInfo.serverMessage ? <p>{errorInfo.serverMessage}</p> : null}
              <p className="machine text-caption text-fg-tertiary">
                {errorInfo.code}
                {errorInfo.status ? ` · HTTP ${errorInfo.status}` : ""}
              </p>
              {outcomeUnknown ? <p className="text-warning">{t("遠端結果未知：補抓可能已在 Node 端完成。可關閉後重新讀取事件確認；不會自動重送。")}</p> : null}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button>{t("關閉")}</Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" pending={mutation.isPending} disabled={!nodeId || mutation.isPending}>
            {t("開始補抓")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
