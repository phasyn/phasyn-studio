// Building blocks of the search results: budget meters, pairwise verdicts, the round grid (candidate × seed) and the
// ranking table.
import { ArrowLeftRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableScroll, Td, Th } from "@/components/ui/table";
import { StatusChip } from "@/components/workbench/StatusChip";
import { cn } from "@/lib/cn";
import { formatLoss } from "../../model/loss";
import type { RoundView } from "../../model/planner";
import type { ImageRow } from "../../model/rows";
import type { RankedCandidate } from "../../model/search";
import { SECTION_LABELS } from "../../model/sections";
import { candidateLabel, sameCandidate } from "../../model/study";
import type { CandidateRef, PairwiseRef, PromptPairwise } from "../../types";
import { LossText } from "../shared";
import type { Workspace } from "../workspace";
import { formatList } from "@/i18n/format";
import { t } from "@/i18n";
import type { GridRow } from "./grid";

export function Meter({ label, used, max, cap, unit }: { label: string; used: number; max: number; cap: number; unit: string }) {
  const ratio = max > 0 ? Math.min(1, used / max) : 0;
  const tone = used >= max ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "bg-info";
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2 text-caption">
        <span className="text-fg-secondary">{label}</span>
        <span className="machine flex items-baseline gap-1">
          <span className="text-fg">{`${used}/${max} ${unit}`}</span>
          <span className="text-fg-tertiary">{t("（上限 {cap}）", { cap })}</span>
        </span>
      </div>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={used} className="h-1.5 overflow-hidden rounded-full bg-sunken shadow-[inset_0_0_0_1px_var(--color-line-subtle)]">
        <div className={cn("h-full w-full origin-left rounded-full transition-transform duration-(--duration-base) ease-standard", tone)} style={{ transform: `scaleX(${ratio})` }} />
      </div>
    </div>
  );
}

const WINNER_TEXT: Record<PromptPairwise["winner"], string> = { A: t("A 較接近"), B: t("B 較接近"), tie: t("平手"), uncertain: t("不確定") };

function VerdictLine({ label, verdict, a, b }: { label: string; verdict: PromptPairwise; a: string; b: string }) {
  return (
    <div className="grid gap-0.5 text-caption">
      <p className="flex flex-wrap items-baseline gap-x-1 text-fg">
        <span>{t("{label}（A＝{a}，B＝{b}）：", { label, a, b })}</span>
        <span className="font-medium">{WINNER_TEXT[verdict.winner]}</span>
      </p>
      {verdict.reason_zh_tw ? <p className="text-fg-secondary">{verdict.reason_zh_tw}</p> : null}
      {verdict.violated_sections.length > 0 ? <p className="text-fg-tertiary">{t("違反的區段：{map}", { map: formatList(verdict.violated_sections.map((key) => SECTION_LABELS[key])) })}</p> : null}
    </div>
  );
}

export function PairwiseBlock({ ws, record }: { ws: Workspace; record: PairwiseRef }) {
  const incumbent = candidateLabel(ws.study, record.incumbent);
  const challenger = candidateLabel(ws.study, record.challenger);
  return (
    <div className="grid gap-2 rounded-xl border border-line-subtle bg-canvas p-3 animate-rise-in">
      <div className="flex flex-wrap items-center gap-2">
        <ArrowLeftRight aria-hidden className="size-4 text-fg-tertiary" />
        <span className="text-data font-medium text-fg">{t("雙順序比較 · seed {seed}", { seed: record.seed })}</span>
        {record.confirmed ? <StatusChip tone="success" label={t("確認：挑戰者勝出")} /> : <StatusChip tone="neutral" label={t("未確認：保留目前最佳")} />}
      </div>
      <VerdictLine label="A/B" verdict={record.ab} a={t("{incumbent}（目前最佳）", { incumbent })} b={t("{challenger}（挑戰者）", { challenger })} />
      <VerdictLine label="B/A" verdict={record.ba} a={t("{challenger}（挑戰者）", { challenger })} b={t("{incumbent}（目前最佳）", { incumbent })} />
    </div>
  );
}

/** 生成或比較還沒完成的格子：顯示狀態文字。 */
function cellState(row: ImageRow): string {
  if (row.render.state === "unknown") return t("生成中");
  // A cancelled or interrupted generation did not fail: it is named after how it ended
  if (row.render.state === "cancelled") return t("生成已取消");
  if (row.render.state === "interrupted") return t("生成已中斷");
  if (row.render.state !== "succeeded") return t("生成失敗");
  if (row.compare === "running") return t("比較中");
  if (row.compare === "failed") return t("比較失敗");
  if (row.compare === "skipped") return t("沒有比較");
  return t("等待比較");
}


/** 一輪（或保留驗證）的圖：列＝候選，欄＝seed；點格子看比較細節。 */
export function RoundGrid({ ws, rows, seeds, selectedId, onSelect, label }: { ws: Workspace; rows: readonly GridRow[]; seeds: readonly number[]; selectedId: string | null; onSelect: (id: string) => void; label: string }) {
  return (
    <TableScroll label={label}>
      <Table className="w-auto min-w-[24rem]">
        <thead>
          <tr>
            <Th scope="col">{t("候選")}</Th>
            {seeds.map((seed) => (
              <Th key={seed} scope="col" className="text-right">
                seed {seed}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.ref.version_id}-${row.ref.variant}`}>
              <Td>
                <span>{candidateLabel(ws.study, row.ref)}</span>
                {row.reused ? <span className="block text-caption text-fg-tertiary">{t("文字與前一輪相同：沿用前一輪的評估")}</span> : null}
              </Td>
              {seeds.map((seed) => {
                const cell = row.cells.get(seed);
                return (
                  <Td key={seed} className="text-right">
                    {cell ? (
                      <button
                        type="button"
                        aria-pressed={cell.id === selectedId}
                        onClick={() => onSelect(cell.id)}
                        className="pressable rounded-md px-1.5 hover:bg-raised aria-pressed:bg-brand-gradient-soft aria-pressed:shadow-[inset_0_0_0_1px_rgb(79_123_255/0.45)] focus-visible:outline-2 focus-visible:outline-focus"
                        title={t("看比較細節")}
                      >
                        {cell.evaluation ? <LossText loss={cell.evaluation.score.loss} unverified={cell.evaluation.score.unverified} /> : <span className="text-caption text-fg-secondary">{cellState(cell)}</span>}
                      </button>
                    ) : (
                      <span className="text-fg-tertiary">{row.reused ? t("沿用") : "—"}</span>
                    )}
                  </Td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

export function RankingTable({ ws, ranked, seeds, incumbent }: { ws: Workspace; ranked: readonly RankedCandidate[]; seeds: readonly number[]; incumbent: CandidateRef | null }) {
  if (ranked.length === 0) return <p className="text-caption text-fg-tertiary">{t("還沒有可排名的評估。")}</p>;
  return (
    <TableScroll label={t("搜尋 seed 上的排名")}>
      <Table className="w-auto min-w-[28rem]">
        <thead>
          <tr>
            <Th scope="col">{t("候選")}</Th>
            <Th scope="col" className="text-right">
              {t("平均誤差")}
            </Th>
            {seeds.map((seed) => (
              <Th key={seed} scope="col" className="text-right">
                seed {seed}
              </Th>
            ))}
            <Th scope="col">{t("狀態")}</Th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((item) => (
            <tr key={`${item.ref.version_id}-${item.ref.variant}`} className={sameCandidate(item.ref, incumbent) ? "bg-brand-gradient-soft" : undefined}>
              <Td>{candidateLabel(ws.study, item.ref)}</Td>
              <Td className="machine text-right">{formatLoss(item.meanLoss)}</Td>
              {seeds.map((seed) => {
                const evaluation = item.evaluations.find((row) => row.seed === seed);
                return (
                  <Td key={seed} className="text-right">
                    {evaluation ? <LossText loss={evaluation.score.loss} unverified={evaluation.score.unverified} /> : <span className="text-fg-tertiary">—</span>}
                  </Td>
                );
              })}
              <Td>{sameCandidate(item.ref, incumbent) ? <Badge tone="success">{t("目前最佳")}</Badge> : item.complete ? <Badge>{t("完整")}</Badge> : <Badge tone="warning">{t("不完整（不能勝出）")}</Badge>}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

export function RoundChip({ ws, view, round }: { ws: Workspace; view: RoundView | undefined; round: number }) {
  if (!view || !view.decided) return <StatusChip tone="neutral" label={view?.note ?? t("未開始")} />;
  if (round === 0) return <StatusChip tone="info" label={t("初始最佳：{value}", { value: view.incumbent ? candidateLabel(ws.study, view.incumbent) : "—" })} />;
  return view.improved && view.incumbent ? <StatusChip tone="success" label={t("改善：{candidateLabel}", { candidateLabel: candidateLabel(ws.study, view.incumbent) })} /> : <StatusChip tone="neutral" label={t("沒有改善")} />;
}

