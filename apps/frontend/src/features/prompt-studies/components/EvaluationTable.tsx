// 生成圖的清單：縮圖、版本／候選／seed、生成與比較的狀態、誤差與第一個差異；點一列（或在列上的按鈕按 Enter）看比較細節。
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import type { ImageRow } from "../model/rows";
import { SECTION_LABELS } from "../model/sections";
import { versionLabel } from "../model/study";
import type { PromptStudy } from "../types";
import { CompareChip, LossText, RenderChip, StudyImage } from "./shared";
import { stepErrorText } from "../model/stepError";
import { t } from "@/i18n";
import { failureText } from "@/lib/errors";

function whereText(row: ImageRow): string {
  const { split, round } = row.render;
  return split === "search" ? t(" · 第 {round} 輪", { round: round + 1 }) : split === "holdout" ? t(" · 保留驗證") : "";
}

export function EvaluationTable({
  study,
  rows,
  selectedId,
  onSelect,
  label,
}: {
  study: PromptStudy;
  rows: readonly ImageRow[];
  selectedId: string | null;
  onSelect: (renderRunId: string) => void;
  label: string;
}) {
  return (
    <TableScroll label={label}>
      <Table className="min-w-[44rem]">
        <thead>
          <tr>
            <Th scope="col" className="w-14">
              <span className="sr-only">{t("生成圖")}</span>
            </Th>
            <Th scope="col">{t("候選與 seed")}</Th>
            <Th scope="col">{t("進度")}</Th>
            <Th scope="col" className="text-right">
              {t("誤差")}
            </Th>
            <Th scope="col">{t("第一個差異")}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const evaluation = row.evaluation;
            const first = evaluation?.comparison.differences[0];
            const selected = row.id === selectedId;
            return (
              <Tr key={row.id} selected={selected} onClick={() => { onSelect(row.id); }} className="cursor-pointer">
                <Td>
                  <StudyImage file={row.render.image} alt={t("seed {seed} 的生成圖", { seed: row.render.seed })} className="size-10 rounded-lg" fit="cover" />
                </Td>
                <Td>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(row.id);
                    }}
                    className="grid gap-0.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <span className="text-fg">{`${versionLabel(study, row.render.version_id)} ${row.render.variant}`}</span>
                    <span className="machine text-caption text-fg-tertiary">{`seed ${String(row.render.seed)}${whereText(row)}${row.retried ? t(" · 已重試") : ""}`}</span>
                  </button>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <RenderChip render={row.render} />
                    <CompareChip status={row.compare} {...(row.compareError ? { title: failureText(row.compareError.code, stepErrorText(row.compareError)) } : {})} />
                  </div>
                </Td>
                <Td className="text-right">
                  <LossText loss={evaluation?.score.loss ?? null} unverified={evaluation ? evaluation.score.unverified : null} />
                </Td>
                <Td className="max-w-72 text-caption text-fg-secondary">
                  {first ? (
                    <span className="line-clamp-2">
                      <span className="text-fg-tertiary">{t("{section}：", { section: SECTION_LABELS[first.section] })}</span>
                      {first.description_zh_tw}
                    </span>
                  ) : (
                    <span className="text-fg-tertiary">—</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroll>
  );
}
