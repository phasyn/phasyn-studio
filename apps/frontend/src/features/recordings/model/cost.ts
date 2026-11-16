// summary.cost (x-phasyn-extension) for display: the work a load or invoke actually did, recorded for the duration
// estimator's fits; never a prediction. Missing values stay missing with a reason (no 0 stands in). Pure.
import type { Recording, RecordingCost } from "@/api/generated/contracts";
import { t } from "@/i18n";

/** Shape keys reserved for out-of-memory warnings (Recorder.record_cost): never work, compared only with each other. */
export const RISK_MEASURE = "risk_measure";
export const RISK_UNIT = "risk_unit";

type ShapeValue = number | string | boolean | null;

export interface CostStageRow {
  stage: string;
  work: number;
  unit: string;
  /** Measured compute time of the stage; null when it was not measured. */
  computeMs: number | null;
  /** risk_measure with its risk_unit, when the stage recorded one. */
  risk: { measure: ShapeValue; unit: ShapeValue } | null;
  /** The other scalar facts the work was derived from, in recorded order. */
  shape: Array<[string, ShapeValue]>;
}

export function costStageRows(cost: RecordingCost): CostStageRow[] {
  return cost.stages.map((stage) => {
    const shape: Array<[string, ShapeValue]> = [];
    for (const [key, value] of Object.entries(stage.shape)) {
      if (value !== undefined && key !== RISK_MEASURE && key !== RISK_UNIT) shape.push([key, value]);
    }
    const measure = stage.shape[RISK_MEASURE];
    const unit = stage.shape[RISK_UNIT];
    return {
      stage: stage.stage,
      work: stage.work,
      unit: stage.work_unit,
      computeMs: stage.compute_ms,
      risk: measure === undefined && unit === undefined ? null : { measure: measure ?? null, unit: unit ?? null },
      shape,
    };
  });
}

/** Why a recording has no cost block; null when it has one. */
export function costAbsence(recording: { context: Pick<Recording["context"], "operation">; summary: Pick<Recording["summary"], "state" | "cost"> }): string | null {
  if (recording.summary.cost) return null;
  switch (recording.context.operation) {
    case "controller":
      return t("主控的紀錄不記錄運算量：cost 只來自元件程序的 load 與 invoke。");
    case "node":
      return t("Node 層級的紀錄不記錄運算量：cost 只來自元件程序的 load 與 invoke。");
    case "unload":
      return t("unload 不記錄運算量：cost 只來自元件程序的 load 與 invoke。");
    default:
      return recording.summary.state === "running"
        ? t("呼叫還在執行：運算量在結束時寫入。")
        : t("元件程序沒有回報這次的運算量（例如呼叫在進入元件程序前就失敗，或程序在結束前終止）。");
  }
}

/** cost.warm: first call after the load, a later call, or not applicable (a load recording). */
export function warmText(warm: boolean | null): string {
  if (warm === null) return t("不適用（load 紀錄）");
  return warm ? t("載入後的後續呼叫（不是第一次）") : t("載入後第一次呼叫");
}

/** Work in its unit's count: large counts (FLOPs, pixels) in exponent form, the exact value is for the title. */
export function formatWork(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Math.abs(value) >= 1e6 ? value.toExponential(3) : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/** The host's 1-minute load average at the call's start and end; a side that was not read stays unknown. */
export function loadavgText(loadavg: RecordingCost["loadavg"]): string {
  if (!loadavg) return t("未取得");
  const side = (value: number | null) => (value === null ? t("未取得") : value.toFixed(2));
  return `${side(loadavg.start)} → ${side(loadavg.end)}`;
}
