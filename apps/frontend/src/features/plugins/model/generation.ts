// 插件的生成設定（契約 StudioPluginGeneration；檢查的規則在 「Evaluating rules」第 7 點）：
//   require＝專案選用這個生成設定時，渲染規劃檢查每一項：實際的值不在允許的清單裡就擋下渲染並說明，兩邊的值都不改；
//   defaults＝只在使用者按「套用」時寫進專案（看得見的一次寫入），渲染時從不偷偷套用。
// 能表達的欄位是白名單（畫面、影格數、步數、shift、路由能力、參考影片短邊）；seed、模型、dtype 與裝置無法表達。
// 這裡是純函式：實際的值由呼叫端（Studio 的渲染規劃）提供，不知道的值傳 null，一律視為不符合（fail closed）。
import type { StudioPluginGeneration, StudioPluginGenerationRequirement, StudioPluginRef } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { generationLabel } from "./evaluate";
import type { RegistryGeneration } from "./registry";
import { pluginText } from "./text";

export type GenerationField = StudioPluginGenerationRequirement["field"];
export type RouteCapability = "t2va" | "fl2va" | "ref2va";

export interface FrameSize {
  width: number;
  height: number;
}

/** 渲染規劃時每個欄位實際的值；null＝呼叫端無法確定（例如 DiT 用元件內建的步數）。 */
export interface GenerationActuals {
  format: FrameSize | null;
  frames: number | null;
  steps: number | null;
  video_shift: number | null;
  audio_shift: number | null;
  route_capability: RouteCapability | null;
  reference_video_short_edge: number | null;
}

const FIELD_LABELS: Record<GenerationField, () => string> = {
  format: () => t("畫面"),
  frames: () => t("影格數"),
  steps: () => t("步數"),
  video_shift: () => "video shift",
  audio_shift: () => "audio shift",
  route_capability: () => t("運算路由的能力"),
  reference_video_short_edge: () => t("參考影片短邊"),
};

export function generationFieldLabel(field: string): string {
  return field in FIELD_LABELS ? FIELD_LABELS[field as GenerationField]() : field;
}

function isFrameSize(value: unknown): value is FrameSize {
  return typeof value === "object" && value !== null && typeof (value as FrameSize).width === "number" && typeof (value as FrameSize).height === "number";
}

/** 欄位值的顯示寫法：畫面是 1280×736，其餘照原樣。 */
export function formatGenerationValue(value: unknown): string {
  if (isFrameSize(value)) return `${value.width}×${value.height}`;
  return typeof value === "number" || typeof value === "string" ? String(value) : t("未知");
}

/** 數字依數值比較（3.0 就是 3）；畫面要寬與高都相同。 */
function sameValue(actual: unknown, allowed: unknown): boolean {
  if (isFrameSize(actual) && isFrameSize(allowed)) return actual.width === allowed.width && actual.height === allowed.height;
  return actual === allowed;
}

export interface GenerationFinding {
  /** 生成設定的引用。 */
  ref: StudioPluginRef;
  requirementId: string;
  field: string;
  /** 生成設定的標籤（已依介面語言取出）。 */
  label: string;
  /** 插件對這項要求的說明（已依介面語言取出）。 */
  message: string;
  /** 目前的值；無法確定時為 null。 */
  actual: string | null;
  /** 允許的值。 */
  allowed: string[];
}

function actualOf(actuals: GenerationActuals, field: string): unknown {
  return Object.hasOwn(actuals, field) ? actuals[field as GenerationField] : null;
}

/** 選用的生成設定裡，目前不符合的要求（空陣列＝全部符合）。 */
export function checkGeneration(entries: readonly RegistryGeneration[], actuals: GenerationActuals): GenerationFinding[] {
  const findings: GenerationFinding[] = [];
  for (const entry of entries) {
    for (const requirement of entry.generation.require ?? []) {
      const allowed: readonly unknown[] = Array.isArray(requirement.in) ? requirement.in : [];
      const actual = actualOf(actuals, requirement.field);
      if (actual !== null && allowed.some((value) => sameValue(actual, value))) continue;
      findings.push({
        ref: entry.ref,
        requirementId: requirement.id,
        field: requirement.field,
        label: generationLabel(entry),
        message: pluginText(requirement.message, requirement.id),
        actual: actual === null ? null : formatGenerationValue(actual),
        allowed: allowed.map(formatGenerationValue),
      });
    }
  }
  return findings;
}

/** 一項不符合的要求寫成一句話（插件的說明＋目前的值與允許的值）。 */
export function generationFindingText(finding: GenerationFinding): string {
  const values = {
    label: finding.label,
    message: finding.message,
    field: generationFieldLabel(finding.field),
    allowed: formatList(finding.allowed, { type: "disjunction" }),
  };
  return finding.actual === null
    ? t("{label}：{message}（無法確認目前的{field}；需要 {allowed}）", values)
    : t("{label}：{message}（目前的{field}是 {actual}；需要 {allowed}）", { ...values, actual: finding.actual });
}

export type GenerationDefaultField = keyof NonNullable<StudioPluginGeneration["defaults"]>;

export interface GenerationDefault {
  field: GenerationDefaultField;
  label: string;
  value: FrameSize | number;
  text: string;
}

const DEFAULT_ORDER: readonly GenerationDefaultField[] = ["format", "frames", "steps", "video_shift", "audio_shift"];

/** 生成設定提供的預設值，依固定順序（畫面、影格數、步數、shift）。 */
export function generationDefaults(generation: StudioPluginGeneration): GenerationDefault[] {
  const defaults = generation.defaults ?? {};
  return DEFAULT_ORDER.flatMap((field) => {
    const value = defaults[field];
    return value === undefined ? [] : [{ field, label: generationFieldLabel(field), value, text: formatGenerationValue(value) }];
  });
}
