// 換角工作畫面（與工具列按鈕）的純函式：階段與段落狀態的文字、工具列摘要、下一批要送出的段落（一個 run 的步驟上限）、
// 取消前說明影響範圍、依階段選唯一的主要動作、段落接到下一段的方式。
import { TRANSITION_LABELS, type Transition } from "../model/clipEffects";
import { unfinishedSegments, type SegmentState, type SegmentView, type SwapPhase, type SwapProgress } from "./job";
import { t } from "@/i18n";

export const PHASE_LABELS: Record<SwapPhase, string> = {
  pending: t("等待渲染"),
  rendering: t("渲染中"),
  failed: t("有段落沒有完成"),
  ready_to_export: t("可以匯出"),
  exporting: t("匯出中"),
  exported: t("已匯出"),
  export_failed: t("匯出沒有完成"),
};

export const SEGMENT_LABELS: Record<SegmentState, string> = {
  pending: t("未渲染"),
  rendering: t("渲染中"),
  done: t("完成"),
  stale: t("完成（設定已改）"),
  failed: t("失敗"),
  cancelled: t("已取消"),
  interrupted: t("已中斷"),
  skipped: t("沒有執行"),
};

/**
 * What to try when a segment failed with this error code (a swap segment is one H3 render with a reference video, so
 * the advice names what makes it lighter); null = no swap-specific advice.
 */
export function segmentErrorHint(code: string): string | null {
  if (code === "GPU_OOM") return t("顯存不夠：改小畫面格式、改用顯存較大的運算路由，或縮短每段上限；同一張卡再按一次「渲染」有時會成功。");
  if (code === "HOST_OOM") return t("主機記憶體不夠：先關掉其他佔記憶體的程式，或改用另一台 Node 的運算路由，再按「渲染」。");
  if (code === "NODE_UNREACHABLE") return t("連不到另一台 Node（它可能沒有回應，這段要從它下載中間結果）：等它恢復後按「渲染下一批」，沒完成的段落會自動排進去。");
  return null;
}

export type SummaryTone = "info" | "warning" | "success" | "danger" | "neutral";

export interface ToolbarSummary {
  /** 按鈕上的短文字（mono），例如「3／7」「已匯出」。 */
  text: string;
  /** 不含「一鍵換角：」前綴的說明（嵌進其他句子用）。 */
  detail: string;
  /** 完整說明（title／aria-label）＝「一鍵換角：」＋ detail。 */
  title: string;
  tone: SummaryTone;
  /** 進行中（顯示旋轉圖示）。 */
  busy: boolean;
}

/** 工具列按鈕的摘要：渲染中顯示完成段數，其他階段顯示階段名稱。 */
export function toolbarSummary(progress: SwapProgress): ToolbarSummary {
  const total = progress.segments.length;
  const done = t("{playable}／{total}", { playable: progress.playable, total });
  const problems = unfinishedSegments(progress.counts);
  // detail 是不含「一鍵換角：」的說明：要嵌進其他句子時直接用它（不從 title 去掉前綴，title 會翻譯）
  const summary = (text: string, detail: string, tone: SummaryTone, busy: boolean): ToolbarSummary => ({ text, detail, title: t("一鍵換角：{detail}", { detail }), tone, busy });
  switch (progress.phase) {
    case "rendering":
      return summary(done, t("渲染中，{playable}／{total} 段完成", { playable: progress.playable, total }), "info", true);
    case "pending":
      return summary(done, t("{remainingCount} 段還沒渲染", { remainingCount: progress.remaining.length }), "neutral", false);
    case "failed":
      // 失敗、取消、中斷與沒有執行的段落都算「沒有完成」：不把取消說成失敗
      return summary(t("{problems} 段未完成", { problems }), t("{problems} 段沒有完成；在「一鍵換角」重新渲染", { problems }), "warning", false);
    case "ready_to_export":
      return summary(t("可匯出"), t("全部段落完成，可以匯出"), "info", false);
    case "exporting":
      return summary(t("匯出中"), t("正在匯出整段影片"), "info", true);
    case "exported":
      return summary(t("已匯出"), t("已匯出整段影片"), "success", false);
    case "export_failed":
      return summary(t("匯出未完成"), progress.exportProblem ?? t("最近一次匯出沒有成功"), "danger", false);
  }
}

/** 取消一個渲染 run 會影響哪些段落（確認時說明範圍）。 */
export function cancelScope(progress: SwapProgress, runId: string): { inRun: number; finished: number; text: string } {
  const inRun = progress.segments.filter((segment) => segment.shot.takes.some((take) => take.run_id === runId && take.state === "rendering")).length;
  const finished = progress.playable;
  const text = t("run {runId} 裡還沒完成的 {inRun} 段會停止（正在算的那一段結果作廢，其他段不再開始）；已完成的 {finished} 段保留。之後可以按「渲染剩下的段落」再送一次。", { runId: runId.slice(0, 8), inRun, finished });
  return { inRun, finished, text };
}

export type PrimaryAction = "render" | "export" | null;

/** 這個階段唯一的主要動作：還有沒完成的段落＝渲染；全部完成且沒有最新的匯出＝匯出；其他（進行中、已匯出）＝沒有。 */
export function primaryAction(progress: SwapProgress): PrimaryAction {
  if (progress.phase === "pending" || progress.phase === "failed") return "render";
  if (progress.phase === "ready_to_export" || progress.phase === "export_failed") return "export";
  return null;
}

/** 段落接到下一段的方式（依時間軸上這個段落最後一個片段的轉場；最後一段或不在時間軸上＝null）。 */
export function joinText(transition: Transition | null, last: boolean): { text: string; midShot: boolean } | null {
  if (last) return null;
  if (transition?.kind === "crossfade") return { text: t("交叉溶接 {frames} 影格（鏡頭中間的接縫）", { frames: transition.frames }), midShot: true };
  if (transition) return { text: t("{kind} {frames} 影格", { kind: TRANSITION_LABELS[transition.kind], frames: transition.frames }), midShot: false };
  return { text: t("直接切換"), midShot: false };
}

/** 段落的狀態色（顏色之外一律有圖示與文字）。 */
export function segmentTone(segment: Pick<SegmentView, "state">): SummaryTone {
  if (segment.state === "done") return "success";
  if (segment.state === "rendering") return "info";
  if (segment.state === "failed") return "danger";
  if (segment.state === "stale" || segment.state === "cancelled" || segment.state === "interrupted" || segment.state === "skipped") return "warning";
  return "neutral";
}
