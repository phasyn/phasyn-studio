// One-line summaries of recording events (logs, notices, spans, transfers, steps, samples), shared by the recordings
// pages and the activity log. Pure.
import type { RecordingEvent } from "@/api/generated/contracts";
import { formatList } from "@/i18n/format";
import { formatBytes, formatMs } from "./format";
import { t, tServer } from "@/i18n";

export function eventSummary(event: RecordingEvent): string {
  switch (event.kind) {
    case "log":
      return event.data.truncated ? t("{message}（已截斷）", { message: event.data.message }) : event.data.message;
    case "notice":
      return t("{code}：{message}{value}", { code: event.data.code, message: tServer(event.data.message), value: event.data.dropped_events > 0 ? t("（丟棄 {dropped_events} 事件）", { dropped_events: event.data.dropped_events }) : "" });
    case "span": {
      const d = event.data;
      return `${d.name}${d.part ? ` · ${d.part}` : ""}${d.step_index !== null ? ` · step ${d.step_index}` : ""} · host ${formatMs(d.host_ms)}${
        d.gpu_event_ms !== null ? ` · GPU event ${formatMs(d.gpu_event_ms)}` : ""
      }`;
    }
    case "transfer": {
      const d = event.data;
      const completed = d.completed_bytes === null ? t("未確認完成") : t("完成 {completed_bytes}", { completed_bytes: formatBytes(d.completed_bytes) });
      return t("{category} {direction} · {owner} · 提交 {submitted_bytes} · {completed} · {completion_status}", { category: d.category, direction: d.direction, owner: d.owner, submitted_bytes: formatBytes(d.submitted_bytes), completed, completion_status: d.completion_status });
    }
    case "step": {
      const d = event.data;
      return `step ${d.step_index}${d.forward_index !== null ? ` · forward ${d.forward_index}` : ""}${d.cfg_branch ? ` · ${d.cfg_branch}` : ""}${
        d.sigma !== null ? ` · sigma ${d.sigma}` : ""
      } · host ${formatMs(d.host_ms)}${d.gpu_event_ms !== null ? ` · GPU event ${formatMs(d.gpu_event_ms)}` : ""}`;
    }
    case "sample": {
      const names = Object.keys(event.data.metrics);
      return t("取樣 {namesCount} 項{value}{value2}", { namesCount: names.length, value: event.data.device_id ? ` · ${event.data.device_id}` : "", value2: names.length ? t("：{names}{value}", { names: formatList(names.slice(0, 4)), value: names.length > 4 ? "…" : "" }) : "" });
    }
  }
}
