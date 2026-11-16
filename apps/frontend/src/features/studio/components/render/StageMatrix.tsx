// Stage matrix of a run: one row per branch, one column per template step (state, measured time, DiT progress), with a
// total per branch and per step so a batch shows where its time went. Readable at every width through a container
// query on its own width: from 52.5rem it is a table whose state words never wrap and whose times use the workspace's
// compact format (exact value, Node and step id in the cell's tooltip); below that, one card row per branch with one
// dot per stage, the current stage in words and the branch's total. Both come from the same rows (only one is
// displayed); data areas stay crisp: no glow, state colours only.
import { LoaderCircle } from "lucide-react";
import { parseRunStep, type WireRun } from "@/api/types";
import { CARD } from "@/components/ui/look";
import { joinInline } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { runStepIds } from "../../model/pipelines";
import { progressHeadline, stepRole, type BranchView, type ProviderLookup } from "../../model/progress";
import { branchLabel, stageColumns, STEP_STATE_LABEL, suffixOf, type QueueItem, type StageColumn } from "../../model/renderQueue";
import { nodeShortName } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { StepCellProgress } from "../RenderProgress";
import { stepElapsed } from "./runView";
import { formatSpan, formatSpanExact } from "./time";
import { t } from "@/i18n";

const STATE_CELL: Record<string, string> = {
  succeeded: "border-success/40 bg-success/10 text-success",
  running: "border-info/50 bg-info/10 text-info",
  waiting: "border-line bg-raised text-fg-secondary",
  pending: "border-line-subtle bg-canvas text-fg-tertiary",
  failed: "border-danger/50 bg-danger/10 text-danger",
  cancelled: "border-line bg-canvas text-fg-tertiary",
  interrupted: "border-warning/40 bg-warning/10 text-warning",
  skipped: "border-line-subtle bg-canvas text-fg-tertiary",
};
const STATE_DOT: Record<string, string> = {
  succeeded: "bg-success",
  running: "bg-info ring-2 ring-info/35",
  waiting: "bg-fg-tertiary ring-2 ring-line-strong",
  pending: "border border-line-strong",
  failed: "bg-danger",
  cancelled: "bg-fg-tertiary/60",
  interrupted: "bg-warning",
  skipped: "border border-dashed border-line-strong",
};
const TOTAL_CELL = "machine rounded-md border border-line-subtle bg-canvas px-1.5 py-1.5 align-top font-semibold whitespace-nowrap text-fg";

interface Cell {
  column: StageColumn;
  /** The run has this step for this branch. */
  known: boolean;
  state: string;
  ms: number | null;
  /** Tooltip: stage, state, exact time, Node, step id. */
  title: string;
  /** The running DiT's view (its step count). */
  view: BranchView | undefined;
}

interface Row {
  key: string;
  label: string;
  title: string;
  seed: number | null;
  cells: Cell[];
  totalMs: number | null;
}

/** Sum of the measured durations; null when nothing was measured yet. */
function sumMs(values: readonly (number | null)[]): number | null {
  let total = 0;
  let measured = false;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    measured = true;
  }
  return measured ? total : null;
}

function buildRows(run: WireRun, item: QueueItem, now: number | null, views: readonly BranchView[], lookup: ProviderLookup, nodeLabel: (nodeId: string | null) => string): { columns: StageColumn[]; rows: Row[] } {
  const columns = stageColumns(run, lookup);
  const known = new Set(runStepIds(run));
  const branches =
    item.kind === "export"
      ? [{ key: "export", label: t("序列"), title: t("序列"), seed: null as number | null, suffix: "" }]
      : item.takes.map((entry) => {
          const label = branchLabel(item, entry, "");
          return { key: entry.take.take_id, label, title: entry.shot.title, seed: item.kind === "variations" ? entry.take.seed : null, suffix: suffixOf(entry.take) };
        });
  const rows = branches.map((branch): Row => {
    const cells = columns.map((column): Cell => {
      const stepId = `${column.base}${branch.suffix}`;
      if (!known.has(stepId)) return { column, known: false, state: "pending", ms: null, title: t("{stage}：不適用", { stage: column.label }), view: undefined };
      const step = parseRunStep(stepId, run.steps[stepId]);
      const state = step.state === "unknown" ? "pending" : step.state;
      const ms = stepElapsed(run, stepId, now);
      const view = state === "running" && stepRole(run, stepId, lookup) === "dit" ? views.find((entry) => entry.suffix === branch.suffix) : undefined;
      const node = step.node_id ? nodeShortName(nodeLabel(step.node_id)) : "";
      const title = joinInline([t("{stage}：{state}", { stage: column.label, state: STEP_STATE_LABEL[state] ?? state }), ms !== null ? formatSpanExact(ms) : "", node, stepId].filter(Boolean));
      return { column, known: true, state, ms, title, view };
    });
    return { key: branch.key, label: branch.label, title: branch.title, seed: branch.seed, cells, totalMs: sumMs(cells.map((cell) => cell.ms)) };
  });
  return { columns, rows };
}

/** What a branch is doing now, in words, and its tone (cards). */
function rowStatus(row: Row): { text: string; tone: string } {
  const running = row.cells.find((cell) => cell.state === "running");
  if (running) {
    return { text: running.view ? t("{stage}・{headline}", { stage: running.column.label, headline: progressHeadline(running.view) }) : t("{stage}・執行中", { stage: running.column.label }), tone: "text-info" };
  }
  const waiting = row.cells.find((cell) => cell.state === "waiting");
  if (waiting) return { text: t("{stage}・等待資源", { stage: waiting.column.label }), tone: "text-fg-secondary" };
  const failed = row.cells.find((cell) => cell.state === "failed");
  if (failed) return { text: t("{stage}失敗", { stage: failed.column.label }), tone: "text-danger" };
  if (row.cells.some((cell) => cell.state === "interrupted")) return { text: STEP_STATE_LABEL.interrupted ?? "", tone: "text-warning" };
  if (row.cells.some((cell) => cell.state === "cancelled")) return { text: STEP_STATE_LABEL.cancelled ?? "", tone: "text-fg-secondary" };
  const present = row.cells.filter((cell) => cell.known);
  if (present.length > 0 && present.every((cell) => cell.state === "succeeded" || cell.state === "skipped")) return { text: STEP_STATE_LABEL.succeeded ?? "", tone: "text-success" };
  return { text: STEP_STATE_LABEL.pending ?? "", tone: "text-fg-tertiary" };
}

function StageDots({ cells }: { cells: readonly Cell[] }) {
  return (
    <ol aria-label={t("各階段")} className="flex shrink-0 items-center gap-1.5">
      {cells.map((cell) => (
        <li key={cell.column.base} title={cell.title} className="grid size-3.5 place-items-center">
          <span aria-hidden className={cn("block size-2.5 rounded-full transition-colors duration-(--duration-base)", cell.known ? (STATE_DOT[cell.state] ?? STATE_DOT.pending) : "opacity-0")} />
          <span className="sr-only">{cell.title}</span>
        </li>
      ))}
    </ol>
  );
}

function StageCards({ rows }: { rows: readonly Row[] }) {
  return (
    <ul aria-label={t("各分支在每個步驟的狀態與耗時")} className="grid gap-1.5 @min-[52.5rem]/stages:hidden">
      {rows.map((row) => {
        const status = rowStatus(row);
        return (
          <li key={row.key} className={cn(CARD, "grid h-14 grid-cols-[minmax(0,1fr)_auto] content-center gap-x-3 gap-y-1 px-3")}>
            <span className="truncate text-data text-fg" title={row.seed !== null ? t("{label}・seed {seed}", { label: row.title, seed: row.seed }) : row.title}>
              {row.label}
            </span>
            <span className="machine row-span-2 self-center text-data font-semibold whitespace-nowrap text-fg" title={t("這一列各步驟耗時的總和：{value}", { value: formatSpanExact(row.totalMs) })}>
              {formatSpan(row.totalMs)}
            </span>
            <span className="flex min-w-0 items-center gap-2.5">
              <StageDots cells={row.cells} />
              <span className={cn("truncate text-caption", status.tone)} title={status.text}>
                {status.text}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function StageTable({ columns, rows, item }: { columns: readonly StageColumn[]; rows: readonly Row[]; item: QueueItem }) {
  // A single cell needs no totals (an export has one row and one step)
  const showRowTotal = columns.length > 1;
  const showColumnTotal = rows.length > 1;
  const columnTotals = columns.map((_, index) => sumMs(rows.map((row) => row.cells[index]?.ms ?? null)));
  return (
    <table className="hidden w-full table-fixed border-separate border-spacing-1 text-caption @min-[52.5rem]/stages:table">
      <caption className="sr-only">{t("各分支在每個步驟的狀態與耗時")}</caption>
      <colgroup>
        <col className="w-32" />
        {columns.map((column) => (
          <col key={column.base} />
        ))}
        {showRowTotal ? <col className="w-20" /> : null}
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className="truncate text-left font-medium text-fg-tertiary">
            {item.kind === "variations" ? t("變體") : t("鏡頭")}
          </th>
          {columns.map((column) => (
            <th key={column.base} scope="col" className="truncate text-left align-bottom font-medium text-fg-tertiary" title={t("{label}（{base}）", { label: column.label, base: column.base })}>
              {column.label}
            </th>
          ))}
          {showRowTotal ? (
            <th scope="col" className="truncate text-left align-bottom font-medium text-fg-tertiary" title={t("這一列各步驟耗時的總和")}>
              {t("合計")}
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row" className="text-left align-top font-normal text-fg">
              <span className="block truncate" title={row.title}>
                {row.label}
              </span>
              {row.seed !== null ? <span className="machine block truncate text-[11px] text-fg-tertiary">seed {row.seed}</span> : null}
            </th>
            {row.cells.map((cell) =>
              cell.known ? (
                <td key={cell.column.base} title={cell.title} className={cn("rounded-md border px-1.5 py-1.5 align-top", STATE_CELL[cell.state] ?? STATE_CELL.pending)}>
                  <span className="flex min-w-0 items-center gap-1 whitespace-nowrap">
                    {cell.state === "running" ? <LoaderCircle aria-hidden className="size-3 shrink-0 animate-spin" /> : null}
                    <span className="truncate">{STEP_STATE_LABEL[cell.state] ?? cell.state}</span>
                  </span>
                  <span className="machine block truncate text-fg-secondary">{formatSpan(cell.ms)}</span>
                  {cell.view ? <StepCellProgress view={cell.view} /> : null}
                </td>
              ) : (
                <td key={cell.column.base} title={cell.title} className="truncate rounded-md border border-line-subtle px-1.5 py-1.5 align-top whitespace-nowrap text-fg-tertiary">
                  {t("不適用")}
                </td>
              ),
            )}
            {showRowTotal ? (
              <td className={TOTAL_CELL} title={formatSpanExact(row.totalMs)}>
                {formatSpan(row.totalMs)}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
      {showColumnTotal ? (
        <tfoot>
          <tr>
            <th scope="row" className="truncate text-left align-top font-medium text-fg-tertiary" title={t("各步驟耗時加總；同時進行的步驟會重複計入，實際經過時間看上方的總耗時")}>
              {t("合計")}
            </th>
            {columnTotals.map((total, index) => (
              <td key={columns[index]?.base ?? index} className={TOTAL_CELL} title={formatSpanExact(total)}>
                {formatSpan(total)}
              </td>
            ))}
            {showRowTotal ? (
              <td className={cn(TOTAL_CELL, "border-line text-brand-cyan")} title={formatSpanExact(sumMs(columnTotals))}>
                {formatSpan(sumMs(columnTotals))}
              </td>
            ) : null}
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

export function StageMatrix({ run, item, now, views, lookup }: { run: WireRun | undefined; item: QueueItem; now: number | null; views: readonly BranchView[]; lookup: ProviderLookup }) {
  const { catalog } = useStudio();
  if (!run) return <p className="text-data text-fg-tertiary">{t("讀取 run…")}</p>;
  const nodeLabel = (nodeId: string | null) => catalog?.nodes.find((node) => node.node_id === nodeId)?.label ?? "";
  const { columns, rows } = buildRows(run, item, now, views, lookup, nodeLabel);
  return (
    <div className="@container/stages min-w-0">
      <StageTable columns={columns} rows={rows} item={item} />
      <StageCards rows={rows} />
    </div>
  );
}
