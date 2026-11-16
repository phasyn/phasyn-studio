// 一張生成圖的比較：原圖與生成圖並排、逐區段判斷與誤差貢獻（加權扣分 ÷ 可判斷權重）、差異與建議修訂、
// 非預期元素與可見文字。正式分數來自 prompt.scene_score；本頁依同一份比較與同一套規則重算一次，不一致時照實提醒。
import { Link } from "react-router";
import { IdText } from "@/components/common/values";
import { Disclosure } from "@/components/common/Disclosure";
import { Callout } from "@/components/ui/callout";
import { Table, TableScroll, Td, Th } from "@/components/ui/table";
import { runPath } from "@/app/paths";
import { formatFraction, formatLoss, lossAgreement, lossBreakdown, scoreBreakdown } from "../model/loss";
import type { ImageRow } from "../model/rows";
import { SECTION_LABELS } from "../model/sections";
import { evaluationTitle } from "../model/study";
import type { PromptRubric, PromptStudy } from "../types";
import { CompareChip, LossText, MetricChip, RenderChip, StudyImage } from "./shared";
import { stepErrorText } from "../model/stepError";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

function RunLink({ label, runId }: { label: string; runId: string | null }) {
  if (!runId) return null;
  return (
    <span className="flex flex-wrap items-center gap-1 text-caption text-fg-tertiary">
      {label}
      <Link to={runPath(runId)} className="machine text-caption" title={`run ${runId}`}>
        {runId.slice(0, 8)}
      </Link>
    </span>
  );
}

/** The headline of the generation's or the comparison's error, named after how the generation ended. */
function errorTitle(render: ImageRow["render"], code: string): string {
  if (!render.error) return t("{value}失敗：{code}", { value: t("比較"), code });
  if (render.state === "cancelled") return t("生成已取消：{code}", { code });
  if (render.state === "interrupted") return t("生成已中斷：{code}", { code });
  return t("{value}失敗：{code}", { value: t("生成"), code });
}

export function EvaluationDetail({ study, row, rubric }: { study: PromptStudy; row: ImageRow; rubric: PromptRubric | null }) {
  const { render, evaluation } = row;
  const title = evaluationTitle(study, render);
  const comparison = evaluation?.comparison ?? null;
  const score = evaluation?.score ?? null;
  const breakdown = score ? scoreBreakdown(score) : null;
  const local = comparison && score ? lossBreakdown(comparison, score.rubric.applicable_sections, score.rubric.intentional_changes) : null;
  const agreement = score && local ? lossAgreement(score, local) : null;
  const error = render.error ?? row.compareError;
  const rubricMismatch = score && rubric && score.rubric.sha256 !== rubric.sha256;
  return (
    <section className="grid min-w-0 gap-4" aria-label={t("比較：{title}", { title })}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-data font-semibold text-fg">{title}</h3>
        <RenderChip render={render} />
        <CompareChip status={row.compare} />
      </div>
      <div className="grid gap-3 @2xl:grid-cols-2">
        <figure className="grid gap-1.5">
          <div className="overflow-hidden rounded-xl border border-line-subtle bg-stage shadow-raised">
            <StudyImage file={study.source.file} alt={t("原圖")} className="max-h-80 w-full rounded-none border-0 bg-transparent" />
          </div>
          <figcaption className="text-caption text-fg-tertiary">{t("原圖（只用來分析與比較）")}</figcaption>
        </figure>
        <figure className="grid gap-1.5">
          <div className="overflow-hidden rounded-xl border border-line-subtle bg-stage shadow-raised">
            <StudyImage file={render.image} alt={t("生成圖：{title}", { title })} className="max-h-80 w-full rounded-none border-0 bg-transparent" />
          </div>
          <figcaption className="text-caption text-fg-tertiary">{t("生成圖（白底版；只用文字 prompt 生成）· seed {seed}", { seed: render.seed })}</figcaption>
        </figure>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <RunLink label={t("生成 run")} runId={render.run_id} />
        <RunLink label={t("比較 run（qimg.vision＋prompt.scene_score）")} runId={row.compareRunId} />
        {row.retried ? <span className="text-caption text-fg-tertiary">{t("這是較早沒有成功的嘗試（失敗、取消或中斷）；同一張圖之後已重新生成（這些嘗試也計入預算）。")}</span> : null}
      </div>
      {error ? (
        <Callout tone="danger" title={errorTitle(render, error.code)}>
          <p>{stepErrorText(error) || t("沒有訊息")}</p>
          {error.remote_outcome_unknown ? <p className="text-warning">{t("遠端結果未知：請到「紀錄・執行紀錄」確認，系統不會自動重送。")}</p> : null}
        </Callout>
      ) : null}
      {score && breakdown ? (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3 rounded-xl border border-line-subtle bg-sunken/50 p-3">
          <div className="grid gap-0.5">
            <dt className="text-caption text-fg-tertiary">{t("誤差（prompt.scene_score）")}</dt>
            <dd className="text-metric">
              <LossText loss={score.loss} unverified={score.unverified} />
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-caption text-fg-tertiary">{t("可判斷權重")}</dt>
            <dd className="machine text-data text-fg">{formatFraction(score.evaluable_weight_fraction)}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-caption text-fg-tertiary">{t("本頁依同一份比較重算")}</dt>
            <dd className="machine text-data text-fg">
              {local ? formatLoss(local.loss) : "—"}
              {agreement === "disagree" ? <span className="block font-sans text-caption text-warning">{t("與元件回報的不同（以元件為準）")}</span> : null}
            </dd>
          </div>
        </dl>
      ) : null}
      <p className="text-caption text-fg-tertiary">{t("誤差是機器評審的差異量（0＝全部符合，3＝全部缺少），不是相似百分比；不同評分規則（rubric）的結果不能直接比較。")}</p>
      {score && score.unverified_reasons.length > 0 ? (
        <ul className="grid list-disc gap-0.5 pl-5 text-caption text-warning">
          {score.unverified_reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {rubricMismatch ? <p className="text-caption text-warning">{t("這次評分的規則雜湊與任務凍結的不同：不能與其他圖直接比較。")}</p> : null}
      {comparison && breakdown ? (
        <TableScroll label={t("逐區段判斷與誤差")}>
          <Table className="min-w-[40rem]">
            <thead>
              <tr>
                <Th scope="col">{t("區段")}</Th>
                <Th scope="col">{t("判斷")}</Th>
                <Th scope="col" className="text-right">
                  {t("權重")}
                </Th>
                <Th scope="col" className="text-right">
                  {t("扣分")}
                </Th>
                <Th scope="col" className="text-right">
                  {t("貢獻")}
                </Th>
                <Th scope="col">{t("依據")}</Th>
              </tr>
            </thead>
            <tbody>
              {breakdown.rows.map((item) => (
                <tr key={item.key} className={item.applicable ? undefined : "text-fg-tertiary"}>
                  <Td>
                    <span className="text-fg">{SECTION_LABELS[item.key]}</span>
                    {item.applicable ? null : <span className="block text-caption">{t("不在評分範圍")}</span>}
                    {item.intentional ? <span className="block text-caption text-info">{t("有意修改：以修改後的內容為目標")}</span> : null}
                  </Td>
                  <Td>
                    <MetricChip label={item.label} />
                  </Td>
                  <Td className="machine text-right">{item.weight}</Td>
                  <Td className="machine text-right">{item.penalty ?? "—"}</Td>
                  <Td className="machine text-right">{item.contribution === null ? "—" : item.contribution.toFixed(3)}</Td>
                  <Td className="text-caption text-fg-secondary">{comparison.sections[item.key].evidence_zh_tw || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      ) : render.state === "succeeded" ? (
        <p className="text-caption text-fg-tertiary">{t("還沒有比較結果；圖片完成不代表比較完成。")}</p>
      ) : null}
      {comparison ? (
        <div className="grid gap-2">
          {comparison.unjudgeable_reason ? <Callout tone="warning" title={t("視覺模型表示無法判斷")}>{comparison.unjudgeable_reason}</Callout> : null}
          <Disclosure summary={t("差異與建議修訂 · {differencesCount}", { differencesCount: comparison.differences.length })} defaultOpen={comparison.differences.length > 0}>
            {comparison.differences.length === 0 ? (
              <p className="text-caption text-fg-tertiary">{t("沒有列出差異。")}</p>
            ) : (
              <ol className="grid list-decimal gap-1.5 pl-5 text-caption">
                {comparison.differences.map((difference, index) => (
                  <li key={`${difference.section}-${index}`} className="grid gap-0.5">
                    <span className="text-fg">
                      <span className="text-fg-tertiary">{t("{section}：", { section: SECTION_LABELS[difference.section] })}</span>
                      {difference.description_zh_tw}
                    </span>
                    {difference.suggested_change_en ? (
                      <span className="text-fg-secondary">
                        <span>{t("建議：")}</span>
                        <span lang="en">{difference.suggested_change_en}</span>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </Disclosure>
          {comparison.unexpected_elements.length > 0 ? (
            <Disclosure summary={t("非預期元素 · {unexpected_elementsCount}", { unexpected_elementsCount: comparison.unexpected_elements.length })}>
              <ul className="grid list-disc gap-0.5 pl-5 text-caption text-fg-secondary">
                {comparison.unexpected_elements.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
          {comparison.text_transcription ? <p className="text-caption text-fg-secondary">{t("評審讀到的文字：{text_transcription}", { text_transcription: comparison.text_transcription })}</p> : null}
          {score ? (
            <p className="flex flex-wrap items-center gap-1 text-caption text-fg-tertiary">
              <T source={"評分規則雜湊 <0/> · <1>{scorer_version}</1>"} values={{ scorer_version: score.scorer_version }} slots={[<IdText value={score.rubric.sha256} length={12} />, <span className="machine" />]} />
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
