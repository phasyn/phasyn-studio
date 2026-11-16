// 永久刪除 run 的確認對話框（紀錄・執行紀錄與 Studio 渲染紀錄共用）：先試算影響範圍，確認後逐筆刪除並列出結果。
// 不自動重試；任何檔案刪不到時伺服器整筆停下，這裡照實顯示哪些已刪、哪些沒刪。
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, FileX2, HardDrive, ScrollText, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { qk } from "@/api/keys";
import { fetchPurgePlan, invalidateAfterRunChange, purgeRun, type PurgeResult } from "@/api/runs";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { runIdName } from "@/lib/runName";
import { failedFiles, planFromError, summarizePlans } from "./purgeModel";
import type { RunOutputKind } from "./runModel";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { T } from "@/i18n/T";

type Outcome = { runId: string; ok: true; result: PurgeResult } | { runId: string; ok: false; error: unknown; partial: PurgeResult | null };

/** What the deletion removes, naming the files after what the runs made. */
function deletionScope(kind: RunOutputKind): string {
  if (kind === "image") return t("會刪除 run 產生的圖片與中間檔（在各 Node 上）、主控上的效能紀錄，以及 Studio 專案中對它的引用。無法復原；只想先收起來請用「封存」。");
  if (kind === "video") return t("會刪除 run 產生的影片與中間檔（在各 Node 上）、主控上的效能紀錄，以及 Studio 專案中對它的引用。無法復原；只想先收起來請用「封存」。");
  return t("會刪除 run 產生的輸出檔與中間檔（在各 Node 上）、主控上的效能紀錄，以及 Studio 專案中對它的引用。無法復原；只想先收起來請用「封存」。");
}

/**
 * runIds：要刪的 run。labelOf：顯示名稱。beforeDelete：刪除前的準備（例如 Studio 先存好專案）；
 * onDone：刪除流程結束後（成功的 run id），例如 Studio 重新載入被伺服器改過的專案、執行紀錄頁回到清單。
 */
export function RunDeleteDialog({
  runIds,
  open,
  onOpenChange,
  labelOf,
  outputKind = "other",
  beforeDelete,
  onDone,
}: {
  runIds: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labelOf?: (runId: string) => string;
  /** What the runs made (runOutputKind), for the wording; output files in general when unknown. */
  outputKind?: RunOutputKind;
  beforeDelete?: () => Promise<void>;
  onDone?: (deleted: string[]) => void;
}) {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const plans = useQueries({
    queries: runIds.map((runId) => ({
      queryKey: qk.runPurgePlan(runId),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchPurgePlan(runId, signal),
      enabled: open && outcomes === null,
      staleTime: 0,
      gcTime: 0,
      retry: false,
    })),
  });
  const loading = plans.some((plan) => plan.isPending);
  const ready = plans.flatMap((plan) => (plan.data ? [plan.data] : []));
  const blocked = plans.flatMap((plan, index) => (plan.isError ? [{ runId: runIds[index] ?? "", error: plan.error }] : []));
  const summary = summarizePlans(ready);
  const name = (runId: string) => labelOf?.(runId) ?? runIdName(runId);

  const close = (next: boolean) => {
    if (pending) return;
    if (!next) setOutcomes(null);
    onOpenChange(next);
  };

  const run = async () => {
    if (pending || ready.length === 0) return;
    setPending(true);
    const results: Outcome[] = [];
    try {
      if (beforeDelete) await beforeDelete();
      for (const plan of ready) {
        try {
          results.push({ runId: plan.run_id, ok: true, result: await purgeRun(plan.run_id) });
        } catch (error) {
          results.push({ runId: plan.run_id, ok: false, error, partial: planFromError(error) });
        }
        setOutcomes([...results]);
      }
    } catch (error) {
      results.push({ runId: "", ok: false, error, partial: null });
      setOutcomes([...results]);
    } finally {
      setPending(false);
      const deleted = results.flatMap((item) => (item.ok && item.result.deleted ? [item.runId] : []));
      invalidateAfterRunChange(client, results.map((item) => item.runId).filter(Boolean), true);
      onDone?.(deleted);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("永久刪除 {value}？", { value: runIds.length === 1 ? t("「{name}」", { name: name(runIds[0] ?? "") }) : t("{runIdsCount} 個 run", { runIdsCount: runIds.length }) })}</DialogTitle>
          <DialogDescription>{deletionScope(outputKind)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          {outcomes === null ? (
            loading ? (
              <div role="status" className="grid gap-2">
                <p className="text-data text-fg-secondary">{t("正在試算會刪除哪些檔案與紀錄…")}</p>
                {/* 不確定進度（試算沒有比例可報）：品牌淡漸層光帶，旁邊的文字說明狀態。 */}
                <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-line-subtle">
                  <span className="block h-full w-full rounded-full bg-brand-gradient-soft animate-shimmer" />
                </span>
              </div>
            ) : (
              <>
                {ready.length > 0 ? (
                  <ul className="grid gap-2 text-data text-fg-secondary" aria-label={t("刪除範圍")}>
                    <li className="flex items-start gap-2">
                      <HardDrive aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-tertiary" />
                      <span>
                        <span className="text-fg">{t("{files} 個檔案", { files: summary.files })}</span>
                        {summary.knownBytes !== null ? t("，約 {knownBytes}", { knownBytes: formatBytes(summary.knownBytes) }) : ""}
                        {summary.unknownSizes > 0 ? t("（{unknownSizes} 個大小未知）", { unknownSizes: summary.unknownSizes }) : ""}
                        {summary.nodes.length > 0 ? t("，位於 {nodesCount} 個 Node", { nodesCount: summary.nodes.length }) : ""}
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <ScrollText aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-tertiary" />
                      <span>
                        <T source={"<0>{recordings} 筆效能紀錄</0>（主控上的副本）"} values={{ recordings: summary.recordings }} slots={[<span className="text-fg" />]} />
                      </span>
                    </li>
                    {summary.projects.map((project) => (
                      <li key={project.project_id} className="flex items-start gap-2 text-warning">
                        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                        <span>
                          {t("Studio 專案「{title}」：移除 {removed}", {
                            title: project.title,
                            // 清單用 formatList（片段不帶前後空白；空白在句子裡），en 才不會出現兩個空白
                            removed: formatList([project.takes > 0 ? t("{takes} 個 take", { takes: project.takes }) : "", project.exports > 0 ? t("{exports} 個匯出", { exports: project.exports }) : ""].filter(Boolean)),
                          })}
                          {project.takes > 0 ? t("（使用中的 take 被移除時，鏡頭會變成沒有使用中的 take）") : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {blocked.map((item) => (
                  <ErrorCallout key={item.runId} error={item.error} title={t("「{runId}」不能刪除", { runId: name(item.runId) })} />
                ))}
              </>
            )
          ) : (
            <ul className="grid gap-2 animate-rise-in" aria-label={t("刪除結果")}>
              {outcomes.map((item, index) =>
                item.ok ? (
                  <li key={item.runId} className="flex items-start gap-2 text-data text-success">
                    <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
                    <span>
                      {t("已刪除「{runId}」：{filterCount} 個檔案、{deleted} 筆紀錄{value}", { runId: name(item.runId), filterCount: item.result.files.filter((file) => file.status === "deleted").length, deleted: item.result.recordings.deleted, value: item.result.files.some((file) => file.status === "missing") ? t("（{filterCount} 個檔案原本就不在）", { filterCount: item.result.files.filter((file) => file.status === "missing").length }) : "" })}
                    </span>
                  </li>
                ) : (
                  <li key={item.runId || `error-${index}`} className="grid gap-1">
                    <span className="flex items-start gap-2 text-data text-danger">
                      <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
                      <span>
                        {t("{value}：{error}", { value: item.runId ? t("「{runId}」沒有刪除", { runId: name(item.runId) }) : t("刪除前的準備失敗，沒有刪除任何 run"), error: errorText(item.error) })}
                      </span>
                    </span>
                    {failedFiles(item.partial).length > 0 ? (
                      <span className="flex items-start gap-2 pl-6 text-caption text-fg-secondary">
                        <FileX2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                        {t("{partialCount} 個檔案刪不到（例如 Node 離線）；run 紀錄與專案都沒有變更，Node 恢復後可以再刪一次。{value}", { partialCount: failedFiles(item.partial).length, value: item.partial && item.partial.files.some((file) => file.status === "deleted")
                          ? t(" 其中 {filterCount} 個檔案已經刪除。", { filterCount: item.partial.files.filter((file) => file.status === "deleted").length })
                          : "" })}
                      </span>
                    ) : null}
                  </li>
                ),
              )}
            </ul>
          )}
          {outcomes === null && ready.length > 0 && blocked.length > 0 ? (
            <Callout tone="warning" title={t("部分 run 不能刪除")}>
              <p>{t("只會刪除可以刪除的 {readyCount} 個 run。", { readyCount: ready.length })}</p>
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {outcomes === null ? (
            <>
              <Button variant="quiet" onClick={() => close(false)} disabled={pending}>
                {t("取消")}
              </Button>
              <Button
                variant="danger-confirm"
                icon={<Trash2 aria-hidden />}
                pending={pending}
                disabled={loading || ready.length === 0 || pending}
                onClick={() => void run()}
                title={ready.length === 0 ? t("沒有可以刪除的 run") : undefined}
              >
                {t("永久刪除{value}", { value: ready.length > 1 ? t(" {readyCount} 個", { readyCount: ready.length }) : "" })}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => close(false)} disabled={pending}>
              {pending ? t("刪除中…") : t("關閉")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
