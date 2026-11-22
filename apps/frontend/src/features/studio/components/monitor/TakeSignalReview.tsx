import { ScanLine } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useStableCatalog } from "@/api/catalog";
import type { StudioShot, StudioTake } from "@/api/generated/contracts";
import { usePipelines } from "@/api/pipelines";
import { useCreateRun, useRun, useRunList } from "@/api/runs";
import type { WirePipeline } from "@/api/types";
import { runPath } from "@/app/paths";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { takeNumber } from "../../model/takeDownload";
import { useStudio } from "../../studioContext";
import { matchesReview, setupIssue, SIGNAL_PIPELINE } from "./TakeSignalModel";
import { TakeSignalResults } from "./TakeSignalResults";

function readReceipt(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function rememberReceipt(key: string, id: string) {
  try { localStorage.setItem(key, id); } catch { /* The Controller also keeps the request and its source. */ }
}

/**
 * Analyze the take actually displayed in monitor A, independently of which take is active on the timeline. Opening the
 * dialog only reads results already recorded for this take; a check starts only with 開始檢查影片.
 */
export function TakeSignalReview({ shot, take }: { shot: StudioShot; take: StudioTake }) {
  const { project, runBlockedReason, activeRunIds } = useStudio();
  const catalog = useStableCatalog();
  const pipelines = usePipelines();
  const create = useCreateRun();
  const history = useRunList(50, "include", { related_project_id: project.project_id }, "summary");
  const number = takeNumber(shot, take);
  const file = take.asset?.file;
  const origin = JSON.stringify({ project_id: project.project_id, shot_id: shot.shot_id, take_id: take.take_id, asset_id: take.asset?.asset_id });
  const key = `phasyn.studio.take-review.${origin}.${file?.sha256 ?? ""}`;
  const [saved] = useState(() => readReceipt(key));
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const previous = file ? history.data?.pages.flatMap((page) => page.items).find((item) => matchesReview(item, origin, file)) : undefined;
  const id = submitted ?? previous?.run_id ?? saved;
  const known = useRun(open ? id : null);
  const result = known.data ?? (previous?.run_id === id ? previous : undefined);
  const matched = result && file && matchesReview(result, origin, file) ? result : null;
  const graph = pipelines.data?.items.find((item) => item.pipeline_id === SIGNAL_PIPELINE);
  // The shared capacity poll can briefly retain this run after its detail has reached a terminal state.
  const ownStaleSlot = matched && matched.state !== "running" && activeRunIds.length === 1 && activeRunIds[0] === matched.run_id;
  const fileIssue = !file || !(take.asset?.complete === true) || take.state !== "succeeded" || !file.media_type.startsWith("video/")
    ? t("這個 Take 還沒有完整的影片成品。")
    : null;
  const capacity = (ownStaleSlot === true) ? null : runBlockedReason;
  const block = fileIssue ?? (pipelines.isError ? errorText(pipelines.error)
    : catalog.isError ? errorText(catalog.error)
    : pipelines.isPending || !catalog.data ? t("正在讀取流程與元件狀態…")
    : !graph ? t("請先在「元件組合」匯入 {name}。", { name: `${SIGNAL_PIPELINE}.json` })
    : setupIssue(graph, catalog.data) ?? capacity);
  const title = t("影片檢查與輪廓");
  const start = async (readyGraph: WirePipeline) => {
    if (inFlightRef.current || !file || matched?.state === "running") return;
    inFlightRef.current = true;
    setError(null);
    try {
      const created = await create.mutateAsync({
        pipeline: readyGraph, inputs: { video: { type_id: "media.video.v1", file } },
        origin: { source_run_id: take.run_id, note: origin },
        label: t("影片檢查 · {shot} · Take {number}", { shot: shot.title, number }),
      });
      rememberReceipt(key, created.run_id);
      setSubmitted(created.run_id);
    } catch (cause) {
      setError(errorText(cause));
      void history.refetch();
    } finally {
      inFlightRef.current = false;
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="secondary" icon={<ScanLine aria-hidden />} title={title}>{t("檢查影片")}</Button></DialogTrigger>
      <DialogContent className="max-w-2xl" onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("{shot} · Take {number}：檢查原始影片的黑場與靜止片段，同時產生逐格對齊的輪廓影片。", { shot: shot.title, number })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          {!matched && !create.isPending && !(id != null && id !== "") ? <p className="text-data text-fg-secondary">{t("這個 take 還沒有檢查過。按「開始檢查影片」才會開始，不會自動執行。")}</p> : null}
          {(id != null && id !== "") ? <div className="flex flex-wrap items-center gap-2"><Link to={runPath(id)} title={id} className="text-data text-action-fg underline">{t("檢查紀錄")}</Link>{matched ? <StatusBadge kind="run" value={matched.state} /> : null}</div> : null}
          {(error != null && error !== "") ? <p role="alert" className="text-data text-warning">{error}</p> : null}
          {history.isError && !(id != null && id !== "") ? <p role="alert" className="text-data text-warning">{errorText(history.error)}</p> : null}
          {known.isError && (id != null && id !== "") ? <p role="alert" className="text-data text-warning">{errorText(known.error)}</p> : null}
          {result && !matched ? <p role="alert" className="text-data text-warning">{t("已儲存的檢查不屬於這個 Take。")}</p> : null}
          {matched?.error ? <p role="alert" className="text-data text-warning">{errorText(matched.error)}</p> : null}
          {matched?.state === "running" || create.isPending ? <p role="status" className="text-data">{t("正在檢查影片並產生輪廓…")}</p> : null}
          {matched?.state === "succeeded" && file ? <TakeSignalResults key={matched.run_id} run={matched} source={file} /> : null}
          {(block != null && block !== "") && matched?.state !== "running" ? <p role="status" className="text-data text-warning">{block}</p> : null}
          {file ? (
            <details className="text-caption text-fg-tertiary">
              <summary className="cursor-pointer select-none hover:text-fg-secondary">{t("詳細")}</summary>
              <p className="machine mt-1 break-all">{t("來源 SHA-256")} · {file.sha256}</p>
            </details>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild><Button>{t("關閉")}</Button></DialogClose>
          <Button variant="primary" disabled={Boolean(block) || create.isPending || matched?.state === "running" || ((id != null && id !== "") && known.isPending)} title={block ?? undefined} onClick={() => { if (!(block != null && block !== "") && graph) void start(graph); }}>
            {matched ? t("重新檢查影片") : t("開始檢查影片")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
