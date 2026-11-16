// Short names, collapsed help and grouping of the RecorderConfig fields (contract field names are unchanged).
import type { FieldMeta } from "@/components/common/SchemaForm";
import { formatBytes } from "@/lib/format";
import type { JsonObject } from "@/lib/json";
import { RECORDER_FIELD_SUPPORT, RECORDER_SUPPORT_LABEL } from "@/lib/recorderSupport";
import { t } from "@/i18n";

export interface RecorderFieldGroup {
  id: string;
  title: string;
  note?: string;
  keys: readonly string[];
}

export const RECORDER_FIELD_GROUPS: readonly RecorderFieldGroup[] = [
  {
    id: "content",
    title: t("模式與內容"),
    keys: ["mode", "log_level", "gpu_event_timing", "capture_prompt", "capture_stderr", "finite_scan", "tensor_dump"],
  },
  { id: "scope", title: t("記錄範圍"), note: t("空清單＝全部。"), keys: ["parts", "steps"] },
  { id: "trace", title: "trace", note: t("只有 mode=trace 時生效。"), keys: ["trace_steps", "trace_parts", "record_shapes", "with_stack"] },
  {
    id: "limits",
    title: t("取樣、上報與上限"),
    keys: [
      "device_sample_hz",
      "publish_interval_ms",
      "batch_max_events",
      "batch_max_bytes",
      "queue_max_events",
      "queue_max_bytes",
      "segment_bytes",
      "max_detail_bytes_per_recording",
      "cuda_pending_event_pairs",
    ],
  },
];

export const RECORDER_FIELD_META: Readonly<Record<string, FieldMeta>> = {
  mode: { caption: t("錄製模式"), help: t("只改變量測，不改模型精度、batch、compile 或步數。") },
  log_level: { caption: t("log 等級"), help: t("只篩選文字 log；必要的錯誤、設定與基本 counter 不受影響。") },
  gpu_event_timing: { caption: t("GPU event 計時"), help: t("以 CUDA event 量 GPU 區間（可能含 stream 等待），不是 kernel active time。") },
  capture_prompt: { caption: t("記錄 prompt"), help: t("prompt 在私有 context 保存一次以便重現；關閉則不保存。") },
  capture_stderr: { caption: t("擷取 stderr"), help: t("契約語意：把元件程序的 stderr 轉成帶 instance／call 關聯的 log 事件。") },
  finite_scan: { caption: t("有限值掃描"), help: t("契約語意：NaN／Inf 檢查（除錯用）。") },
  tensor_dump: { caption: "tensor dump", help: t("契約語意：除錯用 tensor 存檔，會增加額外 D2H 與時間。") },
  parts: { caption: t("記錄的 part"), help: t("只記錄這些 part 的細節事件；空＝全部。") },
  steps: { caption: t("記錄的 step"), help: t("只記錄這些 step 的細節事件；空＝全部。") },
  trace_steps: { caption: t("trace 的 step"), help: t("torch.profiler 只在這些 step 開啟；空＝每個 step（成本很高）。") },
  trace_parts: { caption: t("trace 的 part") },
  record_shapes: { caption: t("記錄 shape"), help: t("profiler 記錄 tensor shape，會增加負擔。") },
  with_stack: { caption: t("記錄 stack"), help: t("profiler 記錄 Python stack，會增加負擔。") },
  device_sample_hz: { caption: t("裝置取樣頻率（Hz）"), help: t("Node 對整張裝置的 NVML／host 取樣；sampled 峰值可能漏掉瞬間高點。") },
  publish_interval_ms: { caption: t("上報間隔（ms）") },
  batch_max_events: { caption: t("每批事件上限") },
  batch_max_bytes: { caption: t("每批大小上限（bytes）") },
  queue_max_events: { caption: t("佇列事件上限") },
  queue_max_bytes: { caption: t("佇列大小上限（bytes）") },
  segment_bytes: { caption: t("分段檔大小（bytes）") },
  max_detail_bytes_per_recording: { caption: t("每筆細節上限（bytes）"), help: t("達到上限後停止高粒度事件與 trace，保留 counter 與摘要並標示不完整。") },
  cuda_pending_event_pairs: { caption: t("未完成 CUDA event 對上限") },
};

/** 後端尚未實作或固定行為的欄位：表單停用並一律顯示原因。 */
export function withRecorderSupport(meta: Readonly<Record<string, FieldMeta>>): Record<string, FieldMeta> {
  const out: Record<string, FieldMeta> = { ...meta };
  for (const [key, support] of Object.entries(RECORDER_FIELD_SUPPORT)) {
    out[key] = { ...out[key], unsupported: { label: RECORDER_SUPPORT_LABEL[support.status], note: support.note } };
  }
  return out;
}

/** 欄位說明＋依目前值的提示（bytes 欄位顯示 GiB／MiB 換算）＋未實作欄位的停用原因。 */
export function recorderFieldMeta(value: JsonObject): Record<string, FieldMeta> {
  const out: Record<string, FieldMeta> = withRecorderSupport(RECORDER_FIELD_META);
  for (const [key, current] of Object.entries(value)) {
    if (!key.endsWith("_bytes") || typeof current !== "number" || !Number.isFinite(current)) continue;
    out[key] = { ...out[key], hint: `≈ ${formatBytes(current)}` };
  }
  return out;
}
