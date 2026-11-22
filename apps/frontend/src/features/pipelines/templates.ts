// 內建流程範本：只產生可編輯的草稿；每一步都指向使用者在目錄中選的元件，不寫死任何主機。
// 接線依各元件實際宣告的連接埠與 type_id 自動帶入（同型別才接），結果仍需使用者檢視。
import type { ComponentDescriptor, Port } from "@/api/generated/contracts";
import type { WireBinding, WirePipeline, WireStep } from "@/api/types";
import { VARIANT_FL2VA, VARIANT_REF2VA } from "@/lib/h3Variant";
import { uniqueName } from "@/lib/ids";
import { isRecord } from "@/lib/json";
import { describeField, objectProperties } from "@/lib/schema";
import { t } from "@/i18n";

// 參考生成（ref2va）用到的 type_id：素材輸入，以及影像／聲音兩個參考編碼各自輸出的 partial reference latents
const MATERIALS = "h3.materials.v1";
const VIDEO_REFERENCES = "h3.references.video.v1";
const AUDIO_REFERENCES = "h3.references.audio.v1";
// H3 與 Qwen-Image 的 DiT 都是 dit.denoise：以輸出分辨（H3 輸出 final video latent，Qwen-Image 輸出自己的 packed latent）
const VIDEO_LATENT = "video.final-latent.v1";
const QIMG_LATENT = "qimg.latent.v1";
// Qwen-Image 圖生圖的參考圖清單（[{file, label?}]，inline）
const QIMG_REFERENCES = "qimg.references.v1";

export type TemplateId = "generation" | "reference" | "t2i" | "i2i" | "semantics";

export interface TemplateSlot {
  id: string;
  label: string;
  /** 可選的元件 kind（ProviderInfo.kind）；第一個是預設建議。 */
  kinds: string[];
  /** 同一個 kind 內再以輸出埠的 type_id 分辨（影像與聲音的參考編碼都是 reference.encode）。 */
  outputType?: string;
  /** H3 元件需要的 checkpoint variant（DiT：生成用 fl2va，參考生成用 ref2va）；符合的排在最前面，選到不符的會警告。 */
  variant?: string;
  optional?: "audio";
}

export interface TemplateSpec {
  id: TemplateId;
  label: string;
  description: string;
  slots: TemplateSlot[];
  defaultPipelineId: string;
  /** 由 type_id 自動建立 pipeline 輸入時採用的名稱。 */
  inputNames: Record<string, string>;
  /** 這些 type_id 的輸入埠即使是選用的，也建成 pipeline 輸入（範本的用途需要它，例如參考素材）。 */
  requiredInputs?: string[];
  /**
   * 這些步驟埠（`<slot>.<port>`）各自接到一個選用的 pipeline 輸入（值＝輸入名稱），不和同型別的其他輸入共用：
   * 例如負面提示詞與 prompt 同為 text.prompt.v1，共用就會把 prompt 當成負面提示詞送出。
   */
  optionalInputs?: Record<string, string>;
  /** 預填的呼叫參數（只填 parameters_schema 有宣告的欄位）。 */
  parameterDefaults?: Record<string, Record<string, unknown>>;
}

/** buildFromTemplate 實際讀取的欄位：不列在範本清單的單步驟草稿（例如 run 頁的正式解碼）也用同一個接線器。 */
export type TemplateWiring = Pick<TemplateSpec, "inputNames" | "requiredInputs" | "optionalInputs" | "parameterDefaults">;

// Qwen-Image 兩個範本共用的步驟與預填參數（與 examples/pipelines/t2i-local.json、i2i-local.json 相同；Image Studio
// 依 provider 認出每一步的角色，生成時再以圖片的設定覆寫尺寸、步數、guidance 與 seed）
const IMAGE_TE: TemplateSlot = { id: "te", label: t("文字條件（image.conditioning）"), kinds: ["image.conditioning"] };
const IMAGE_DIT: TemplateSlot = { id: "dit", label: t("去噪（dit.denoise：Qwen-Image DiT）"), kinds: ["dit.denoise"], outputType: QIMG_LATENT };
const IMAGE_DECODE: TemplateSlot = { id: "vae", label: t("VAE 解碼（image.decode）"), kinds: ["image.decode"] };
const IMAGE_COMPOSE: TemplateSlot = { id: "compose", label: t("合成輸出（image.compose：白底版與遮罩合成）"), kinds: ["image.compose"] };
const IMAGE_PARAMETERS: Record<string, Record<string, unknown>> = {
  te: { cfg: false },
  dit: { width: 1024, height: 1024, steps: 40, guidance: 1, seed: 42 },
  vae: { mode: "full" },
};

export const TEMPLATES: readonly TemplateSpec[] = [
  {
    id: "generation",
    label: t("生成：TE→DiT→正式解碼"),
    description: t("conditioning.encode → dit.denoise → decode.final；可選音訊分支 audio.decode → media.mux。最終 latent 也列為輸出，之後可從同一來源重新解碼。"),
    slots: [
      { id: "conditioning", label: t("文字條件（conditioning.encode）"), kinds: ["conditioning.encode"] },
      { id: "denoise", label: t("去噪（dit.denoise）"), kinds: ["dit.denoise"], outputType: VIDEO_LATENT, variant: VARIANT_FL2VA },
      { id: "video", label: t("影片解碼（decode.final；也可選 decode.preview 產生草稿）"), kinds: ["decode.final", "decode.preview"] },
      { id: "audio", label: t("音訊解碼（audio.decode）"), kinds: ["audio.decode"], optional: "audio" },
      { id: "mux", label: t("合併音軌（media.mux）"), kinds: ["media.mux"], optional: "audio" },
    ],
    defaultPipelineId: "generation",
    inputNames: { "text.prompt.v1": "prompt" },
  },
  {
    id: "reference",
    label: t("參考生成：TE→參考編碼→DiT→正式解碼"),
    description: t("conditioning.encode（task=ref2va，接收參考素材 h3.materials.v1）→ reference.encode（影像、聲音）→ dit.denoise → decode.final；可選音訊分支 audio.decode → media.mux。DiT 需為 Ref2VA checkpoint。最終 latent 也列為輸出，之後可從同一來源重新解碼。"),
    slots: [
      { id: "conditioning", label: t("文字條件（conditioning.encode）"), kinds: ["conditioning.encode"] },
      { id: "ref_visual", label: t("影像參考編碼（reference.encode：圖片與影片）"), kinds: ["reference.encode"], outputType: VIDEO_REFERENCES },
      { id: "ref_audio", label: t("聲音參考編碼（reference.encode：參考聲音與影片原聲）"), kinds: ["reference.encode"], outputType: AUDIO_REFERENCES },
      { id: "denoise", label: t("去噪（dit.denoise；需 Ref2VA checkpoint）"), kinds: ["dit.denoise"], outputType: VIDEO_LATENT, variant: VARIANT_REF2VA },
      { id: "video", label: t("影片解碼（decode.final；也可選 decode.preview 產生草稿）"), kinds: ["decode.final", "decode.preview"] },
      { id: "audio", label: t("音訊解碼（audio.decode）"), kinds: ["audio.decode"], optional: "audio" },
      { id: "mux", label: t("合併音軌（media.mux）"), kinds: ["media.mux"], optional: "audio" },
    ],
    defaultPipelineId: "reference-generation",
    inputNames: { "text.prompt.v1": "prompt", [MATERIALS]: "materials" },
    requiredInputs: [MATERIALS],
    parameterDefaults: { conditioning: { task: "ref2va" } },
  },
  {
    id: "t2i",
    label: t("文生圖：TE→DiT→VAE 解碼→合成"),
    description: t("Qwen-Image：image.conditioning → dit.denoise → image.decode → image.compose，輸出 image 與白底 image_white；負面提示詞是選用輸入（guidance > 1 時才編碼）。Image Studio 可以直接選它當文生圖的元件組合。"),
    slots: [IMAGE_TE, IMAGE_DIT, IMAGE_DECODE, IMAGE_COMPOSE],
    defaultPipelineId: "text-to-image",
    inputNames: { "text.prompt.v1": "prompt" },
    optionalInputs: { "te.negative_prompt": "negative_prompt" },
    parameterDefaults: IMAGE_PARAMETERS,
  },
  {
    id: "i2i",
    label: t("圖生圖：前處理→TE‖參考圖編碼→DiT→VAE 解碼→合成"),
    description: t("Qwen-Image：image.prepare（1–4 張參考圖與選用的遮罩）→ image.conditioning 與 image.reference_encode → dit.denoise → image.decode → image.compose（有遮罩時與底圖合成），輸出 image 與白底 image_white。Image Studio 可以直接選它當圖生圖的元件組合。"),
    slots: [
      { id: "prepare", label: t("前處理（image.prepare：參考圖與遮罩）"), kinds: ["image.prepare"] },
      IMAGE_TE,
      { id: "venc", label: t("參考圖編碼（image.reference_encode）"), kinds: ["image.reference_encode"] },
      IMAGE_DIT,
      IMAGE_DECODE,
      IMAGE_COMPOSE,
    ],
    defaultPipelineId: "image-to-image",
    inputNames: { "text.prompt.v1": "prompt", [QIMG_REFERENCES]: "references" },
    optionalInputs: { "te.negative_prompt": "negative_prompt", "prepare.mask": "mask" },
    parameterDefaults: {
      ...IMAGE_PARAMETERS,
      prepare: { width: 1024, height: 1024, reference_resolution: 1024, base_index: 0, mask_invert: false },
      venc: { tiling: false },
    },
  },
  {
    id: "semantics",
    label: t("反推語意→caption"),
    description: t("video.describe（預設 4 FPS、快動作 12 FPS、保留首尾）→ caption.compile（預設排除 uncertain）。"),
    slots: [
      { id: "describe", label: t("反推語意（video.describe）"), kinds: ["video.describe"] },
      { id: "caption", label: t("組裝 caption（caption.compile）"), kinds: ["caption.compile"] },
    ],
    defaultPipelineId: "video-semantics",
    inputNames: { "media.video.v1": "video" },
    parameterDefaults: {
      describe: { sampling_fps: 4, fast_motion_fps: 12, preserve_endpoints: true },
      caption: { include_uncertain: false },
    },
  },
];

export function templateById(id: TemplateId): TemplateSpec {
  const found = TEMPLATES.find((template) => template.id === id);
  if (!found) throw new Error(`unknown template ${id}`);
  return found;
}

/** 只保留 parameters_schema 有宣告的欄位；schema 有 default 時以 default 為準。 */
function prefilledParameters(descriptor: ComponentDescriptor, wanted: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!wanted) return {};
  const schema = descriptor.settings.parameters_schema;
  const root = isRecord(schema) ? schema : undefined;
  const properties = new Map(objectProperties(schema, root));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted)) {
    const property = properties.get(key);
    if (property === undefined) continue;
    const info = describeField(property, root);
    out[key] = info.hasDefault ? info.defaultValue : value;
  }
  return out;
}

function pipelineInputFor(port: Port, preferred: string | undefined, taken: Set<string>, required = true): Port {
  const name = uniqueName(preferred ?? port.name, taken);
  taken.add(name);
  return {
    name,
    type_id: port.type_id,
    required,
    transport: port.transport,
    description: port.description || port.name,
  };
}

export interface TemplateBuild {
  pipeline: WirePipeline;
  /** 自動接線無法解決的必填輸入（需使用者處理）。 */
  unresolved: string[];
}

/**
 * 依選定元件建立草稿：範本列在 optionalInputs 的埠接到它自己的選用 pipeline 輸入；其他輸入埠優先接「最近的上游
 * 同型別輸出」，否則必填埠（或範本列為 requiredInputs 的 type_id）建立同型別 pipeline 輸入；其餘選填埠不接。
 * 輸出：沒有下游使用的步驟的所有輸出，以及所有 final latent（之後可從同一來源重新解碼）。
 */
export function buildFromTemplate(
  spec: TemplateWiring,
  chosen: readonly { slot: Pick<TemplateSlot, "id">; descriptor: ComponentDescriptor }[],
  pipelineId: string,
  label: string,
): TemplateBuild {
  const inputs: Port[] = [];
  const takenInputs = new Set<string>();
  const steps: WireStep[] = [];
  const unresolved: string[] = [];
  const consumed = new Set<string>();
  /** optionalInputs 建立的輸入：只屬於範本指定的那個埠，不給其他同型別的埠共用。 */
  const dedicated = new Set<string>();

  for (const { slot, descriptor } of chosen) {
    const bindings: Record<string, WireBinding> = {};
    for (const port of descriptor.inputs) {
      const optionalName = spec.optionalInputs?.[`${slot.id}.${port.name}`];
      if (optionalName !== undefined) {
        const input = pipelineInputFor(port, optionalName, takenInputs, false);
        inputs.push(input);
        dedicated.add(input.name);
        bindings[port.name] = { from_input: input.name };
        continue;
      }
      let bound = false;
      for (let index = steps.length - 1; index >= 0 && !bound; index -= 1) {
        const upstream = steps[index];
        const upstreamDescriptor = upstream ? chosen[index]?.descriptor : undefined;
        if (!upstream || !upstreamDescriptor) continue;
        const output = upstreamDescriptor.outputs.find((candidate) => candidate.type_id === port.type_id);
        if (output) {
          bindings[port.name] = { from_step: upstream.step_id, output: output.name };
          consumed.add(upstream.step_id);
          bound = true;
        }
      }
      if (bound) continue;
      const existing = inputs.find((input) => input.type_id === port.type_id && !dedicated.has(input.name));
      if (existing) {
        bindings[port.name] = { from_input: existing.name };
      } else if (port.required || Boolean(spec.requiredInputs?.includes(port.type_id))) {
        const input = pipelineInputFor(port, spec.inputNames[port.type_id], takenInputs);
        inputs.push(input);
        bindings[port.name] = { from_input: input.name };
      }
    }
    steps.push({
      step_id: slot.id,
      node_id: descriptor.node_id,
      component_id: descriptor.component_id,
      inputs: bindings,
      parameters: prefilledParameters(descriptor, spec.parameterDefaults?.[slot.id]),
    });
    for (const port of descriptor.inputs) {
      if (port.required && !bindings[port.name]) unresolved.push(`${slot.id}.${port.name}`);
    }
  }

  const outputs: WirePipeline["outputs"] = {};
  const takenOutputs = new Set<string>();
  chosen.forEach(({ descriptor }, index) => {
    const step = steps[index];
    if (!step) return;
    for (const port of descriptor.outputs) {
      const isLatent = port.type_id.endsWith("final-latent.v1");
      if (consumed.has(step.step_id) && !isLatent) continue;
      const name = uniqueName(port.name, takenOutputs);
      takenOutputs.add(name);
      outputs[name] = { from_step: step.step_id, output: port.name };
    }
  });

  return { pipeline: { pipeline_id: pipelineId, label, inputs, steps, outputs }, unresolved };
}
