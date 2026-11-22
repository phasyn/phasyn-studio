// When the Controller lacks some steps' recordings (never received after an interruption or a lost reply, or deleted on
// the Controller), the Node may still hold them locally. This panel does only what the user explicitly asks: a read-only
// query of the Node's records of the run (by run_id) and backfilling a chosen recording into the Controller index. It
// never resends an invoke, resumes the run or changes its state. "On Controller" follows the Controller index, not
// run.recording_ids (deleting a recording leaves the run document as it is).
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, ExternalLink, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { qk } from "@/api/keys";
import { fetchNodeRecordingPage, fetchRecordingHistory } from "@/api/recordings";
import type { RunStepView, WireRun } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { IdText, TimeText } from "@/components/common/values";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { buttonVariants } from "@/components/ui/variants";
import { recordingPath } from "@/app/paths";
import { t } from "@/i18n";

/**
 * One Node-local recording: a link when the Controller index lists it, else an explicit backfill (sent once, never
 * retried). Once backfilled, its result stays in place even after the index lists the recording.
 */
function RecordingAction({ recordingId, nodeId, indexed }: { recordingId: string; nodeId: string; indexed: boolean }) {
  const client = useQueryClient();
  const openLinkRef = useRef<HTMLAnchorElement>(null);
  const mutation = useMutation({
    mutationFn: () => fetchRecordingHistory(recordingId, { node_id: nodeId }),
    retry: false,
    onSuccess: () => client.invalidateQueries({ queryKey: qk.recordings() }),
  });
  // The pressed button gives way to the result: focus that fell to the page moves to its link
  useEffect(() => {
    if (mutation.isSuccess && (document.activeElement === null || document.activeElement === document.body)) openLinkRef.current?.focus();
  }, [mutation.isSuccess]);
  if (mutation.isSuccess) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone={mutation.data.still_partial ? "warning" : "success"}>
          {t("{value} · {imported_events} 筆事件", { value: mutation.data.still_partial ? t("已補抓（仍有缺段）") : t("已補抓"), imported_events: mutation.data.imported_events })}
        </Badge>
        <Link ref={openLinkRef} to={recordingPath(recordingId)} className={buttonVariants({ variant: "quiet", size: "sm" })}>
          <ExternalLink aria-hidden />
          {t("開啟紀錄")}
        </Link>
      </span>
    );
  }
  if (indexed) {
    return (
      <Link to={recordingPath(recordingId)} className={buttonVariants({ variant: "quiet", size: "sm" })}>
        <ExternalLink aria-hidden />
        {t("主控已有")}
      </Link>
    );
  }
  return (
    <span className="grid gap-1">
      <ActionButton size="sm" icon={<DatabaseBackup aria-hidden />} pending={mutation.isPending} onClick={() => { mutation.mutate(); }}>
        {t("補抓到主控")}
      </ActionButton>
      {mutation.isError ? <ErrorCallout error={mutation.error} write title={t("補抓失敗（未自動重試）")} /> : null}
    </span>
  );
}

export function NodeHistoryPanel({
  run,
  missing,
  indexed,
  requestedNodes,
  onRequest,
  labelOf,
}: {
  run: WireRun;
  /** Steps whose recording the Controller lacks now (stepsMissingRecording). */
  missing: readonly RunStepView[];
  /** The Controller index's recording ids of the run; null while unknown (every Node-local recording then offers a backfill). */
  indexed: ReadonlySet<string> | null;
  /** The Nodes asked about so far, kept by the page after backfills fill the gaps; null before the first query. */
  requestedNodes: readonly string[] | null;
  onRequest: (nodeIds: string[]) => void;
  labelOf: (nodeId: string) => string;
}) {
  const nodeIds = [...new Set([...(requestedNodes ?? []), ...missing.map((step) => step.node_id).filter((id): id is string => Boolean(id))])];
  const requested = requestedNodes !== null;
  const pages = useQueries({
    queries: nodeIds.map((nodeId) => ({
      queryKey: qk.runNodeHistory(run.run_id, nodeId),
      enabled: requested,
      retry: false,
      staleTime: 10_000,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchNodeRecordingPage(nodeId, { run_id: run.run_id, limit: 50 }, signal),
    })),
  });
  const loading = pages.some((page) => page.isFetching);

  return (
    <section className="panel grid gap-3 p-4" aria-labelledby="node-history-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="node-history-title" className="text-section font-semibold text-fg">
          {t("Node 本機紀錄")}
        </h2>
        <ActionButton size="sm" icon={<Search aria-hidden />} pending={loading} onClick={() => { if (requested) { pages.forEach((page) => void page.refetch()); } else { onRequest(nodeIds); } }}>
          {requested ? t("重新查詢") : t("查詢 Node 本機紀錄")}
        </ActionButton>
      </div>
      <p className="text-data text-fg-secondary">
        {missing.length > 0
          ? t("{stepsCount} 個步驟已送出呼叫，但主控沒有它們的紀錄：沒有收到（例如 Controller 曾中斷），或已從主控刪除。這裡只唯讀查詢 Node 本機紀錄；補抓只複製 log，不重新執行、不改 run 狀態。", { stepsCount: missing.length })
          : t("主控的紀錄索引已有每個已送出步驟的紀錄。這裡只唯讀查詢 Node 本機紀錄；補抓只複製 log，不重新執行、不改 run 狀態。")}
      </p>
      {requested
        ? nodeIds.map((nodeId, index) => {
            const page = pages[index];
            if (!page) return null;
            const items = page.data?.items ?? [];
            return (
              <div key={nodeId} className="grid gap-2">
                <h3 className="text-data font-semibold text-fg">{labelOf(nodeId)}</h3>
                {page.isError ? <ErrorCallout error={page.error} title={t("無法查詢此 Node（離線或無回應）")} /> : null}
                {page.isSuccess && items.length === 0 ? (
                  <Callout tone="info" title={t("此 Node 本機沒有這個 run 的紀錄")}>
                    <p>{t("呼叫可能未被 Node 受理，或紀錄已被清除。")}</p>
                  </Callout>
                ) : null}
                {items.length > 0 ? (
                  <ul className="grid gap-2">
                    {items.map((item) => (
                      <li key={item.context.recording_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line-subtle bg-sunken/50 px-3 py-2 animate-rise-in">
                        <code className="machine text-data text-fg">{item.context.component_id}</code>
                        <Badge tone="neutral">{item.context.operation}</Badge>
                        <Badge tone={item.summary.state === "succeeded" ? "success" : item.summary.state === "running" ? "info" : "warning"}>{item.summary.state}</Badge>
                        <TimeText iso={item.context.created_at} />
                        <IdText value={item.context.recording_id} />
                        <RecordingAction recordingId={item.context.recording_id} nodeId={nodeId} indexed={indexed?.has(item.context.recording_id) ?? false} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })
        : null}
    </section>
  );
}
