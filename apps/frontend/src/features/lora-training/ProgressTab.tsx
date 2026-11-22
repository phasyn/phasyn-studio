// 進度分頁：目前正在跑的那一步（元件預覽與說明：切片時是縮圖表、反推時是片段與 caption、訓練時是 loss 圖）、
// 訓練步數與 loss 曲線（每 10 步平均）、資料摘要與事件時間線。
import { Activity, Clock3, LoaderCircle } from "lucide-react";
import type { LoraTraining } from "@/api/generated/contracts";
import { runSteps } from "@/api/types";
import { CARD, METER_FILL, METER_TRACK, PANEL_TITLE } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { isRecord } from "@/lib/json";
import { useActiveRun } from "./api";
import { activeRunId, eventText, PHASE_LABEL, trainingView, type TrainingView } from "./model";

const W = 640;
const H = 200;
const PAD = 28;

export function LossChart({ points }: { points: TrainingView["loss"] }) {
  if (points.length < 2) return <p className="text-data text-fg-tertiary">{t("訓練開始後這裡會畫出 loss 曲線。")}</p>;
  const xs = points.map((p) => p.step);
  const ys = points.map((p) => p.loss);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => PAD + ((x - x0) / Math.max(x1 - x0, 1)) * (W - 2 * PAD);
  const sy = (y: number) => H - PAD - ((y - y0) / Math.max(y1 - y0, 1e-9)) * (H - 2 * PAD);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.step).toFixed(1)},${sy(p.loss).toFixed(1)}`).join(" ");
  const last = points.at(-1);
  return (
    <figure className="grid gap-1">
      <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="h-auto w-full" role="img" aria-label={t("Loss 曲線：第 {from} 到 {to} 步", { from: x0, to: x1 })}>
        <defs>
          <linearGradient id="loss-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(64 220 255 / 0.28)" />
            <stop offset="100%" stopColor="rgb(64 220 255 / 0)" />
          </linearGradient>
        </defs>
        <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} className="stroke-line-subtle" />
        <path d={`${d} L${sx(x1).toFixed(1)},${String(H - PAD)} L${sx(x0).toFixed(1)},${String(H - PAD)} Z`} fill="url(#loss-fill)" />
        <path d={d} fill="none" className="stroke-brand-cyan" strokeWidth={2.5} strokeLinejoin="round" />
        <text x={PAD} y={16} className="fill-fg-tertiary text-[11px]">{y1.toFixed(3)}</text>
        <text x={PAD} y={H - 8} className="fill-fg-tertiary text-[11px]">{y0.toFixed(3)}</text>
      </svg>
      {last ? <figcaption className="machine text-caption text-fg-tertiary">{t("最近 10 步平均 loss {loss}（第 {step} 步）", { loss: last.loss.toFixed(4), step: last.step })}</figcaption> : null}
    </figure>
  );
}

function LivePreview({ runId }: { runId: string }) {
  const run = useActiveRun(runId);
  const steps = run.data ? runSteps(run.data) : [];
  const live = steps.find((s) => s.preview !== null);
  const waiting = steps.find((s) => s.component_load?.phase === "waiting" || s.component_load?.phase === "loading");
  if (live?.preview) {
    return (
      <figure className="grid gap-2">
        <img src={live.preview.url} alt={t("目前步驟的即時預覽")} width={live.preview.width} height={live.preview.height} className="h-auto max-h-80 w-full rounded-lg border border-line-subtle bg-stage object-contain" />
        <figcaption className="grid gap-1">
          <span className={METER_TRACK} role="progressbar" aria-label={t("這一步的進度")} aria-valuemin={0} aria-valuemax={live.preview.total} aria-valuenow={live.preview.step}>
            <span className={METER_FILL} style={{ width: `${String(Math.round((100 * live.preview.step) / Math.max(live.preview.total, 1)))}%` }} />
          </span>
          {live.preview.note !== null ? <span className="text-caption text-fg-secondary">{live.preview.note}</span> : null}
        </figcaption>
      </figure>
    );
  }
  return (
    <p role="status" className="flex items-center gap-2 text-data text-fg-secondary">
      <LoaderCircle aria-hidden className="size-4 animate-spin text-brand-cyan" />
      {waiting?.component_load ? waiting.component_load.message : t("等待這一步開始…")}
    </p>
  );
}

function DataSummary({ job }: { job: LoraTraining }) {
  const sel = isRecord(job.selection) && isRecord(job.selection["stats"]) ? job.selection["stats"] : null;
  if (sel === null) return null;
  const n = (k: string): number => {
    const v = sel[k];
    return typeof v === "number" ? v : 0;
  };
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {[
        [t("訓練片段"), n("train_clips")],
        [t("留出片段"), n("heldout_clips")],
        [t("有遮罩的片段"), n("masked_clips")],
        [t("排除的片段"), Object.values(isRecord(sel["rejected_by_reason"]) ? sel["rejected_by_reason"] : {}).reduce((a: number, b) => a + (typeof b === "number" ? b : 0), 0)],
      ].map(([label, value]) => (
        <div key={String(label)} className={cn(CARD, "grid gap-0.5 p-3")}>
          <dt className="text-caption text-fg-tertiary">{label}</dt>
          <dd className="machine text-title font-semibold text-fg">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProgressTab({ job }: { job: LoraTraining }) {
  const view = trainingView(job);
  const runId = activeRunId(job);
  const events = [...job.events].reverse().slice(0, 40);
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <section className={cn(CARD, "grid gap-3 p-4")} aria-labelledby="training-now">
        <h2 id="training-now" className={cn(PANEL_TITLE, "flex items-center gap-2")}>
          <Activity aria-hidden className="size-4 text-brand-cyan" />
          {t("現在：{phase}", { phase: PHASE_LABEL[job.phase] })}
        </h2>
        {runId !== null && (job.status === "running" || job.status === "stopping") ? <LivePreview runId={runId} /> : <p className="text-data text-fg-secondary">{t("目前沒有正在執行的步驟。")}</p>}
      </section>
      {view !== null ? (
        <section className={cn(CARD, "grid gap-3 p-4")} aria-labelledby="training-loss">
          <h2 id="training-loss" className={PANEL_TITLE}>{t("訓練")}</h2>
          <div className="grid gap-1">
            <span className="machine text-data text-fg">{t("第 {done}／{total} 步", { done: view.done, total: view.steps })}</span>
            <span className={METER_TRACK} role="progressbar" aria-label={t("訓練進度")} aria-valuemin={0} aria-valuemax={view.steps} aria-valuenow={view.done}>
              <span className={METER_FILL} style={{ width: `${String(Math.round((100 * view.done) / Math.max(view.steps, 1)))}%` }} />
            </span>
          </div>
          <LossChart points={view.loss} />
        </section>
      ) : null}
      <DataSummary job={job} />
      <section className={cn(CARD, "grid gap-2 p-4")} aria-labelledby="training-events">
        <h2 id="training-events" className={cn(PANEL_TITLE, "flex items-center gap-2")}>
          <Clock3 aria-hidden className="size-4 text-fg-tertiary" />
          {t("經過")}
        </h2>
        <ol className="grid gap-1.5">
          {events.map((e, i) => {
            const rec = isRecord(e) ? e : {};
            return (
              <li key={`${String(rec["at"])}-${String(i)}`} className="flex flex-wrap items-baseline gap-2 text-data">
                <span className="machine shrink-0 text-caption text-fg-tertiary">{formatTimestamp(typeof rec["at"] === "string" ? rec["at"] : null)}</span>
                <span className="text-fg-secondary">{eventText(typeof rec["kind"] === "string" ? rec["kind"] : "")}</span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
