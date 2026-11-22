import type { PlacementAlternative, PlacementEnvelope } from "@/api/generated/contracts";
import { wireDefinitions } from "@/lib/contractSchemas";
import { apiFetch, matchesReply } from "@/api/http";
import type { WireTypedValue } from "@/api/types";
import { t, tServer } from "@/i18n";
import { isRecord } from "@/lib/json";

export type Inputs = Record<string, WireTypedValue | null>;
export interface Row {
  id: string; pipeline: string; mode: "history" | "budget"; run: string; padding: string; basis: string; bytes: Record<string, string>;
}
export const makeRow = (pipeline: string, run = ""): Row => ({
  id: crypto.randomUUID(), pipeline, mode: "history", run, padding: "15", basis: "", bytes: {},
});

export function deviceKeys(item: PlacementAlternative) {
  return Object.keys(item.nodes).map((node) => {
    const devices = new Set<string>();
    const snapshot = item.nodes[node];
    const observed = isRecord(snapshot) && isRecord(snapshot["devices"]) ? snapshot["devices"] : {};
    for (const raw of Object.values(item.steps)) {
      const cfg = isRecord(raw) && isRecord(raw["configuration"]) ? raw["configuration"] : {};
      const device = typeof cfg["device"] === "string" ? observed[cfg["device"]] : undefined;
      if (cfg["node"] === node && typeof cfg["device"] === "string" && isRecord(device) && device["kind"] === "cuda") devices.add(cfg["device"]);
    }
    return { node, devices: [...devices].sort() };
  });
}

function bytes(text: string | undefined) {
  if (!((text?.trim() ?? "") !== "")) throw new Error(t("請填寫每個記憶體池的增量預算，無需配置時可填 0。"));
  const mib = Number(text);
  const value = Math.ceil(mib * 1024 * 1024);
  if (!Number.isFinite(mib) || mib < 0 || !Number.isSafeInteger(value)) throw new Error(t("記憶體預算必須是有限的非負數值。"));
  return value;
}

export function entry(row: Row, observed: PlacementAlternative | undefined) {
  if (row.mode === "history") {
    const padding = Number(row.padding);
    if (!row.run) throw new Error(t("請選擇此候選管線的成功執行。"));
    if (row.padding === "" || !Number.isInteger(padding) || padding < 0 || padding > 100) throw new Error(t("量測預留百分比必須是 0 到 100 的整數。"));
    return { pipeline_id: row.pipeline, source_run_id: row.run, padding_percent: padding };
  }
  if (!(observed?.signature != null && observed.signature !== "") || !Object.keys(observed.nodes).length) throw new Error(t("請先讀取目前管線與節點配置。"));
  const nodes: PlacementEnvelope["nodes"] = {};
  for (const { node, devices } of deviceKeys(observed)) {
    nodes[node] = { host_bytes: bytes(row.bytes[`${node}/host`]), device_bytes: Object.fromEntries(devices.map((device) => [device, bytes(row.bytes[`${node}/${device}`])])) };
  }
  if (!row.basis.trim()) throw new Error(t("請填寫預算依據及適用條件。"));
  return { pipeline_id: row.pipeline, envelope: { signature: observed.signature, basis: row.basis.trim(), nodes } };
}

interface NumericSource { source?: string }
function hasRawJSON(value: object): value is { rawJSON(source: string): unknown } {
  return "rawJSON" in value && typeof value.rawJSON === "function";
}

/** Preserve the Controller's signed numbers across JSON.parse/stringify (1.0, signed 64-bit seeds). */
export async function preview(rows: ReturnType<typeof entry>[] | {pipeline_id: string}[], inputs: Inputs) {
  const response = await apiFetch("/api/placement/preview", {
    method: "POST",
    json: { alternatives: rows, inputs: Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== null)) },
  });
  const raw = await response.text();
  const data: unknown = JSON.parse(raw);
  if (!matchesReply(data, "PlacementPreview", await wireDefinitions())) throw new Error(t("回應格式不正確"));
  if (!data.run_request) return { data, request: null, unsupported: false };
  if (!hasRawJSON(JSON)) return { data, request: null, unsupported: true };
  const originalNumber = JSON.rawJSON;
  const missing: string[] = [];
  const parsed: unknown = JSON.parse(raw, (key: string, value: unknown, context?: NumericSource) => {
    if (typeof value !== "number") return value;
    if (context?.source === undefined) { missing.push(key); return value; }
    return context.source === JSON.stringify(value) ? value : originalNumber(context.source);
  });
  if (missing.length > 0 || !isRecord(parsed) || !isRecord(parsed["run_request"])) {
    return { data, request: null, unsupported: true };
  }
  return { data, request: { serializedRun: JSON.stringify(parsed["run_request"]) }, unsupported: false };
}

export function explain(reason: string) {
  const words: Record<string, string> = {
    missing_shape_envelope: t("缺少與目前形狀相符的資源量測或預算"),
    measurement_does_not_match_frozen_request: t("預算對應的設定已變更，請重新讀取節點配置"),
    resource_group_busy: t("元件的資源群組正忙"),
    controller_slots_busy: t("Controller 的執行名額已滿"),
    device_active: t("裝置目前仍有其他工作"),
    component_not_loaded: t("元件尚未載入"),
    insufficient_headroom: t("目前可用記憶體不足"),
    exceeds_capacity: t("需求超過記憶體池容量"),
    combined_pool_exceeds_capacity: t("同一實體記憶體池的合計需求超過容量"),
    combined_pool_or_reservation_busy: t("實體記憶體池已被其他執行預留"),
    node_unreachable_or_unverified: t("無法驗證節點現況"),
    host_pool_unmeasured: t("缺少主機記憶體量測"),
  };
  const code = reason.split(":").find((part) => Object.hasOwn(words, part));
  return (code != null && code !== "") ? `${String(words[code])} · ${reason}` : tServer(reason);
}
