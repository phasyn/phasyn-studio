// The DiT cards of the run detail's 「階段」 tab (DitProgressPanel, also exported through RenderProgress.tsx): one card
// per DiT branch with the measured step count, a meter, per-step bars and times. Only evidence is drawn: derived values
// say 推導, unmeasured ones say so. The stage's own estimate and the branch's cost-profile estimate are tooltip lines of
// the step count, so the run's time left (overview) is the only one on screen. Times use the workspace format.
import { CircularProgress } from "@/components/common/CircularProgress";
import { Badge } from "@/components/ui/badge";
import { CARD } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { elapsedMs } from "@/lib/time";
import { progressHeadline, SOURCE_LABELS, TOTAL_SOURCE_LABELS, type BranchView, type DitProgress } from "../../model/progress";
import { StepMeter, type MeterTone } from "./StepMeter";
import { formatLeft, formatSpan, formatSpanExact } from "./time";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

/** 結束後的顏色與佇列的分段進度條一致：只有失敗是紅色，取消與中斷是警告色（不是失敗）。 */
function toneOf(view: BranchView): MeterTone {
  if (view.state === "succeeded") return "success";
  if (view.state === "failed") return "danger";
  if (view.state === "cancelled" || view.state === "interrupted") return "warning";
  return "info";
}

/** 每步耗時的小長條：已量測（或推導）的步依耗時比例畫高度；進行中的步是外框；未開始的步是底線。 */
function StepBars({ view }: { view: BranchView }) {
  const { progress } = view;
  const running = view.state === "running";
  const count = Math.max(progress.total ?? 0, (progress.durations.at(-1)?.index ?? -1) + 1, progress.current ?? 0);
  if (count === 0 || count > 400) return null;
  const byIndex = new Map(progress.durations.map((item) => [item.index, item.ms]));
  const max = Math.max(1, ...progress.durations.map((item) => item.ms));
  const derived = progress.source === "transfer" ? t("（推導）") : "";
  const summary = formatList(progress.durations.map((item) => t("第 {index} 步 {ms}", { index: item.index + 1, ms: formatSpanExact(item.ms) })));
  return (
    // 步數多時去掉間隔：長條一律可以縮到很窄，不撐寬渲染詳情（中間區域不水平捲動）
    <div role="img" aria-label={summary ? t("每步耗時{derived}：{summary}", { derived, summary }) : t("還沒有每步耗時")} className={cn("flex h-8 min-w-0 items-end", count > 48 ? "gap-0" : "gap-0.5")}>
      {Array.from({ length: count }, (_, index) => {
        const ms = byIndex.get(index);
        const current = running && progress.current === index + 1;
        const done = progress.completed !== null && index < progress.completed;
        const title = ms !== undefined ? t("第 {index} 步：{ms}{derived}", { index: index + 1, ms: formatSpanExact(ms), derived }) : current ? t("第 {index} 步：進行中", { index: index + 1 }) : done ? t("第 {index} 步：已完成（沒有耗時資料）", { index: index + 1 }) : t("第 {index} 步：未開始", { index: index + 1 });
        return (
          <span
            key={index}
            title={title}
            className={cn(
              "min-w-0 flex-1 rounded-t-[2px]",
              ms !== undefined ? "bg-action/70" : current ? "h-full rounded-[2px] border border-info/70 bg-info/10" : done ? "h-1 bg-action/40" : "h-1 bg-line-subtle",
            )}
            style={ms !== undefined ? { height: `${Math.max(6, (ms / max) * 100)}%` } : undefined}
          />
        );
      })}
    </div>
  );
}

/**
 * Time left of the DiT stage alone, from this run's own steps: remaining steps × this run's median step (the running
 * one included). It covers denoising only, so it is labelled as this stage's and never shown as the time left of the
 * branch or the run (those come only from the cost profiles); it is a tooltip line of the step count.
 */
function stageText(progress: DitProgress): { value: string; note: string | null } {
  if (progress.loopDone) return { value: t("去噪迴圈已完成"), note: t("元件正在收尾（同步、寫出 latent）") };
  if (progress.total === null) return { value: t("不估算"), note: t("總步數未知") };
  if (progress.stageRemainingMs === null || progress.completed === null) return { value: t("尚無"), note: t("至少完成 1 步、有耗時資料後才估算") };
  const left = Math.max(0, progress.total - progress.completed);
  return { value: `≈ ${formatLeft(progress.stageRemainingMs / 1000)}`, note: t("剩餘 {left} 步 × 本次每步中位數（含進行中的一步）", { left }) };
}

/** The step count's tooltip: where the total comes from and, while running, this stage's and this branch's estimates. */
function headlineTitle(progress: DitProgress, running: boolean, converged: number | null | undefined): string {
  const lines = [TOTAL_SOURCE_LABELS[progress.totalSource ?? "unknown"]];
  if (running) {
    // Without a badge (no step signal yet) the reason goes here
    if (progress.source === "none") lines.push(SOURCE_LABELS.none.detail);
    const stage = stageText(progress);
    lines.push(stage.note ? t("此階段剩餘：{value}（{note}）", { value: stage.value, note: stage.note }) : t("此階段剩餘：{value}", { value: stage.value }));
    if (typeof converged === "number") {
      lines.push(t("預估剩餘：≈ {value}（依本機成本紀錄；已完成的步驟用實際時間，含這個分支的解碼與封裝）", { value: formatLeft(converged) }));
    }
  }
  return lines.join("\n");
}

function BranchCard({ view, label, now, converged }: { view: BranchView; label: string; now: number | null; converged: number | null | undefined }) {
  const { progress } = view;
  const running = view.state === "running";
  const elapsed = elapsedMs(view.startedAt, view.finishedAt, running ? now : null);
  const source = SOURCE_LABELS[progress.source];
  const detailed = running || progress.durations.length > 0;
  return (
    <li className={cn(CARD, "grid gap-2 p-2.5", running && "border-brand-blue/45")}>
      <div className="flex min-w-0 items-center gap-2">
        {running && progress.fraction !== null ? <CircularProgress value={progress.fraction} size={18} label={t("{label}：DiT 去噪進度", { label })} className="shrink-0" /> : null}
        <span className="min-w-0 truncate text-data text-fg">{label}</span>
        {progress.source !== "none" ? (
          <Badge tone="neutral" title={source.detail}>
            {source.short}
          </Badge>
        ) : null}
        <span className={cn("ml-auto shrink-0 text-data machine", running ? "text-brand-cyan" : "text-fg-secondary")} title={headlineTitle(progress, running, converged)}>
          {progressHeadline(view)}
        </span>
      </div>
      {view.phase === "live" || view.phase === "finished" ? <StepMeter progress={progress} tone={toneOf(view)} label={t("{label}：DiT 去噪進度", { label })} live={running} /> : null}
      {detailed ? <StepBars view={view} /> : null}
      {detailed || view.phase === "finished" ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-caption">
          <dt className="text-fg-tertiary">{running ? t("已執行") : t("DiT 耗時")}</dt>
          <dd className="machine text-fg-secondary" title={formatSpanExact(elapsed)}>
            {formatSpan(elapsed)}
          </dd>
          {detailed ? (
            <>
              <dt className="text-fg-tertiary">{t("每步（中位數）")}</dt>
              <dd className="min-w-0">
                {progress.typicalMs !== null ? (
                  <>
                    <span className="machine text-fg" title={formatSpanExact(progress.typicalMs)}>
                      {progress.source === "transfer" ? "≈ " : ""}
                      {formatSpan(progress.typicalMs)}
                    </span>
                    <span className="text-fg-tertiary">
                      {t("・{short} {durationsCount} 步{value}", { short: source.short, durationsCount: progress.durations.length, value: progress.lastMs !== null ? t("・最近一步 {lastMs}", { lastMs: formatSpan(progress.lastMs) }) : "" })}
                    </span>
                  </>
                ) : (
                  <span className="text-fg-tertiary">{running ? t("未量測（至少完成 1 步後才有）") : t("未量測")}</span>
                )}
              </dd>
            </>
          ) : null}
          {progress.gpuTypicalMs !== null ? (
            <>
              <dt className="text-fg-tertiary">{t("每步 GPU（中位數）")}</dt>
              <dd>
                <span className="machine text-fg" title={formatSpanExact(progress.gpuTypicalMs)}>
                  {formatSpan(progress.gpuTypicalMs)}
                </span>
                <span className="text-fg-tertiary">{t("・CUDA event 區間")}</span>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {progress.gap ? <p className="text-caption text-warning">{t("部分事件缺漏（上報為 best-effort），逐步數字可能不完整。")}</p> : null}
    </li>
  );
}

/**
 * 渲染詳情「階段」分頁的「DiT 去噪進度」：每個 DiT 分支一張卡（批次／變體依序排列）：步數、每步耗時與 GPU 時間。
 * 這個階段自己的剩餘（剩餘步數 × 本次每步中位數）與 remaining（依成本紀錄收斂的每個分支剩餘秒數，依後綴；null 或
 * 沒有＝無法估算）都在步數的提示裡，不另列：畫面上的剩餘時間只有 run 的一個（概覽）。
 */
export function DitProgressPanel({
  views,
  labelFor,
  now,
  error,
  remaining,
}: {
  views: readonly BranchView[];
  labelFor: (view: BranchView) => string;
  now: number | null;
  error: string | null;
  remaining?: ReadonlyMap<string, number | null>;
}) {
  return (
    <div className="grid gap-2">
      {error ? (
        <p role="status" className="text-caption text-warning [overflow-wrap:anywhere]">
          {t("讀取逐步事件失敗：{error}（下一輪會再讀；不影響渲染本身）", { error })}
        </p>
      ) : null}
      <ol aria-label={t("DiT 去噪進度")} className="grid gap-2">
        {views.map((view) => (
          <BranchCard key={view.stepId} view={view} label={labelFor(view)} now={now} converged={remaining?.get(view.suffix)} />
        ))}
      </ol>
    </div>
  );
}
