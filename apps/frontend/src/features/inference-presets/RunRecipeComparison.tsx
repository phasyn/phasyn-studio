import { useState } from "react";
import { Link } from "react-router";
import type { RecipeComparison, RecipeMetricPair, RecipeSettingPair } from "@/api/generated/contracts";
import { useRecipeComparison } from "@/api/recipeComparison";
import { useProjectRunList } from "@/api/runs";
import { runPath } from "@/app/paths";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";

function valueText(value: unknown): string {
  if (value === null || value === undefined) return t("未記錄");
  if (typeof value === "string") return value;
  return JSON.stringify(value, (_key, part: unknown) =>
    typeof part === "number" && Number.isInteger(part) && !Number.isSafeInteger(part) ? `≈ ${String(part)}` : part);
}

function settingStatus(state: RecipeSettingPair["status"]) {
  switch (state) {
    case "equal": return t("相同");
    case "different": return t("有差異");
    case "left_only": return t("僅基準組");
    case "right_only": return t("僅比較組");
    case "unknown": return t("無法確認");
  }
}

function reasonText(reason: RecipeMetricPair["reason"]) {
  switch (reason) {
    case "unmeasured": return t("缺少實測值");
    case "unit": return t("量測單位不同或缺漏");
    case "scope": return t("量測範圍不同或缺漏");
    case "method": return t("量測方法不同或缺漏");
    case "provider": return t("執行元件不同或缺漏");
    case "categorical": return t("類別量測不計算差值");
    case "nonfinite": return t("差值超出數值範圍");
    case null: return "";
  }
}

function SettingValue({ value }: { value: unknown }) {
  const fact = isRecord(value) && (value["status"] === "recorded" || value["status"] === "unknown") ? value : undefined;
  return <div className="min-w-0 text-caption text-fg-secondary">
    <span className="font-mono [overflow-wrap:anywhere]">{valueText(fact ? fact["value"] : value)}</span>
    {fact && typeof (fact["source"] ?? fact["reason"]) === "string" ? <p className="break-words text-fg-tertiary">{String(fact["source"] ?? fact["reason"])}</p> : null}
  </div>;
}

function Settings({ rows }: { rows: RecipeSettingPair[] }) {
  return <div className="grid gap-2" role="list">
    {rows.map((row) => <div key={row.name} role="listitem" className="grid min-w-0 grid-cols-2 gap-x-3 border-t border-line-subtle pt-2">
      <div className="col-span-2 flex flex-wrap items-center justify-between gap-1 text-caption"><code className="break-all">{row.name}</code><span>{settingStatus(row.status)}</span></div>
      <SettingValue value={row.left} /><SettingValue value={row.right} />
    </div>)}
  </div>;
}

function Metric({ value }: { value: unknown }) {
  if (!isRecord(value)) return <span>{valueText(value)}</span>;
  return <div className="min-w-0">
    <div className="break-all font-mono" title={valueText(value["value"])}>{typeof value["value"] === "number" ? readableNumber(value["value"]) : valueText(value["value"])} {valueText(value["unit"])}</div>
    <div className="text-fg-tertiary [overflow-wrap:anywhere]">{[value["scope"], value["method"], value["quality"]].map(valueText).join(" · ")}</div>
    {typeof value["reason"] === "string" ? <div>{value["reason"]}</div> : null}
  </div>;
}

function readableNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

const primarySettings = new Set([
  "model.identity.variant", "requested.settings.load.precision", "effective.settings.load.precision",
  "observed.parameter_dtypes", "observed.quantized_weight_dtypes", "observed.vae_weight_dtype",
  "requested.step_parameters.width", "requested.step_parameters.height", "requested.step_parameters.frames",
  "requested.step_parameters.seed", "requested.step_parameters.steps",
]);

function Measurements({ rows }: { rows: RecipeMetricPair[] }) {
  if (!rows.length) return <p className="text-caption text-fg-secondary">{t("兩組皆無量測紀錄")}</p>;
  return <div className="grid min-w-0 gap-2">
    {rows.map((row) => <div key={row.name} className="grid min-w-0 grid-cols-2 gap-x-3 border-t border-line-subtle pt-2 text-caption">
      <div className="col-span-2 flex flex-wrap justify-between gap-2"><code className="break-all text-fg">{row.name}</code>
        <span className="text-fg-secondary">{row.delta === null ? reasonText(row.reason) : `Δ ${row.delta > 0 ? "+" : ""}${readableNumber(row.delta)} ${isRecord(row.right) ? valueText(row.right["unit"]) : ""}`}</span></div>
      <Metric value={row.left} /><Metric value={row.right} />
    </div>)}
  </div>;
}

function Report({ data }: { data: RecipeComparison }) {
  return <div className="grid min-w-0 gap-3">
    <div className="grid grid-cols-2 gap-3">
      {[data.left, data.right].map((run, index) => <div className="min-w-0 text-caption" key={index === 0 ? "baseline" : "comparison"}>
        <span className="block font-semibold">{index === 0 ? t("基準組") : t("比較組")}</span>
        <Link className="break-all font-mono text-action-fg underline" to={runPath(run.run_id)}>{run.run_id}</Link>
        <p className="break-all text-fg-secondary">{run.pipeline_id} · {run.state}</p>
      </div>)}
    </div>
    <p className="text-caption text-fg-secondary">{t("差值為比較組減基準組。兩次執行只能比較紀錄值，無法單獨歸因於精度。可開啟來源任務檢視畫質。")}</p>
    <details className="min-w-0"><summary className="cursor-pointer font-semibold">{t("凍結輸入比對")} ({data.inputs.length})</summary><Settings rows={data.inputs} /></details>
    {data.steps.map((step) => <div key={step.step_id} className="grid min-w-0 gap-2 rounded-md border border-line-subtle p-2">
      <h4 className="font-mono font-semibold [overflow-wrap:anywhere]">{step.step_id}{!step.left_present ? ` · ${t("僅比較組")}` : !step.right_present ? ` · ${t("僅基準組")}` : ""}</h4>
      <Settings rows={step.settings.filter((row) => primarySettings.has(row.name) && row.status !== "unknown" && (row.left !== null || row.right !== null))} />
      <details><summary className="cursor-pointer text-caption">{t("模型、精度與取樣設定")}</summary><Settings rows={step.settings} /></details>
      <Measurements rows={step.metrics} />
    </div>)}
  </div>;
}

/** The project (and shot) whose runs the comparison offers; without it, the newest runs of every project. */
export interface RecipeComparisonScope { projectId: string; shotId: string | null }

export function RunRecipeComparison({ runId, scope }: { runId: string; scope?: RecipeComparisonScope | undefined }) {
  const [against, setAgainst] = useState("");
  const history = useProjectRunList(scope?.projectId ?? null, scope?.shotId ?? null);
  const comparison = useRecipeComparison(runId, against);
  return <section aria-label={t("比較執行配方")} className="panel grid min-w-0 gap-3 p-3">
    <label className="grid min-w-0 gap-1 text-data font-semibold">
      {t("比較執行配方")}
      <Select value={against} onChange={(event) => { setAgainst(event.target.value); }}>
        <option value="">{t("選擇比較的來源任務")}</option>
        {history.runs.filter((run) => run.run_id !== runId).map((run) => <option key={run.run_id} value={run.run_id}>{run.request.label ?? run.request.pipeline.pipeline_id} · {run.run_id}</option>)}
      </Select>
    </label>
    {history.hasNextPage ? <Button size="sm" variant="quiet" pending={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{t("載入較早的任務")}</Button> : null}
    {history.isError ? <ErrorCallout error={history.error} onRetry={() => void history.refetch()} /> : null}
    {against && comparison.isPending ? <p role="status" className="text-caption">{t("讀取兩組量測…")}</p> : null}
    {comparison.isError ? <ErrorCallout error={comparison.error} onRetry={() => void comparison.refetch()} /> : null}
    {comparison.data ? <Report data={comparison.data} /> : null}
  </section>;
}
