// 切鏡偵測：用 DiT 所在 Node 的 media.probe 元件跑一個步驟的 run（參數 scenes），讀回 MediaInfo 的切鏡時間。
// 純函式：選元件、判斷支援、組 run 請求、解析結果。送出與輪詢在 useCutDetection。
import type { ApiErrorBody, Catalog, ComponentDescriptor, FileRef, MediaInfo, MediaSceneDetection } from "@/api/generated/contracts";
import { asApiErrorBody, parseRunStep, type RunRequestBody, type WireRun } from "@/api/types";
import { isRecord } from "@/lib/json";
import { t } from "@/i18n";

export const PROBE_PROVIDER = "media.probe";
const PROBE_STEP = "probe";

/** 切鏡偵測的參數（契約 MediaSceneDetection：threshold 0.05–0.9、預設 0.3；min_gap_seconds 0–10、預設 0.5）。 */
export type SceneParameters = MediaSceneDetection;

export const SCENE_DEFAULTS: SceneParameters = { threshold: 0.3, min_gap_seconds: 0.5 };
/**
 * Quick cuts (TV anime action): a lower threshold and a shorter gap find the half-second shots the default merges.
 */
export const SCENE_QUICK_CUTS: SceneParameters = { threshold: 0.2, min_gap_seconds: 0.3 };
export const SCENE_LIMITS = { threshold: { min: 0.05, max: 0.9 }, min_gap_seconds: { min: 0, max: 10 } } as const;

/** 換角用到的 MediaInfo（契約 media.probe.v1）欄位；缺少的值是 null（不猜）。 */
export interface ProbeSceneInfo {
  duration_seconds: MediaInfo["duration_seconds"];
  width: MediaInfo["width"];
  height: MediaInfo["height"];
  has_audio: boolean | null;
  fps: number | null;
  frame_count: MediaInfo["frame_count"];
  /** null＝結果沒有切鏡欄位（沒有要求偵測時契約會省略這兩個欄位）。 */
  scene_cuts_seconds: number[] | null;
  scene_detection: MediaSceneDetection | null;
}

/** 選 media.probe：優先在指定的 Node（換角路由的 DiT 所在），其次就緒的。 */
export function pickProbeComponent(catalog: Catalog | undefined, preferNodeId: string | null): ComponentDescriptor | null {
  const all = (catalog?.nodes ?? []).flatMap((node) => node.components).filter((item) => item.provider_id === PROBE_PROVIDER);
  const usable = (item: ComponentDescriptor) => item.state === "ready" || item.state === "busy";
  const score = (item: ComponentDescriptor) => (item.node_id === preferNodeId ? 2 : 0) + (usable(item) ? 1 : 0);
  return [...all].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export interface ProbeSupport {
  /** 目錄裡元件的參數 schema 宣告了 scenes（Node 載入新版 media.probe 後才有）。 */
  scenes: boolean;
  /** 現在能送出：元件存在且 ready／busy。沒有宣告 scenes 仍可送出——Node 的回應（多半是 422）原樣顯示，不改成「沒有切鏡」。 */
  usable: boolean;
  /** 不能送出的原因（繁中）；可以時為 null。 */
  reason: string | null;
  /** 可以送出、但送出前要知道的事（目錄沒有宣告 scenes）；沒有時為 null。 */
  warning: string | null;
}

export const SCENES_NOT_DECLARED =
  t("目錄裡的 media.probe 還沒宣告 scenes 參數（Node 服務重啟、載入新版元件後才會出現）：現在送出很可能被 Node 拒絕（422），錯誤會原樣顯示、不會自動重試");

export function probeSupport(component: ComponentDescriptor | null): ProbeSupport {
  if (!component) return { scenes: false, usable: false, reason: t("找不到媒體探測元件（media.probe）：到「元件修改・元件」新增，或勾選不偵測"), warning: null };
  const properties = component.settings.parameters_schema.properties;
  const scenes = isRecord(properties) && isRecord(properties.scenes);
  const ready = component.state === "ready" || component.state === "busy";
  return {
    scenes,
    usable: ready,
    reason: ready ? null : t("媒體探測元件（{component_id}）目前是 {state}，到「元件修改・元件」啟動後再偵測", { component_id: component.component_id, state: component.state }),
    warning: scenes ? null : SCENES_NOT_DECLARED,
  };
}

export function probeRunRequest(component: Pick<ComponentDescriptor, "node_id" | "component_id">, file: FileRef, scenes: SceneParameters, name: string): RunRequestBody {
  const label = t("一鍵換角：切鏡偵測・{name}", { name }).slice(0, 200);
  return {
    pipeline: {
      pipeline_id: "studio-swap-probe",
      label,
      inputs: [{ name: "media", type_id: "media.video.v1", required: true, transport: "file", description: t("來源影片") }],
      steps: [{ step_id: PROBE_STEP, node_id: component.node_id, component_id: component.component_id, inputs: { media: { from_input: "media" } }, parameters: { scenes } }],
      outputs: { info: { from_step: PROBE_STEP, output: "info" } },
    },
    inputs: { media: { type_id: "media.video.v1", file } },
    label,
  };
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** MediaInfo → 換角需要的欄位；切鏡只保留 (0, duration) 內的有限數字，排序去重。 */
export function parseProbeInfo(value: unknown): ProbeSceneInfo | null {
  if (!isRecord(value)) return null;
  const duration = num(value.duration_seconds);
  const fpsNum = num(value.fps_num);
  const fpsDen = num(value.fps_den);
  let cuts: number[] | null = null;
  if (Array.isArray(value.scene_cuts_seconds)) {
    const list = value.scene_cuts_seconds.flatMap((item) => {
      const cut = num(item);
      return cut !== null && cut > 0 && (duration === null || cut < duration) ? [cut] : [];
    });
    cuts = [...new Set(list)].sort((a, b) => a - b);
  }
  const detection = isRecord(value.scene_detection) && num(value.scene_detection.threshold) !== null && num(value.scene_detection.min_gap_seconds) !== null
    ? { threshold: value.scene_detection.threshold as number, min_gap_seconds: value.scene_detection.min_gap_seconds as number }
    : null;
  return {
    duration_seconds: duration !== null && duration > 0 ? duration : null,
    width: num(value.width),
    height: num(value.height),
    has_audio: typeof value.has_audio === "boolean" ? value.has_audio : null,
    fps: fpsNum !== null && fpsDen !== null && fpsDen > 0 ? fpsNum / fpsDen : null,
    frame_count: num(value.frame_count),
    scene_cuts_seconds: cuts,
    scene_detection: detection,
  };
}

export type ProbeOutcome =
  | { state: "running" }
  | { state: "succeeded"; info: ProbeSceneInfo }
  | { state: "failed" | "cancelled" | "interrupted"; error: ApiErrorBody | null };

/**
 * 由 run 讀回偵測結果。成功但讀不到 MediaInfo、或有要求 scenes 卻沒有 scene_cuts_seconds（Node 沒有執行偵測）都算失敗：
 * 不把它當成「沒有切鏡」。
 */
export function probeOutcome(run: WireRun): ProbeOutcome {
  if (run.state === "running") return { state: "running" };
  const step = parseRunStep(PROBE_STEP, run.steps[PROBE_STEP]);
  const output = step.outputs.info;
  if (run.state === "succeeded") {
    const info = output && "value" in output ? parseProbeInfo(output.value) : null;
    if (!info) return { state: "failed", error: { code: "OUTPUT_MISSING", message: t("偵測的 run 成功，但讀不到 MediaInfo") } };
    if (info.scene_cuts_seconds === null) return { state: "failed", error: { code: "OUTPUT_MISSING", message: t("結果沒有 scene_cuts_seconds：Node 的 media.probe 沒有執行切鏡偵測（可能還沒更新）") } };
    return { state: "succeeded", info };
  }
  return { state: run.state, error: step.error ?? asApiErrorBody(run.error) };
}
