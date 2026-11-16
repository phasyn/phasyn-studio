// 設定差異：路徑 × recording；與基準（第 1 欄）不同的格標「≠ 基準」（文字＋色，不只靠顏色）。
// 「不存在」「null」「未知」分開顯示；從 context 讀出的格另外註明來源。
// 表格不自帶捲動容器：由比較內容區捲動，表頭與路徑欄保持可見（stickyTable.ts）。
import { TriangleAlert } from "lucide-react";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatSettingValue } from "../../model/settings";
import type { DiffCell, DiffRow } from "../model/settingsDiff";
import { ColumnHead, type ColumnState } from "./ColumnHead";
import { BASELINE_CELL, BASELINE_HEAD, CORNER_CELL, HEAD_CELL, ROW_HEAD_CELL } from "./stickyTable";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

function CellText({ cell }: { cell: DiffCell }) {
  if (cell.state === "unknown") return <span className="text-caption text-fg-tertiary">{t("未知")}</span>;
  if (cell.state === "absent") {
    return (
      <span className="text-caption text-fg-tertiary">
        <T source={"（不存在）{value}"} values={{ value: cell.resolved ? <span className="block">{t("由 context 判斷")}</span> : null }} />
      </span>
    );
  }
  return (
    <span className="grid gap-0.5">
      <code className={cn("machine break-words whitespace-pre-wrap", cell.value === null ? "text-fg-tertiary" : "text-fg")}>{formatSettingValue(cell.value)}</code>
      {cell.resolved ? <span className="text-caption text-fg-tertiary">{t("由 context 讀出")}</span> : null}
    </span>
  );
}

export function SettingsDiffTable({
  rows,
  columns,
  changedOnly,
  labelledBy,
}: {
  rows: readonly DiffRow[];
  columns: readonly ColumnState[];
  /** 只顯示與基準不同（或無法解讀）的路徑；開關在區段標題列。 */
  changedOnly: boolean;
  labelledBy: string;
}) {
  const visible = changedOnly ? rows.filter((row) => row.anyChange) : rows;
  return (
    <Table aria-labelledby={labelledBy}>
      <thead>
        <tr>
          <Th scope="col" className={cn("min-w-[14rem]", CORNER_CELL)}>
            {t("路徑")}
          </Th>
          {columns.map((column, index) => (
            <Th key={column.id} scope="col" className={cn(HEAD_CELL, index === 0 && BASELINE_HEAD)}>
              <ColumnHead index={index} column={column} />
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {visible.length === 0 ? (
          <tr>
            <Td colSpan={columns.length + 1} className="text-data text-fg-secondary">
              <span className="sticky left-4 inline-block max-w-[60ch]">
                {t("沒有與基準不同的路徑（共 {rowsCount} 個；「未知」的格不算不同）。取消勾選「只顯示與基準不同的路徑」可列出全部。", { rowsCount: rows.length })}
              </span>
            </Td>
          </tr>
        ) : (
          visible.map((row) => (
            <Tr key={row.path}>
              <Th scope="row" className={cn("max-w-[22rem] min-w-[14rem] border-b-line-subtle align-top text-data font-normal whitespace-normal text-fg-secondary", ROW_HEAD_CELL)}>
                <code className="machine break-all">{row.path}</code>
                {row.raw ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-caption text-warning">{t("無法完全解讀此差異項目，展開原文")}</summary>
                    <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-sunken p-2 text-caption whitespace-pre-wrap text-fg-secondary">{JSON.stringify(row.raw, null, 2)}</pre>
                  </details>
                ) : null}
              </Th>
              {row.cells.map((cell, index) => {
                const changed = row.changed[index] ?? false;
                return (
                  <Td key={columns[index]?.id ?? index} className={cn("min-w-[10rem]", index === 0 && BASELINE_CELL, changed && "bg-warning/8")}>
                    <CellText cell={cell} />
                    {changed ? (
                      <span className="mt-1 flex items-center gap-1 text-caption text-warning">
                        <TriangleAlert aria-hidden className="size-3.5" />{t("≠ 基準")}
                      </span>
                    ) : null}
                  </Td>
                );
              })}
            </Tr>
          ))
        )}
      </tbody>
    </Table>
  );
}
