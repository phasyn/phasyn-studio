// 生成中 take 的 DiT 逐步進度：找到這張圖 DiT 步驟的 recording（執行中以 call_id 對到 recording context），增量讀取
// runtime 事件，交給影片 Studio 的 DiT 進度模型（summarizeDit；來源與推導都標明）。只發 GET；DiT 執行中才輪詢。
// 中間預覽的步數由 run 狀態直接提供（outcome.ts takePreview），這裡是沒有預覽或預覽關閉時的後備。
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { WireRun } from "@/api/types";
import { parseRunStep } from "@/api/types";
import { findBranchRecording, resolveTotalSteps, runRecordingsOptions, stepLogOptions, summarizeDit, type DitProgress } from "@/features/studio";
import { takeStages, type TakeStage } from "../model/outcome";
import type { StudioImageTake } from "../types";

export function useTakeProgress(run: WireRun | undefined, take: StudioImageTake | null, lookup: (nodeId: string, componentId: string) => string | null): { stages: TakeStage[]; dit: DitProgress | null } {
  const stages = useMemo(() => (run && take ? takeStages(run, take, lookup) : []), [run, take, lookup]);
  const ditStage = stages.find((stage) => stage.role === "dit") ?? null;
  const raw = run && ditStage ? run.steps[ditStage.stepId] : undefined;
  const view = ditStage ? parseRunStep(ditStage.stepId, raw) : null;
  const running = run?.state === "running" && view?.state === "running";
  // 只在「DiT 執行中但還找不到它的 recording」時查（找到後沿用快取，不持續輪詢）
  const recordings = useQuery({
    ...runRecordingsOptions(run?.run_id ?? "", running),
    enabled: (query) => Boolean(run && view && running && !(view.recording_id != null && view.recording_id !== "") && !findBranchRecording(view, query.state.data?.items ?? [])),
  });
  const recording = view ? findBranchRecording(view, recordings.data?.items ?? []) : null;
  const recordingId = view?.recording_id ?? recording?.context.recording_id ?? null;
  const log = useQuery({ ...stepLogOptions(recordingId ?? "", running && recordingId !== null), enabled: recordingId !== null && running });
  const dit = view ? summarizeDit(log.data ?? null, resolveTotalSteps(raw, recording?.context ?? null), view.state) : null;
  return { stages, dit };
}
