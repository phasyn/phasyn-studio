// 切鏡偵測：使用者按下才送出一個步驟的 media.probe run（一次、不自動重送），以既有的 useRun 輪詢到結束，讀回切鏡；
// 可以取消（送一次 cancel）。結果只屬於送出時的來源影片（sourceKey），換了影片就不再使用。
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ComponentDescriptor, FileRef } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import { qk } from "@/api/keys";
import { cancelRun, useCreateRun, useRun } from "@/api/runs";
import { errorText } from "./errors";
import type { SavedDetection } from "./draftStore";
import { probeOutcome, probeRunRequest, type ProbeSceneInfo, type SceneParameters } from "./probe";
import { t } from "@/i18n";
import { failureText } from "@/lib/errors";

export type DetectionView =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "running"; runId: string; createdAt: string }
  | { status: "succeeded"; runId: string; info: ProbeSceneInfo }
  | { status: "failed"; runId: string | null; message: string };

interface Request {
  runId: string;
  sourceKey: string;
  createdAt: string;
}

/** saved: the detection kept with a restored draft (its run is read back; it applies while its source is chosen). */
export function useCutDetection(sourceKey: string | null, saved: SavedDetection | null = null) {
  const client = useQueryClient();
  const { mutateAsync: postRun } = useCreateRun();
  const [request, setRequest] = useState<Request | null>(saved);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<{ sourceKey: string; message: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const current = request?.sourceKey === sourceKey ? request : null;
  const run = useRun(current?.runId ?? null);

  let view: DetectionView = { status: "idle" };
  if (submitting !== null && submitting === sourceKey) view = { status: "submitting" };
  else if (current) {
    const data = run.data;
    if (!data) view = run.isError ? { status: "failed", runId: current.runId, message: t("讀取偵測進度失敗：{error}", { error: errorText(run.error) }) } : { status: "running", runId: current.runId, createdAt: current.createdAt };
    else {
      const outcome = probeOutcome(data);
      if (outcome.state === "running") view = { status: "running", runId: current.runId, createdAt: data.created_at };
      else if (outcome.state === "succeeded") view = { status: "succeeded", runId: current.runId, info: outcome.info };
      else {
        const label = outcome.state === "cancelled" ? t("已取消") : outcome.state === "interrupted" ? t("已中斷") : t("失敗");
        view = { status: "failed", runId: current.runId, message: t("偵測{label}{value}", { label, value: outcome.error ? t("：{message}", { message: failureText(outcome.error.code, outcome.error.message) }) : "" }) };
      }
    }
  } else if (submitError?.sourceKey === sourceKey) view = { status: "failed", runId: null, message: submitError.message };

  const start = async (component: Pick<ComponentDescriptor, "node_id" | "component_id">, file: FileRef, parameters: SceneParameters, name: string) => {
    if (!(sourceKey != null && sourceKey !== "") || submitting !== null) return;
    setSubmitting(sourceKey);
    setSubmitError(null);
    try {
      const created = await postRun(probeRunRequest(component, file, parameters, name));
      setRequest({ runId: created.run_id, sourceKey, createdAt: created.created_at });
    } catch (error) {
      const active = isApiError(error) && error.code === "RUN_ACTIVE";
      setSubmitError({ sourceKey, message: active ? t("主控的同時執行數已滿：等其中一個 run 結束後再偵測，或略過偵測改用固定分段") : t("無法開始偵測：{error}", { error: errorText(error) }) });
    } finally {
      setSubmitting(null);
    }
  };

  /** 取消偵測（送一次 cancel；結果由 run 狀態呈現）。 */
  const cancel = async (): Promise<string | null> => {
    if (!current || cancelling) return null;
    setCancelling(true);
    try {
      const result = await cancelRun(current.runId);
      return result.accepted ? null : t("取消未受理：{message}", { message: result.message });
    } catch (error) {
      return t("取消失敗：{error}", { error: errorText(error) });
    } finally {
      setCancelling(false);
      void client.invalidateQueries({ queryKey: qk.run(current.runId) });
      void client.invalidateQueries({ queryKey: qk.runs() });
    }
  };

  return {
    view,
    start,
    cancel,
    cancelling,
    probe: view.status === "succeeded" ? view.info : null,
    /** The detection of the current source, to keep with a saved draft. */
    saved: current satisfies SavedDetection | null,
  };
}
