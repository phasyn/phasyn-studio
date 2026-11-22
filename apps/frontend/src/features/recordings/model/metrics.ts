// Metric 目錄、繁中標籤、分組與顯示格式。
// 權威欄位（unit／scope／method／rule）來自 contracts/metric-catalog.json；這裡只補顯示用標籤。
// 規則：value=null 永遠顯示「未量測」或「不適用」並附原因，絕不當成 0。
import catalogJson from "@contracts/metric-catalog.json";
import type { Metric, Quality } from "@/api/generated/contracts";
import { formatMetric } from "@/lib/format";
import { tServer, t } from "@/i18n";

export interface CatalogEntry {
  name: string;
  unit: string;
  scope: string;
  method: string;
  minimum_mode: string;
  nullable: boolean;
  signed: boolean;
  rule: string;
}

const CATALOG: ReadonlyMap<string, CatalogEntry> = new Map(
  (catalogJson as { metrics: CatalogEntry[] }).metrics.map((entry) => [entry.name, entry]),
);

export function catalogEntry(name: string): CatalogEntry | undefined {
  return CATALOG.get(name);
}

/** 本頁會額外辨識、但不在 catalog 的常見名稱（Controller 彙整的 step 分位數、runtime 內 wall）。 */
const EXTRA_ENTRIES: Record<string, Pick<CatalogEntry, "unit" | "scope" | "method" | "rule">> = {
  "runtime.host_wall_ms": {
    unit: "ms",
    scope: "runtime_process_call",
    method: "host_monotonic",
    rule: t("元件程序內的計算 wall；不含主控／Node 端的輸入取得與發布"),
  },
  "steps.host_ms_p50": { unit: "ms", scope: "steps_in_call", method: "host_monotonic", rule: t("此 recording 內各 step 的中位數") },
  "steps.host_ms_p95": {
    unit: "ms",
    scope: "steps_in_call",
    method: "host_monotonic",
    rule: t("nearest-rank ceil(0.95·n)；是此 recording 內各 step 的分位數，不是多次 run 的 p95"),
  },
  "steps.gpu_event_ms_p50": { unit: "ms", scope: "steps_in_call", method: "cuda_event", rule: t("各 step 的 GPU event 區間中位數；不是 kernel 時間") },
  "steps.gpu_event_ms_p95": {
    unit: "ms",
    scope: "steps_in_call",
    method: "cuda_event",
    rule: t("各 step 的 GPU event 區間 p95（nearest-rank）；不是 kernel 時間"),
  },
};

export function metricRule(name: string): string | null {
  // catalog 的 rule 是契約（metric-catalog.json）的固定文字：有譯文就顯示譯文
  return tServer(catalogEntry(name)?.rule) ?? EXTRA_ENTRIES[name]?.rule ?? null;
}

export const TRANSFER_METRIC_CATEGORIES = [
  "weight_h2d",
  "weight_d2h",
  "activation_h2d",
  "activation_d2h",
  "device_copy",
  "peer_copy",
  "host_copy",
  "diagnostic_readback",
] as const;

const TRANSFER_METRIC_RE = new RegExp(`^(${TRANSFER_METRIC_CATEGORIES.join("|")})_(submitted|completed)_(count|bytes)$`);

export function parseTransferMetricName(name: string): { category: string; phase: "submitted" | "completed"; measure: "count" | "bytes" } | null {
  const match = TRANSFER_METRIC_RE.exec(name);
  if (!match) return null;
  const [, category, phase, measure] = match;
  if (!(category != null && category !== "") || (phase !== "submitted" && phase !== "completed") || (measure !== "count" && measure !== "bytes")) return null;
  return { category, phase, measure };
}

const LABELS: Record<string, string> = {
  host_wall_ms: t("整段 wall time"),
  host_cpu_time_ms: t("程序 CPU 時間（user+system）"),
  "runtime.host_wall_ms": t("元件程序內計算 wall"),
  host_load_ms: t("載入"),
  host_input_transfer_ms: t("輸入取得"),
  host_output_publish_ms: t("輸出發布"),
  host_encode_ms: t("編碼"),
  host_wait_ms: t("觀測到的等待"),
  gpu_event_ms: t("GPU event 區間（不是 kernel 時間）"),
  gpu_kernel_union_ms: t("GPU kernel 區間聯集（trace）"),
  api_enter_to_kernel_start_ms: t("API 進入 → kernel 開始（trace）"),
  api_exit_to_kernel_start_ms: t("API 返回 → kernel 開始（trace，可為負）"),
  kernel_launch_count: t("kernel 啟動數（trace 視窗內）"),
  "steps.host_ms_p50": t("每 step host 時間 p50"),
  "steps.host_ms_p95": t("每 step host 時間 p95"),
  "steps.gpu_event_ms_p50": t("每 step GPU event 區間 p50"),
  "steps.gpu_event_ms_p95": t("每 step GPU event 區間 p95"),
  torch_allocated_current_bytes: t("PyTorch allocated（結束時）"),
  torch_allocated_peak_bytes: t("PyTorch allocated 峰值"),
  torch_reserved_current_bytes: t("PyTorch reserved（結束時）"),
  torch_reserved_peak_bytes: t("PyTorch reserved 峰值"),
  nvml_device_used_bytes: t("NVML 整卡已用"),
  nvml_device_total_bytes: t("NVML 整卡總量"),
  nvml_device_used_sample_peak_bytes: t("NVML 整卡已用（取樣峰值）"),
  nvml_process_used_bytes: t("NVML 此程序已用"),
  host_rss_current_bytes: t("Host RSS（取樣）"),
  host_rss_sample_peak_bytes: t("Host RSS（本次取樣峰值）"),
  host_lifetime_peak_bytes: t("程序生命週期高水位（不是本次 call 峰值）"),
  host_available_bytes: t("主機可用記憶體（整機）"),
  host_swap_used_bytes: t("Swap 已用（整機）"),
  owned_weight_host_bytes: t("元件持有權重（host，logical payload）"),
  owned_weight_device_bytes: t("元件持有權重（device，logical payload）"),
  owned_pinned_host_bytes: t("元件持有 pinned host"),
  output_buffer_bytes: t("輸出 buffer"),
  allocation_fail_requested_bytes: t("配置失敗時請求的 bytes"),
  network_received_bytes: t("網路接收（consumer 計數）"),
  network_sent_bytes: t("網路送出（sender 對照，不相加）"),
  logical_disk_read_bytes: t("邏輯磁碟讀取（非實體 I/O）"),
  logical_disk_written_bytes: t("邏輯磁碟寫入（非實體 I/O）"),
  pin_count: t("pin 次數（不是 H2D）"),
  unpin_count: t("unpin 次數"),
  block_load_count: t("block 載入次數"),
  device_discard_count: t("device 副本丟棄次數（不是 D2H）"),
  resident_hit_count: t("常駐命中次數"),
  prefetch_hit_count: t("prefetch 命中"),
  prefetch_miss_count: t("prefetch 未命中"),
  offload_cycle_count: t("offload 週期數（load→use→evict，不是來回）"),
  paired_roundtrip_count: t("成對來回數（H2D 與 D2H 皆完成）"),
  scheduler_steps_completed: "scheduler steps",
  denoiser_forwards_completed: t("denoiser 前向次數（NFE）"),
  block_forward_count: t("block 前向次數（不是 kernel 數）"),
  cfg_branch_forward_count: t("CFG 分支前向次數"),
  decode_forward_count: t("decoder 前向次數"),
  frame_callback_count: t("frame callback 次數"),
  output_frame_count: t("輸出 frames"),
  input_frame_count: t("輸入 frames"),
  input_tokens: t("輸入 tokens"),
  output_tokens: t("輸出 tokens"),
  prefetch_wait_ms: t("prefetch 等待"),
  caption_ttft_ms: t("TTFT（不是整段完成時間）"),
  encoder_backpressure_ms: t("encoder 背壓等待"),
  device_utilization_pct: t("裝置利用率（整卡，非此 part 獨占）"),
  memory_utilization_pct: t("記憶體頻寬利用率（整卡）"),
  device_power_w: t("裝置功率（整卡）"),
  device_temperature_c: t("裝置溫度（整卡）"),
  device_sm_clock_mhz: t("SM 時脈（整卡）"),
  recorder_cpu_ms: t("recorder 自身 CPU"),
  recorder_written_bytes: t("recorder 寫入 bytes"),
  publisher_bytes: t("publisher 送出 bytes"),
  events_dropped: t("丟棄事件數"),
  publisher_dropped: t("publisher 丟棄數"),
  measurement_error_count: t("量測錯誤次數"),
  sample_count: t("取樣次數"),
  copy_effective_gbps: t("copy 有效頻寬（同組區間）"),
  analytic_flops: t("公式推導 FLOP（不是 GPU 指令計數）"),
};

export function metricLabel(name: string): string {
  const direct = LABELS[name];
  if (direct != null && direct !== "") return direct;
  const transfer = parseTransferMetricName(name);
  if (transfer) {
    return `${transfer.category} ${transfer.phase === "submitted" ? t("已提交") : t("已完成")}${transfer.measure === "count" ? t("次數") : " bytes"}`;
  }
  return name;
}

export interface MetricGroupDef {
  id: string;
  title: string;
  note?: string;
  /** 一定列出（缺少時顯示「未回報」）。 */
  core: readonly string[];
  /** 有回報才列出。 */
  optional: readonly string[];
}

export const METRIC_GROUPS: readonly MetricGroupDef[] = [
  {
    id: "time",
    title: t("時間"),
    note: t("host 區間由本機 monotonic 量測；GPU event 是 event 區間（可能含等待），不是 kernel 時間，也不與 host 區間相加。"),
    core: [
      "host_wall_ms",
      "host_cpu_time_ms",
      "runtime.host_wall_ms",
      "host_load_ms",
      "host_input_transfer_ms",
      "host_output_publish_ms",
      "host_encode_ms",
      "host_wait_ms",
      "gpu_event_ms",
    ],
    optional: [
      "steps.host_ms_p50",
      "steps.host_ms_p95",
      "steps.gpu_event_ms_p50",
      "steps.gpu_event_ms_p95",
      "prefetch_wait_ms",
      "caption_ttft_ms",
      "encoder_backpressure_ms",
      "gpu_kernel_union_ms",
      "api_enter_to_kernel_start_ms",
      "api_exit_to_kernel_start_ms",
    ],
  },
  {
    id: "memory",
    title: t("記憶體峰值與口徑"),
    note: t("每列口徑（scope）不同：allocated 包含於 reserved、NVML 整卡含其他程序與 driver、RSS 為取樣值。各列絕不相加。"),
    core: [
      "torch_allocated_peak_bytes",
      "torch_reserved_peak_bytes",
      "nvml_device_used_sample_peak_bytes",
      "nvml_process_used_bytes",
      "host_rss_sample_peak_bytes",
    ],
    optional: [
      "torch_allocated_current_bytes",
      "torch_reserved_current_bytes",
      "nvml_device_used_bytes",
      "nvml_device_total_bytes",
      "host_rss_current_bytes",
      "host_lifetime_peak_bytes",
      "host_available_bytes",
      "host_swap_used_bytes",
      "owned_weight_host_bytes",
      "owned_weight_device_bytes",
      "owned_pinned_host_bytes",
      "output_buffer_bytes",
      "allocation_fail_requested_bytes",
    ],
  },
  {
    id: "lifecycle",
    title: t("權重生命週期與 I/O 計數"),
    note: t("offload 週期（load→use→evict）與真正成對來回（H2D＋D2H 都完成）分開計；pin 不是 H2D，丟棄 device 副本不是 D2H。網路以 consumer 接收量為唯一合計。"),
    core: ["offload_cycle_count", "paired_roundtrip_count"],
    optional: [
      "block_load_count",
      "device_discard_count",
      "resident_hit_count",
      "prefetch_hit_count",
      "prefetch_miss_count",
      "pin_count",
      "unpin_count",
      "network_received_bytes",
      "network_sent_bytes",
      "logical_disk_read_bytes",
      "logical_disk_written_bytes",
      "copy_effective_gbps",
    ],
  },
  {
    id: "steps",
    title: t("步數／前向次數"),
    note: t("steps ≠ NFE ≠ module forward ≠ kernel 啟動數；kernel 數只來自 trace。"),
    core: ["scheduler_steps_completed", "denoiser_forwards_completed"],
    optional: [
      "block_forward_count",
      "cfg_branch_forward_count",
      "decode_forward_count",
      "frame_callback_count",
      "output_frame_count",
      "input_frame_count",
      "input_tokens",
      "output_tokens",
      "kernel_launch_count",
    ],
  },
  {
    id: "device",
    title: t("整卡取樣"),
    note: t("NVML 整卡數值包含其他程序；不是此 part 或此元件獨占的利用率。"),
    core: [],
    optional: ["device_utilization_pct", "memory_utilization_pct", "device_power_w", "device_temperature_c", "device_sm_clock_mhz"],
  },
  {
    id: "recorder",
    title: t("紀錄完整度與成本"),
    core: ["events_dropped", "publisher_dropped", "sample_count"],
    optional: ["measurement_error_count", "recorder_cpu_ms", "recorder_written_bytes", "publisher_bytes"],
  },
];

const GROUPED_NAMES = new Set(METRIC_GROUPS.flatMap((group) => [...group.core, ...group.optional]));

/** 不在任何群組、也不是逐類別搬運計數的 metric（provider 自訂命名空間等）。 */
export function ungroupedMetricNames(metrics: Record<string, Metric | undefined>): string[] {
  return Object.keys(metrics)
    .filter((name) => !GROUPED_NAMES.has(name) && parseTransferMetricName(name) === null)
    .sort((a, b) => a.localeCompare(b));
}

/** 依群組決定要列出的 metric 名稱：core 全列，optional 有回報才列。 */
export function groupMetricNames(group: MetricGroupDef, metrics: Record<string, Metric | undefined>): string[] {
  return [...group.core, ...group.optional.filter((name) => metrics[name] !== undefined)];
}

/** summary 沒有回報某 metric 時的佔位：明確「未回報」，不是 0。 */
export function missingMetric(name: string): Metric {
  const entry = catalogEntry(name) ?? EXTRA_ENTRIES[name];
  return {
    value: null,
    unit: entry?.unit ?? "",
    quality: "unavailable",
    scope: entry?.scope ?? "",
    method: entry?.method ?? "",
    reason: t("summary 未回報此指標（可能是 recorder 模式不含、元件不支援或尚未完成）"),
  };
}

export type MetricState = "measured" | "unmeasured" | "not_applicable";

export function metricState(metric: Metric): MetricState {
  if (metric.value === null || !Number.isFinite(metric.value)) {
    return metric.quality === "not_applicable" ? "not_applicable" : "unmeasured";
  }
  return "measured";
}

/** 數值文字：依 unit 格式化；null 回傳「未量測」／「不適用」。 */
export function formatMetricValue(metric: Metric): string {
  const state = metricState(metric);
  if (state === "not_applicable") return t("不適用");
  if (state === "unmeasured" || metric.value === null) return t("未量測");
  const value = metric.value;
  switch (metric.unit) {
    case "degC":
      return `${value.toFixed(1)} °C`;
    case "W":
      return `${value.toFixed(1)} W`;
    case "MHz":
      return `${Math.round(value).toLocaleString("en-US")} MHz`;
    case "FLOP":
      return `${value.toExponential(3)} FLOP`;
    default:
      return formatMetric(metric);
  }
}

/** 完整數值（bytes 另附精確 bytes），供 title／複製。 */
export function exactMetricValue(metric: Metric): string | null {
  if (metric.value === null || !Number.isFinite(metric.value)) return null;
  if (metric.unit === "bytes") return `${metric.value.toLocaleString("en-US")} bytes`;
  return `${String(metric.value)} ${metric.unit}`.trim();
}

export const QUALITY_TONE: Record<Quality, "neutral" | "info" | "entity" | "warning"> = {
  instrumented: "neutral",
  sampled: "info",
  trace: "entity",
  derived: "neutral",
  unavailable: "warning",
  not_applicable: "neutral",
  synthetic: "warning",
};

export const QUALITY_HELP: Record<Quality, string> = {
  instrumented: t("由執行路徑上的 hook／計時直接量測"),
  sampled: t("週期取樣；未必抓到瞬間峰值"),
  trace: t("來自 profiler trace 視窗；視窗外未知"),
  derived: t("由其他量測推導（附公式或聚合規則）"),
  unavailable: t("不可得：沒有量測或不支援"),
  not_applicable: t("不適用於此元件或裝置"),
  synthetic: t("合成示例，不是實際裝置量測"),
};
