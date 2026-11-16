// 依序送出 recording PATCH（一次一個元件）並記錄逐列結果。
// - 同時只跑一批（ref 防重送；按鈕在 running 時停用）。
// - 不自動重試；「停止」只是不再送出後面的請求，已送出的那一個照實回報。
// - 離開頁面（unmount）時同樣停止送出後續請求。
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { SettingsView } from "@/api/generated/contracts";
import { qk } from "@/api/keys";
import { toErrorInfo } from "@/lib/errors";
import { fetchSettings, patchSettings } from "./api";
import { initialResults, resultFromError, type PatchItem, type PatchPlan, type RowResult, type TrackingRow } from "./model";
import { t } from "@/i18n";

export interface BatchProgress {
  done: number;
  total: number;
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const out = { ...record };
  delete out[key];
  return out;
}

export function useRecordingBatch() {
  const client = useQueryClient();
  /** 本頁讀到／寫回的設定（PATCH 回應、重新讀取），比目錄快照新時優先使用。 */
  const [local, setLocal] = useState<ReadonlyMap<string, SettingsView>>(() => new Map());
  const [results, setResults] = useState<Readonly<Record<string, RowResult>>>({});
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const runningRef = useRef(false);
  const stopRef = useRef(false);

  useEffect(
    () => () => {
      stopRef.current = true;
    },
    [],
  );

  const remember = (key: string, nodeId: string, componentId: string, view: SettingsView) => {
    setLocal((previous) => new Map(previous).set(key, view));
    client.setQueryData(qk.settings(nodeId, componentId), view);
  };

  /** 依序送出；onSaved 在每個成功的 PATCH 之後呼叫（例如清除該列草稿）。 */
  const run = async (plan: PatchPlan, onSaved?: (item: PatchItem, view: SettingsView) => void): Promise<void> => {
    if (runningRef.current || (plan.send.length === 0 && plan.skipped.length === 0)) return;
    runningRef.current = true;
    stopRef.current = false;
    setResults(initialResults(plan));
    setProgress({ done: 0, total: plan.send.length });
    try {
      for (const [index, item] of plan.send.entries()) {
        if (stopRef.current) {
          const remaining = plan.send.slice(index);
          setResults((previous) => {
            const next = { ...previous };
            for (const rest of remaining) next[rest.key] = { status: "stopped" };
            return next;
          });
          break;
        }
        setResults((previous) => ({ ...previous, [item.key]: { status: "pending" } }));
        try {
          const view = await patchSettings(item.nodeId, item.componentId, { expected_revision: item.expectedRevision, patch: { recording: item.recording } });
          remember(item.key, item.nodeId, item.componentId, view);
          onSaved?.(item, view);
          setResults((previous) => ({ ...previous, [item.key]: { status: "saved", revision: view.stored_revision, fields: item.fields } }));
        } catch (error) {
          setResults((previous) => ({ ...previous, [item.key]: resultFromError(error) }));
        }
        setProgress({ done: index + 1, total: plan.send.length });
      }
    } finally {
      runningRef.current = false;
      setProgress(null);
      if (plan.send.length > 0) void client.invalidateQueries({ queryKey: qk.catalog() });
    }
  };

  /** 重新讀取單一元件的設定（衝突、結果未知或失敗後由使用者觸發）；回傳最新設定，失敗時回傳 null。 */
  const reload = async (row: TrackingRow): Promise<SettingsView | null> => {
    if (runningRef.current) return null;
    setResults((previous) => ({ ...previous, [row.key]: { status: "reloading" } }));
    try {
      const view = await fetchSettings(row.nodeId, row.componentId);
      remember(row.key, row.nodeId, row.componentId, view);
      setResults((previous) => without(previous, row.key));
      void client.invalidateQueries({ queryKey: qk.catalog() });
      return view;
    } catch (error) {
      const info = toErrorInfo(error);
      setResults((previous) => ({
        ...previous,
        [row.key]: { status: "failed", code: info.code, message: t("重新讀取失敗：{message}", { message: info.message }), hint: info.hint, outcomeUnknown: false },
      }));
      return null;
    }
  };

  return {
    local,
    results,
    progress,
    running: progress !== null,
    run,
    reload,
    stop: () => {
      stopRef.current = true;
    },
    clearResults: () => setResults({}),
    clearResult: (key: string) => setResults((previous) => without(previous, key)),
  };
}
