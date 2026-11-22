import { isNonzeroNumber } from "@/lib/json";
// "Recording not found" → fetch it back from a Node. Deleting a recording on the Controller leaves the Node's own copy,
// and so can a Controller that never received it; the Controller has no context of the recording left, so the user picks
// the Node from the directory. One explicit POST …/fetch-history (sent once, never retried): it only reads the Node's
// log and events into the Controller index, runs and resumes nothing. On success the page re-reads the recording.
import { DatabaseBackup, RotateCcw, SearchX, TriangleAlert } from "lucide-react";
import { useId, useState, type SubmitEvent } from "react";
import { useCatalog } from "@/api/catalog";
import type { Catalog } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { statusSpec } from "@/components/common/statusSpec";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Select } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { useFetchHistory } from "../api";
import { describeError } from "../model/errors";
import { t, tServer } from "@/i18n";

const directoryOf = (catalog: Catalog) => catalog.directory;

export function RecoverFromNode({
  recordingId,
  rereading,
  onReread,
  onSubmit,
}: {
  recordingId: string;
  /** The page is reading the recording again (after a backfill, or "re-read"). */
  rereading: boolean;
  onReread: () => void;
  /** Called as the request is sent (the page then moves focus to the recording once it shows up). */
  onSubmit: () => void;
}) {
  const id = useId();
  const directory = useCatalog(directoryOf);
  const nodes = directory.data ?? [];
  const [choice, setChoice] = useState<string | null>(null);
  // A single known Node is preselected; otherwise the user picks one
  const only = nodes.length === 1 ? nodes[0] : undefined;
  const nodeId = choice ?? only?.node_id ?? "";
  const mutation = useFetchHistory(recordingId);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!nodeId || mutation.isPending) return;
    onSubmit();
    mutation.mutate({ node_id: nodeId });
  };

  const error = mutation.isError ? describeError(mutation.error) : null;
  const outcomeUnknown = error !== null && (error.remoteUnknown || error.status === null || error.status >= 500);

  return (
    <section aria-labelledby={`${id}-title`} className="panel grid w-full max-w-xl gap-3 p-4 text-left">
      <h3 id={`${id}-title`} className="flex items-center gap-2 text-section font-semibold text-fg">
        <DatabaseBackup aria-hidden className="size-4 text-fg-tertiary" />
        {t("從 Node 補抓")}
      </h3>
      <p className="text-data text-fg-secondary">
        {t("從主控刪除的紀錄，Node 本機的原始紀錄仍保留。選這筆紀錄所在的 Node，讀回它的 log 與事件、補進主控的紀錄索引；只讀紀錄，不重新執行，也不改 run 狀態。")}
      </p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2" noValidate>
        <Field id={`${id}-node`} label="Node" className="min-w-[14rem] flex-1">
          {(describedBy) => (
            <Select id={`${id}-node`} value={nodeId} onChange={(event) => { setChoice(event.target.value); }} aria-describedby={describedBy}>
              <option value="">{directory.isPending ? t("讀取 Node 清單…") : t("選擇 Node")}</option>
              {nodes.map((node) => (
                <option key={node.node_id} value={node.node_id}>
                  {node.label || node.node_id}
                  {node.state === "online" ? "" : ` · ${statusSpec("directory", node.state).label}`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ActionButton
          type="submit"
          variant="primary"
          icon={<DatabaseBackup aria-hidden />}
          pending={mutation.isPending}
          disabledReason={nodeId ? null : t("先選擇這筆紀錄所在的 Node")}
          className="pointer-coarse:min-h-11"
        >
          {t("從 Node 補抓")}
        </ActionButton>
      </form>
      {directory.isError ? <p className="text-caption text-warning">{t("無法讀取 Node 清單（目錄讀取失敗）；稍後再試。")}</p> : null}
      {mutation.isSuccess ? (
        rereading ? (
          <p role="status" className="text-data text-fg-secondary">
            {t("已補抓，正在重新讀取紀錄…")}
          </p>
        ) : (
          <Callout tone="warning" icon={<TriangleAlert />} title={t("補抓已完成，但主控仍找不到這筆紀錄")} role="status" className="animate-rise-in">
            <p>{t("已匯入 {imported_events} 筆事件", { imported_events: mutation.data.imported_events.toLocaleString("en-US") })}</p>
            {mutation.data.message ? <p className="text-fg-secondary">{tServer(mutation.data.message)}</p> : null}
          </Callout>
        )
      ) : null}
      {error ? (
        error.code === "RECORDING_NOT_FOUND" ? (
          <Callout tone="danger" icon={<SearchX />} title={t("這個 Node 也沒有此 recording")} role="alert" className="animate-rise-in">
            <p>{t("Node 與主控都找不到這筆紀錄：它可能在另一個 Node，或 Node 本機的紀錄也已清除。")}</p>
            <p className="machine text-caption text-fg-tertiary">
              {error.code}
              {isNonzeroNumber(error.status) ? ` · HTTP ${String(error.status)}` : ""}
            </p>
          </Callout>
        ) : (
          <Callout tone="danger" title={error.headline} role="alert" className="animate-rise-in">
            {(error.serverMessage != null && error.serverMessage !== "") ? <p>{error.serverMessage}</p> : null}
            <p className="machine text-caption text-fg-tertiary">
              {error.code}
              {isNonzeroNumber(error.status) ? ` · HTTP ${String(error.status)}` : ""}
            </p>
            {outcomeUnknown ? (
              <>
                <p className="text-warning">{t("遠端結果未知：補抓可能已在 Node 端完成。重新讀取這筆紀錄確認；不會自動重送。")}</p>
                <div className="pt-1">
                  <Button size="sm" icon={<RotateCcw aria-hidden />} onClick={onReread} pending={rereading}>
                    {t("重新讀取")}
                  </Button>
                </div>
              </>
            ) : null}
          </Callout>
        )
      ) : null}
      {directory.isSuccess && nodes.length === 0 ? <p className="text-caption text-fg-tertiary">{t("目錄裡沒有任何 Node：Node 連上主控後才能從它補抓。")}</p> : null}
    </section>
  );
}
