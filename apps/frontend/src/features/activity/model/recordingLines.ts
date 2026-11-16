// Recordings → log lines (one per recording: operation, state, wall time and the error noted by the Node). Pure.
import type { Recording, RecordingSummary } from "@/api/generated/contracts";
import { formatMetric, shortId } from "@/lib/format";
import { LOCAL_ID_PATTERN } from "@/lib/ids";
import { recordingPath } from "@/app/paths";
import { t, tServer } from "@/i18n";
import { clip, errorLine, joinParts, sortLines, type LogLevel, type LogLine, type LogSource } from "./lines";

export interface RecordingLineOptions {
  /** node_id → 顯示名稱（Node 層級 recording 的來源）。 */
  nodeLabels?: ReadonlyMap<string, string>;
  /**
   * 正在進行的呼叫（目錄的 active_call_id、run 中執行中步驟的 call_id）。summary 尚未收到（state＝unknown）
   * 但呼叫仍在進行的 recording 顯示「執行中」，不顯示成警告。
   */
  activeCalls?: ReadonlySet<string>;
  /** Runs still running: the Controller's own recording of one (it has no call) shows as running, not as unknown. */
  activeRuns?: ReadonlySet<string>;
}

const RECORDING_STATE: Record<RecordingSummary["state"], { level: LogLevel; verb: string }> = {
  running: { level: "info", verb: t("執行中") },
  succeeded: { level: "success", verb: t("成功") },
  failed: { level: "error", verb: t("失敗") },
  cancelled: { level: "warning", verb: t("已取消") },
  interrupted: { level: "warning", verb: t("已中斷") },
  unknown: { level: "warning", verb: t("狀態未知") },
};

// 伺服器 summary.notes 的固定格式（Node 端寫入），比對時不翻譯。
const ERROR_NOTE_PREFIX = "error："; // i18n-ignore

/** summary.notes 的 `error：CODE：message`（與 Node 端紀錄索引的 error_code 規則相同）。 */
export function recordingError(notes: readonly unknown[]): { code: string; message: string } | null {
  for (const note of notes) {
    if (typeof note !== "string" || !note.startsWith(ERROR_NOTE_PREFIX)) continue;
    const rest = note.slice(ERROR_NOTE_PREFIX.length);
    const cut = rest.indexOf("："); // i18n-ignore
    const code = (cut === -1 ? rest : rest.slice(0, cut)).trim();
    if (LOCAL_ID_PATTERN.test(code)) return { code, message: cut === -1 ? "" : rest.slice(cut + 1).trim() };
  }
  return null;
}

function recordingSource(recording: Recording, options: RecordingLineOptions): LogSource {
  const { context } = recording;
  const to = recordingPath(context.recording_id);
  if (context.operation === "controller") return { kind: "controller", label: t("主控"), to };
  if (context.operation === "node") return { kind: "node", label: options.nodeLabels?.get(context.node_id) ?? shortId(context.node_id), to };
  return { kind: "component", label: context.component_id, ...(context.provider_id ? { providerId: context.provider_id } : {}), to };
}

function recordingSubject(recording: Recording): string {
  const { context } = recording;
  if (context.operation === "controller") return context.run_id ? `controller run ${shortId(context.run_id)}` : "controller";
  if (context.operation === "node") return "node";
  return `${context.operation} ${context.component_id}`;
}

/** 這筆 recording 的呼叫是否還在進行：summary 尚未收到（unknown），而目錄或 run 回報它的 call 仍在執行。 */
export function callInProgress(recording: Recording, activeCalls: ReadonlySet<string> | undefined): boolean {
  const callId = recording.context.call_id;
  return recording.summary.state === "unknown" && Boolean(callId) && activeCalls?.has(callId ?? "") === true;
}

/** The Controller's recording of a run (operation controller, no call) whose summary is not in yet while the run is running. */
export function runInProgress(recording: Recording, activeRuns: ReadonlySet<string> | undefined): boolean {
  const { operation, run_id: runId } = recording.context;
  return recording.summary.state === "unknown" && operation === "controller" && runId !== null && activeRuns?.has(runId) === true;
}

export function lineFromRecording(recording: Recording, options: RecordingLineOptions = {}): LogLine {
  const { context, summary } = recording;
  const runGoing = runInProgress(recording, options.activeRuns);
  const inProgress = runGoing || callInProgress(recording, options.activeCalls);
  // 契約外的狀態字串：照原文顯示，不猜成功或失敗。
  const state: { level: LogLevel; verb: string } = inProgress ? RECORDING_STATE.running : (RECORDING_STATE[summary.state] ?? { level: "info", verb: summary.state });
  const notes: readonly unknown[] = Array.isArray(summary.notes) ? summary.notes : [];
  const error = summary.state === "failed" ? recordingError(notes) : null;
  // 執行中的 host_wall_ms 只是到目前為止的值，不當成結果顯示；結束後才放進訊息。
  const wall = summary.state === "running" || inProgress ? undefined : summary.metrics.host_wall_ms;
  const measured = wall ? t("host_wall_ms {wall}（{quality}）", { wall: formatMetric(wall), quality: wall.quality }) : null;
  // Fixed notes (the server catalog has them) read in the interface language, one by one, then joined in it too
  const otherNotes = notes.filter((note): note is string => typeof note === "string" && !note.startsWith(ERROR_NOTE_PREFIX)).map((note) => tServer(note));
  return {
    id: `rec:${context.recording_id}`,
    at: context.created_at,
    level: state.level,
    source: recordingSource(recording, options),
    message: joinParts([`${recordingSubject(recording)} ${state.verb}`, error ? errorLine(error) : measured, context.synthetic && t("合成示例")]),
    detail: clip(
      joinParts([
        `recording ${context.recording_id}`,
        context.provider_id && `provider ${context.provider_id}`,
        context.run_id && `run ${context.run_id}`,
        context.call_id && `call ${context.call_id}`,
        error && measured,
        wall?.reason && t("host_wall_ms：{reason}", { reason: tServer(wall.reason) }),
        summary.context_available === false && t("context 未取得（Node 尚未送出）"),
        inProgress && (runGoing ? t("run 仍在執行，summary 在 run 結束後才會收到") : t("呼叫仍在進行（目錄或 run 回報），summary 結束後才會收到")),
        otherNotes.join(t("；")),
      ]),
      1200,
    ),
  };
}

/** recording 列表 → 每筆一列（時間＝建立時間；狀態與 host_wall_ms 為目前摘要）。 */
export function linesFromRecordings(items: readonly Recording[], options: RecordingLineOptions = {}): LogLine[] {
  return sortLines(items.map((item) => lineFromRecording(item, options)));
}
