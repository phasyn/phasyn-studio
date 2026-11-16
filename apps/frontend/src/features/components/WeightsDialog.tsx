// 模型權重（元件頁的「模型權重…」）：這個元件需要的固定版本權重、每一組在 Node 上
// 已有多少、要下載多少、能共用多少，授權條款與不能下載的需求；使用者勾選同意授權後才下載。下載是 Node 的背景工作：
// 這裡每秒讀一次進度（Node 實際收到的位元組），可以取消；失敗或取消後可以接著下載（暫存檔保留）；不自動重試。
import { useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, HardDrive, Link2, Scale } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ComponentEntry } from "@/api/catalog";
import type { WeightSetStatus, WeightsDownloadJob, WeightsView } from "@/api/generated/contracts";
import { qk } from "@/api/keys";
import { useCancelWeightsDownload, useComponentWeights, useStartWeightsDownload } from "@/api/weights";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/lib/format";
import { httpUrl } from "@/lib/url";
import { canResume, downloadBlockedReason, jobFraction, pendingFiles, weightsTotals, type WeightsTotals } from "./weightsModel";
import { t, tServer } from "@/i18n";

const STATUS_LABEL: Record<string, () => string> = {
  missing: () => t("缺少"),
  partial: () => t("下載到一半"),
  mismatch: () => t("大小不同"),
};

function SetCard({ set, endpoint }: { set: WeightSetStatus; endpoint: string }) {
  const missing = set.files.filter((file) => file.status !== "present");
  // 來源與授權網址由 Node 回報：只有 http(s) 才畫成連結，其餘只顯示文字。
  const repoHref = httpUrl(`${endpoint}/${set.repo}/tree/${set.revision}`);
  const licenseHref = httpUrl(set.license.url);
  const repoText = `${set.repo}@${set.revision.slice(0, 12)}`;
  return (
    <li className="grid gap-2 rounded-lg border border-line-subtle bg-canvas/60 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-data font-semibold text-fg">{set.label}</span>
        {repoHref ? (
          <a className="machine inline-flex items-center gap-1 text-caption" href={repoHref} target="_blank" rel="noreferrer">
            {repoText}
            <ExternalLink aria-hidden className="size-3" />
          </a>
        ) : (
          <span className="machine text-caption text-fg-secondary">{repoText}</span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-caption">
        <dt className="text-fg-tertiary">{t("檔案")}</dt>
        <dd className="text-fg-secondary">{t("{files} 個，共 {size}", { files: set.files_total, size: formatBytes(set.bytes_total) })}</dd>
        <dt className="text-fg-tertiary">{t("已在 Node 上")}</dt>
        <dd className="text-fg-secondary">{t("{files} 個，{size}（只比對大小）", { files: set.files_present, size: formatBytes(set.bytes_present) })}</dd>
        {set.files_missing > 0 ? (
          <>
            <dt className="text-fg-tertiary">{t("缺少")}</dt>
            <dd className="text-fg-secondary">
              {t("{files} 個，{size}", { files: set.files_missing, size: formatBytes(set.bytes_missing) })}
              {set.files_linkable > 0 ? t("；其中 {files} 個（{size}）可以從 Node 上相同的檔案共用", { files: set.files_linkable, size: formatBytes(set.bytes_linkable) }) : ""}
              {set.bytes_partial > 0 ? t("；暫存檔已有 {size}，會接著下載", { size: formatBytes(set.bytes_partial) }) : ""}
            </dd>
          </>
        ) : null}
        {set.files_mismatch > 0 ? (
          <>
            <dt className="text-warning">{t("大小不同")}</dt>
            <dd className="text-warning">{t("{files} 個，不會覆蓋（除非勾選取代）", { files: set.files_mismatch })}</dd>
          </>
        ) : null}
        <dt className="text-fg-tertiary">{t("放到")}</dt>
        <dd className="machine text-fg-secondary [overflow-wrap:anywhere]">{set.dest || t("（模型目錄本身）")}</dd>
      </dl>
      <div className="flex items-start gap-1.5 text-caption">
        <Scale aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-tertiary" />
        <span className="min-w-0">
          {licenseHref ? (
            <a href={licenseHref} target="_blank" rel="noreferrer">
              {set.license.name}
            </a>
          ) : (
            <span>{set.license.name}</span>
          )}
          {set.license.note ? <span className="block text-fg-secondary">{tServer(set.license.note)}</span> : null}
        </span>
      </div>
      {missing.length > 0 ? (
        <details className="text-caption">
          <summary className="cursor-pointer text-fg-secondary">{t("列出還沒就位的檔案（{count}）", { count: missing.length })}</summary>
          <ul className="mt-1 grid max-h-48 gap-0.5 overflow-y-auto pr-1">
            {missing.map((file) => (
              <li key={file.path} className="flex min-w-0 items-baseline gap-2">
                <span className="machine min-w-0 flex-1 truncate text-fg-secondary" title={file.path}>
                  {file.path}
                </span>
                <span className="shrink-0 text-fg-tertiary">{formatBytes(file.size)}</span>
                <span className={file.status === "mismatch" ? "shrink-0 text-warning" : "shrink-0 text-fg-tertiary"}>
                  {file.link_from ? t("可共用") : (STATUS_LABEL[file.status]?.() ?? file.status)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function JobStatus({ job, totals }: { job: WeightsDownloadJob; totals: WeightsTotals }) {
  const fraction = jobFraction(job);
  if (job.state === "running") {
    const current = job.current;
    return (
      <section aria-label={t("下載進度")} className="grid gap-2 rounded-lg border border-line-subtle p-3" aria-live="polite">
        <ProgressTrack
          value={fraction}
          tone="running"
          label={t("權重下載進度")}
          valueText={fraction === null ? undefined : t("已收到 {done}／{total}", { done: formatBytes(job.bytes_done), total: formatBytes(job.bytes_total) })}
        />
        <p className="text-caption text-fg-secondary">
          {t("檔案 {done}／{total}（共用 {linked} 個）・已收到 {bytes}／{total_bytes}", {
            done: job.files_done,
            total: job.files_total,
            linked: job.files_linked,
            bytes: formatBytes(job.bytes_done),
            total_bytes: formatBytes(job.bytes_total),
          })}
        </p>
        {current ? (
          <p className="text-caption text-fg-tertiary">
            {current.phase === "verify" ? t("正在驗證 Node 上相同的檔案以便共用：") : t("正在下載：")}
            <span className="machine [overflow-wrap:anywhere]">{current.path}</span>
          </p>
        ) : null}
      </section>
    );
  }
  if (job.state === "succeeded") {
    return (
      <Callout tone="success" title={t("下載完成")}>
        <p>{t("處理了 {files} 個檔案（其中 {linked} 個以 hard link 共用），收到 {bytes}。", { files: job.files_total, linked: job.files_linked, bytes: formatBytes(job.bytes_done) })}</p>
        <p>{pendingFiles(totals) > 0 ? t("還有檔案沒有就位：再檢查一次。") : t("可以到元件頁啟動這個元件了。")}</p>
      </Callout>
    );
  }
  if (job.state === "cancelled") {
    return (
      <Callout tone="warning" title={t("下載已取消")}>
        <p>{t("已收到 {bytes}；暫存檔保留，再按「繼續下載」會接著下載。", { bytes: formatBytes(job.bytes_done) })}</p>
      </Callout>
    );
  }
  return job.error ? (
    <ErrorCallout error={job.error} title={t("下載失敗（不會自動重試）")}>
      <p className="text-caption">{t("已完成的檔案保留；暫存檔保留時，再按「繼續下載」會接著下載。")}</p>
    </ErrorCallout>
  ) : null;
}

function WeightsContent({ view, totals }: { view: WeightsView; totals: WeightsTotals }) {
  return (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-line-subtle bg-canvas/60 px-3 py-2 text-data">
        <dt className="flex items-center gap-1 text-fg-tertiary">
          <HardDrive aria-hidden className="size-3.5" />
          {t("模型目錄")}
        </dt>
        <dd className="machine text-fg [overflow-wrap:anywhere]">
          {view.root ?? "—"}
          {view.root && !view.root_exists ? <span className="font-sans text-caption text-fg-tertiary">{t("（還不存在，下載時建立）")}</span> : null}
        </dd>
        <dt className="text-fg-tertiary">{t("剩餘空間")}</dt>
        <dd className="text-fg">{view.free_bytes === null ? t("讀不到") : formatBytes(view.free_bytes)}</dd>
        <dt className="text-fg-tertiary">{t("來源")}</dt>
        <dd className="text-fg">
          <span className="machine">{view.source.endpoint}</span>
          <span className="text-caption text-fg-tertiary">{view.source.token ? t("・Node 已設定 HF_TOKEN") : t("・Node 沒有設定 HF_TOKEN（公開模型不需要）")}</span>
        </dd>
      </dl>
      {view.sets.length === 0 && view.notes.length === 0 ? <p className="text-data text-fg-secondary">{t("這個元件沒有需要下載的權重。")}</p> : null}
      {view.sets.length > 0 ? (
        <ul aria-label={t("權重組")} className="grid gap-2">
          {view.sets.map((set) => (
            <SetCard key={set.set_id} set={set} endpoint={view.source.endpoint} />
          ))}
        </ul>
      ) : null}
      {view.notes.length > 0 ? (
        <Callout tone="info" title={t("不能下載、需要另外準備的項目")}>
          <ul className="grid list-disc gap-0.5 pl-4">
            {view.notes.map((note) => (
              <li key={note}>{tServer(note)}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {view.sets.length > 0 ? (
        <p className="flex items-center gap-1.5 text-caption text-fg-tertiary">
          <Link2 aria-hidden className="size-3.5 shrink-0" />
          {t("合計：要下載 {download}、可共用 {link}、已就位 {present}（共 {total}）", {
            download: formatBytes(totals.downloadBytes),
            link: formatBytes(totals.linkBytes),
            present: formatBytes(totals.presentBytes),
            total: formatBytes(totals.bytes),
          })}
        </p>
      ) : null}
    </>
  );
}

function WeightsBody({ entry, onClose }: { entry: ComponentEntry; onClose: () => void }) {
  const { descriptor, node } = entry;
  const id = useId();
  const client = useQueryClient();
  const query = useComponentWeights(node.node_id, descriptor.component_id);
  const start = useStartWeightsDownload(node.node_id, descriptor.component_id);
  const cancel = useCancelWeightsDownload(node.node_id, descriptor.component_id);
  const [accepted, setAccepted] = useState(false);
  const [replace, setReplace] = useState(false);
  const view = query.data;
  const job = view?.job ?? null;
  const running = job?.state === "running";
  const totals = view ? weightsTotals(view, replace) : null;

  // 下載結束時重新讀目錄：元件可能已經可以啟動了
  const lastState = useRef(job?.state);
  useEffect(() => {
    if (lastState.current === "running" && job && job.state !== "running") void client.invalidateQueries({ queryKey: qk.catalog() });
    lastState.current = job?.state;
  }, [job, client]);

  const blocked = view && totals ? downloadBlockedReason({ descriptor, view, totals, accepted, stale: node.stale }) : t("讀取中…");
  const resume = view && totals ? canResume(view, totals) : false;
  const label = totals ? (resume ? t("繼續下載（{size}）", { size: formatBytes(totals.downloadBytes) }) : t("下載（{size}）", { size: formatBytes(totals.downloadBytes) })) : t("下載");

  return (
    <>
      <DialogBody className="grid gap-4">
        {query.isPending ? (
          <p role="status" className="text-data text-fg-secondary">
            {t("正在向 Node 讀取這個元件需要的權重…")}
          </p>
        ) : null}
        {query.isError ? <ErrorCallout error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
        {view && totals ? <WeightsContent view={view} totals={totals} /> : null}
        {job && totals ? <JobStatus job={job} totals={totals} /> : null}
        {start.isError ? <ErrorCallout error={start.error} write title={t("沒有開始下載")} /> : null}
        {cancel.isError ? <ErrorCallout error={cancel.error} write title={t("取消沒有送達")} /> : null}
        {view && totals && view.sets.length > 0 && !running ? (
          <div className="grid gap-1 border-t border-line-subtle pt-3">
            {totals.mismatchFiles > 0 ? (
              <Checkbox
                id={`${id}-replace`}
                label={t("取代大小不同的檔案（{files} 個）", { files: totals.mismatchFiles })}
                description={t("下載驗證通過後才取代；不勾選時這些檔案保持原樣。")}
                checked={replace}
                onChange={(event) => setReplace(event.target.checked)}
              />
            ) : null}
            <Checkbox
              id={`${id}-accept`}
              label={t("我已閱讀並同意上面列出的授權條款")}
              description={t("權重不隨 Phasyn Studio 散布；下載後依各自的授權使用。")}
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="quiet" onClick={onClose}>
          {t("關閉")}
        </Button>
        {running ? (
          <Button variant="danger" pending={cancel.isPending} onClick={() => cancel.mutate()}>
            {t("取消下載")}
          </Button>
        ) : (
          <ActionButton
            variant="primary"
            icon={<Download aria-hidden />}
            disabledReason={blocked}
            pending={start.isPending}
            onClick={() => start.mutate({ accept_licenses: true, replace_mismatched: replace })}
          >
            {label}
          </ActionButton>
        )}
      </DialogFooter>
    </>
  );
}

/** 元件的模型權重：檢查、同意授權後下載、看進度與取消。 */
export function WeightsDialog({ entry, open, onOpenChange }: { entry: ComponentEntry; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t("模型權重：{label}", { label: entry.descriptor.label || entry.descriptor.component_id })}</DialogTitle>
          <DialogDescription>{t("只在你確認後下載，而且只寫進這個元件設定的模型目錄（load.model_path）；元件載入時仍然只讀本機檔案，不會自己下載。")}</DialogDescription>
        </DialogHeader>
        {open ? <WeightsBody entry={entry} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
