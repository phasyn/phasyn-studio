// One bounded search task in the center column: budget, current best, each round, the holdout check and the ranking.
import { BadgeCheck, Eye, Send } from "lucide-react";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { candidateOf, uniqueCandidates } from "../../model/compile";
import { formatLoss } from "../../model/loss";
import { isRunStep, planTask, searchProgress } from "../../model/planner";
import { imageRows } from "../../model/rows";
import { SEARCH_LIMITS } from "../../model/search";
import { acceptBlockReason, candidateLabel, evaluationsOf, findVersion, imagesUsed, pairwiseOf, sameCandidate, stopReasonText, versionLabel, versionRefsOf, visionOpsUsed } from "../../model/study";
import type { CandidateRef, PromptStudyTask, TaskSettings } from "../../types";
import { EvaluationDetail } from "../EvaluationDetail";
import { TaskStateChip } from "../shared";
import type { Workspace } from "../workspace";
import { t } from "@/i18n";
import type { ReconstructRequest, SearchController } from "./controller";
import { gridRows } from "./grid";
import { Meter, PairwiseBlock, RankingTable, RoundChip, RoundGrid } from "./SearchResults";

export function SearchTaskView({ ws, search, task, request, settings }: { ws: Workspace; search: SearchController; task: PromptStudyTask; request: ReconstructRequest; settings: TaskSettings | null }) {
  const { study } = ws;
  const progress = searchProgress(study, task);
  const rows = imageRows(study, task);
  const evaluations = evaluationsOf(task);
  const revisions = versionRefsOf(task);
  const pairwise = pairwiseOf(task);
  const next = task.state === "running" ? planTask(study, task) : null;
  const incumbent = progress?.incumbent?.ref ?? task.best;
  const selected = rows.find((row) => row.id === search.rowId) ?? null;
  const shownRounds = Math.min(request.max_rounds, Math.max(1, (progress?.rounds.length ?? 0), revisions.length + 1));
  const holdout = rows.filter((row) => row.render.split === "holdout");
  const holdoutRefs: CandidateRef[] = [];
  for (const row of holdout) if (!holdoutRefs.some((ref) => ref.version_id === row.render.version_id && ref.variant === row.render.variant)) holdoutRefs.push({ version_id: row.render.version_id, variant: row.render.variant });
  const acceptReason = incumbent ? acceptBlockReason(study, incumbent) : null;
  return (
    <div className="@container grid min-w-0 gap-5 p-4">
      <section className="grid gap-3 @3xl:grid-cols-2" aria-label={t("預算")}>
        <Meter label={t("圖片（失敗、取消也計入）")} used={imagesUsed(task)} max={request.max_images} cap={SEARCH_LIMITS.maxImages} unit={t("張")} />
        <Meter label={t("已決定的輪數")} used={progress?.decidedRounds ?? 0} max={request.max_rounds} cap={SEARCH_LIMITS.maxRounds} unit={t("輪")} />
        <Meter label={t("視覺操作")} used={visionOpsUsed(task)} max={request.max_vision_operations} cap={SEARCH_LIMITS.maxVisionOps} unit={t("次")} />
        <Meter label={t("連續沒有改善")} used={progress?.noImprovement ?? 0} max={request.stop_after_no_improvement} cap={SEARCH_LIMITS.stopAfter.max} unit={t("輪")} />
      </section>
      <section
        className={cn("grid gap-2 rounded-xl border p-3 transition-[background-color,border-color] duration-(--duration-base)", incumbent ? "border-transparent bg-brand-gradient-soft border-brand-gradient" : "border-line-subtle bg-sunken/40")}
        aria-labelledby={`${task.task_id}-best`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${task.task_id}-best`} className="text-data font-semibold text-fg">
            {task.state === "running" ? t("目前最佳") : t("搜尋結果")}
          </h3>
          <TaskStateChip task={task} />
          {task.stop_reason ? <span className="text-caption text-fg-tertiary">{t("停止原因：{stop_reason}", { stop_reason: stopReasonText(task.stop_reason) })}</span> : null}
          <span className="text-caption text-fg-tertiary">{t("驗證程度：{verification}", { verification: VERIFICATION_TEXT[task.verification] })}</span>
        </div>
        {incumbent ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-data font-medium text-fg">{candidateLabel(study, incumbent)}</span>
            <span className="machine text-caption text-fg-secondary">{t("平均誤差 {formatLoss}", { formatLoss: formatLoss(progress?.ranked.find((item) => sameCandidate(item.ref, incumbent))?.meanLoss ?? null) })}</span>
            <Button size="sm" variant="quiet" icon={<Eye aria-hidden />} onClick={() => { ws.showCandidate(incumbent); }}>
              {t("在場景中檢視")}
            </Button>
            <ActionButton size="sm" variant="quiet" icon={<BadgeCheck aria-hidden />} disabledReason={acceptReason} onClick={() => { ws.requestAccept(incumbent, task.task_id); }}>
              {t("接受…")}
            </ActionButton>
            <ActionButton size="sm" variant="quiet" icon={<Send aria-hidden />} disabledReason={settings ? null : t("這個任務的生成設定無法解讀")} onClick={() => { if (settings) ws.requestApply(incumbent, settings); }}>
              {t("套用到 Image Studio…")}
            </ActionButton>
          </div>
        ) : (
          <p className="text-caption text-fg-tertiary">{t("初始輪完成且可判斷後才會有最佳候選。")}</p>
        )}
      </section>
      {Array.from({ length: shownRounds }, (_, round) => round).map((round) => {
        const view = progress?.rounds.find((item) => item.round === round);
        const revision = round > 0 ? revisions[round - 1] : undefined;
        const versionId = round === 0 ? task.base_version_id : (revision?.version_id ?? null);
        const version = findVersion(study, versionId);
        const roundRows = rows.filter((row) => row.render.split === "search" && row.render.round === round);
        const refs = version ? uniqueCandidates(version.candidates.items).map((candidate) => ({ version_id: version.version_id, variant: candidate.variant })) : [];
        const grid = gridRows(roundRows, refs).map((row) => {
          const sha = candidateOf(version, row.ref.variant)?.prompt_sha256;
          const reused = round > 0 && row.cells.size === 0 && evaluations.some((item) => item.split === "search" && item.round < round && candidateOf(findVersion(study, item.version_id), item.variant)?.prompt_sha256 === sha);
          return { ...row, reused };
        });
        const pendingRevise = next && isRunStep(next) && next.kind === "revise" && next.round === round ? next : null;
        const pendingPair = next && isRunStep(next) && next.kind === "pairwise" && next.round === round ? next : null;
        const parent = version?.parent_version_id ?? pendingRevise?.fromVersionId ?? null;
        return (
          <section key={round} className="grid gap-3 border-t border-line-subtle pt-4" aria-labelledby={`${task.task_id}-round-${String(round)}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={`${task.task_id}-round-${String(round)}`} className="text-data font-semibold text-fg">
                {t("第 {round} 輪{value}", { round: round + 1, value: (versionId != null && versionId !== "") ? ` · ${versionLabel(study, versionId)}` : "" })}
              </h3>
              <RoundChip ws={ws} view={view} round={round} />
            </div>
            {round > 0 ? (
              <div className="grid gap-1 rounded-lg border border-line-subtle p-3 text-caption">
                <p className="text-fg">
                  {`${(parent != null && parent !== "") ? t("依 {versionLabel} 誤差最高那張的前三個差異修訂（鎖定區段逐字保留）", { versionLabel: versionLabel(study, parent) }) : t("等待上一輪的結果")}${
                    (revision?.run_id != null && revision.run_id !== "") ? "" : pendingRevise ? (pendingRevise.action === "attach" ? t(" · 修訂中") : pendingRevise.action === "retry" ? t(" · 修訂失敗：要明確重試") : t(" · 下一步")) : ""
                  }`}
                </p>
                {(version?.note != null && version.note !== "") ? <p className="text-fg-tertiary">{version.note}</p> : null}
              </div>
            ) : null}
            {grid.length > 0 ? <RoundGrid ws={ws} rows={grid} seeds={request.search_seeds} selectedId={search.rowId} onSelect={search.setRowId} label={t("第 {round} 輪的評估", { round: round + 1 })} /> : null}
            {pairwise
              .filter((item) => item.round === round)
              .map((item) => (
                <PairwiseBlock key={item.run_id} ws={ws} record={item} />
              ))}
            {pendingPair ? (
              <p className="text-caption text-fg-secondary">
                {t("A/B＋B/A：{candidateLabel}（目前最佳）vs {candidateLabel2}（挑戰者）· seed {seed}{value}", { candidateLabel: candidateLabel(study, pendingPair.incumbent), candidateLabel2: candidateLabel(study, pendingPair.challenger), seed: pendingPair.seed, value: pendingPair.action === "attach" ? t(" · 比較中") : pendingPair.action === "retry" ? t(" · 失敗：要明確重試") : t(" · 下一步") })}
              </p>
            ) : null}
            {(view?.decided === true) && view.note ? <p className="text-caption text-fg-tertiary">{view.note}</p> : null}
          </section>
        );
      })}
      {holdout.length > 0 || (progress?.stoppedEarly === true) || (progress?.decidedRounds ?? 0) >= request.max_rounds ? (
        <section className="grid gap-2 border-t border-line-subtle pt-4" aria-labelledby={`${task.task_id}-holdout`}>
          <h3 id={`${task.task_id}-holdout`} className="text-data font-semibold text-fg">
            {t("保留驗證（seed {holdout_seeds}；不參與修詞）", { holdout_seeds: request.holdout_seeds.join(", ") })}
          </h3>
          {holdout.length === 0 ? (
            <p className="text-caption text-fg-tertiary">{t("還沒有保留驗證的圖。")}</p>
          ) : (
            <RoundGrid ws={ws} rows={gridRows(holdout, holdoutRefs)} seeds={request.holdout_seeds} selectedId={search.rowId} onSelect={search.setRowId} label={t("保留驗證的評估")} />
          )}
          <p className="text-caption text-fg-tertiary">{t("驗證目前最佳與下一個完整、文字不同的候選；保留驗證只回報，不改變最佳候選。")}</p>
        </section>
      ) : null}
      <section className="grid gap-2 border-t border-line-subtle pt-4" aria-labelledby={`${task.task_id}-ranking`}>
        <h3 id={`${task.task_id}-ranking`} className="text-data font-semibold text-fg">
          {t("排名（搜尋 seed {search_seeds}）", { search_seeds: request.search_seeds.join(", ") })}
        </h3>
        <RankingTable ws={ws} ranked={progress?.ranked ?? []} seeds={request.search_seeds} incumbent={incumbent} />
      </section>
      {selected ? (
        <section key={selected.id} className="border-t border-line-subtle pt-4 animate-rise-in">
          <EvaluationDetail study={study} row={selected} rubric={task.rubric} />
        </section>
      ) : null}
    </div>
  );
}

const VERIFICATION_TEXT: Record<PromptStudyTask["verification"], string> = {
  analysis_only: t("只有分析"),
  rendered: t("已生成"),
  search_evaluated: t("搜尋 seed 已評估"),
  holdout_evaluated: t("保留驗證已完成"),
};
