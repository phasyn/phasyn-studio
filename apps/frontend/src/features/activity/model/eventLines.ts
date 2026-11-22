// Recording events → log lines (spans, logs, transfers, samples, steps and kinds outside the contract). Pure.
import type { RecordingEvent } from "@/api/generated/contracts";
import { eventSummary } from "@/lib/recordingEvents";
import { shortId } from "@/lib/format";
import { isRecord, previewValue } from "@/lib/json";
import { formatList } from "@/i18n/format";
import { t, tServer } from "@/i18n";
import { clip, joinParts, sortLines, type LogLevel, type LogLine, type LogSource } from "./lines";

export interface EventLineOptions {
  /** 此 recording 的 provider_id（runtime stream 來源的類型圖示）。 */
  providerId?: string;
  /** node_id → 顯示名稱（node stream 的來源）。 */
  nodeLabels?: ReadonlyMap<string, string>;
}

const EVENT_LEVELS = new Set<string>(["debug", "info", "warning", "error"]);

function eventSource(event: RecordingEvent, options: EventLineOptions): LogSource {
  if (event.stream_id === "node") return { kind: "node", label: options.nodeLabels?.get(event.node_id) ?? shortId(event.node_id) };
  if (event.stream_id === "controller") return { kind: "controller", label: t("主控") };
  return { kind: "component", label: event.component_id, ...((options.providerId != null && options.providerId !== "") ? { providerId: options.providerId } : {}) };
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 契約之外的 kind（例如 metric、error）：盡量用 name／value／code／message 呈現，其餘保留原始 JSON 預覽。 */
function otherKindMessage(kind: string, data: unknown): string {
  if (!isRecord(data)) return `${kind} ${previewValue(data, 160)}`;
  const name = stringField(data, "name");
  if ((name != null && name !== "") && "value" in data) {
    const value = data["value"];
    const unit = stringField(data, "unit");
    const shown = typeof value === "number" ? `${String(value)}${(unit != null && unit !== "") ? ` ${unit}` : ""}` : value === null ? t("未量測") : previewValue(value, 60);
    return `${kind} ${name}=${shown}`;
  }
  const code = stringField(data, "code");
  const message = stringField(data, "message");
  if ((code ?? "") || (message != null && message !== "")) return `${kind} ${joinParts([code, message], t("："))}`;
  return `${kind} ${previewValue(data, 160)}`;
}

function futureEvent(value: unknown): { kind: string; data: unknown } {
  if (!isRecord(value)) return { kind: "event", data: undefined };
  return { kind: typeof value["kind"] === "string" ? value["kind"] : "event", data: value["data"] };
}

function eventMessage(event: RecordingEvent): string {
  switch (event.kind) {
    case "log":
      return event.data.truncated ? t("{message}（已截斷）", { message: event.data.message }) : event.data.message;
    case "span": {
      const data = event.data;
      const gpuUnmeasured = data.gpu_event_ms === null && (data.gpu_device_id != null && data.gpu_device_id !== "") ? t("・GPU event 未量測") : "";
      return t("span {event}{gpuUnmeasured}（{quality}）", { event: eventSummary(event), gpuUnmeasured, quality: data.quality });
    }
    case "step":
      return eventSummary(event);
    case "transfer":
    case "sample":
    case "notice":
      return `${event.kind} ${eventSummary(event)}`;
    default: {
      const raw = futureEvent(event);
      return otherKindMessage(raw.kind, raw.data);
    }
  }
}

function eventDetail(event: RecordingEvent): string {
  const head = `${event.stream_id}#${String(event.seq)}`;
  switch (event.kind) {
    case "log": {
      const fields = event.data.fields;
      const hasFields = isRecord(fields) && Object.keys(fields).length > 0;
      return joinParts([head, hasFields && `fields ${clip(JSON.stringify(fields), 800)}`]);
    }
    // Reasons are fixed server texts (the server catalog has them): shown in the interface language
    case "span":
      return joinParts([head, `span_id ${event.data.span_id}`, event.data.coverage !== "full" && `coverage ${event.data.coverage}`, tServer(event.data.reason)]);
    case "transfer":
      return joinParts([head, `${event.data.src} → ${event.data.dst}`, tServer(event.data.reason)]);
    case "sample":
      return joinParts([head, formatList(Object.keys(event.data.metrics))]);
    case "notice":
      return joinParts([head, event.data.dropped_bytes > 0 && t("丟棄 {dropped_bytes} bytes", { dropped_bytes: event.data.dropped_bytes })]);
    case "step":
      return head;
    default: {
      const raw = futureEvent(event);
      return joinParts([head, clip(previewValue(raw.data, 800), 800)]);
    }
  }
}

export function lineFromEvent(event: RecordingEvent, options: EventLineOptions = {}): LogLine {
  const level: LogLevel = EVENT_LEVELS.has(event.level) ? event.level : "info";
  return {
    id: `ev:${event.recording_id}:${event.stream_id}:${String(event.seq)}`,
    at: event.occurred_at,
    level,
    source: eventSource(event, options),
    message: eventMessage(event),
    detail: eventDetail(event),
  };
}

/**
 * recording 事件 → 紀錄列。stream `runtime`＝元件程序、`node`＝Node、`controller`＝主控；
 * 不同 stream 沒有全域 seq，只以 occurred_at 粗排（同一毫秒保持輸入順序）。
 */
export function linesFromEvents(events: readonly RecordingEvent[], options: EventLineOptions = {}): LogLine[] {
  return sortLines(events.map((event) => lineFromEvent(event, options)));
}
