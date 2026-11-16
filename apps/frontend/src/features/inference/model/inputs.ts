// 推理頁的輸入模型：依 pipeline 輸入的 type_id／transport 選編輯器、草稿 → run 輸入、送出前檢查。純函式。
import type { Asset, Port } from "@/api/generated/contracts";
import { asAsset, asTypedValueMap, runSteps, type WireRun, type WireTypedValue } from "@/api/types";
import { runDisplayName } from "@/lib/runName";
import { materialIssues, materialsValue, type MaterialDraft } from "./materials";
import { t } from "@/i18n";

/**
 * prompt：多行文字；media：上傳圖片／影片／聲音（FileRef）；asset：media.asset.v1（Asset 需要實測的幀數與 fps，
 * 上傳的檔案沒有這些值，所以 inline 時只能挑選既有 Asset）；materials：H3 ref2va 參考素材；generic：既有的 JSON／檔案編輯器。
 */
export type InputEditor = "prompt" | "media" | "asset" | "materials" | "generic";

export const MEDIA_TYPES = ["media.image.v1", "media.video.v1", "media.audio.v1"] as const;
export type MediaFamily = "image" | "video" | "audio";

export function mediaFamily(typeId: string): MediaFamily | null {
  if (typeId === "media.image.v1") return "image";
  if (typeId === "media.video.v1") return "video";
  if (typeId === "media.audio.v1") return "audio";
  return null;
}

export function editorFor(port: Pick<Port, "type_id" | "transport">): InputEditor {
  if (port.type_id === "text.prompt.v1" && port.transport !== "file") return "prompt";
  if (mediaFamily(port.type_id) && port.transport !== "inline") return "media";
  if (port.type_id === "media.asset.v1") return "asset";
  if (port.type_id === "h3.materials.v1" && port.transport !== "file") return "materials";
  return "generic";
}

/** 上傳時的 <input accept>。 */
export function acceptOf(family: MediaFamily | "any"): string {
  if (family === "any") return "image/*,video/*,audio/*";
  return `${family}/*`;
}

/** 檔案 MIME 與輸入型別家族不符時的提醒（伺服器或元件可能拒絕）；相符時 null。 */
export function familyMismatch(family: MediaFamily, mediaType: string): string | null {
  const major = (mediaType.split(";")[0] ?? "").trim().toLowerCase().split("/")[0];
  return major === family ? null : t("檔案型別 {value} 不是 {family}/*", { value: mediaType || t("未知"), family });
}

export interface InferenceDraft {
  /** 一般輸入（prompt、媒體、Asset、JSON）。 */
  inputs: Record<string, WireTypedValue | null>;
  /** h3.materials.v1 輸入的素材清單（送出時轉成值）。 */
  materials: Record<string, MaterialDraft[]>;
  label: string;
}

export const EMPTY_DRAFT: InferenceDraft = { inputs: {}, materials: {}, label: "" };

/** 草稿 → run 輸入：空的素材清單與空值都不送（選填輸入保持未提供）。 */
export function runInputs(ports: readonly Port[], draft: InferenceDraft): Record<string, WireTypedValue> {
  const out: Record<string, WireTypedValue> = {};
  for (const port of ports) {
    if (editorFor(port) === "materials") {
      const list = draft.materials[port.name] ?? [];
      if (list.length > 0) out[port.name] = { type_id: port.type_id, value: materialsValue(list) };
      continue;
    }
    const value = draft.inputs[port.name];
    if (value) out[port.name] = value;
  }
  return out;
}

/** 送出前要擋下的問題：必填、型別、transport（與 Node 的 validate_run_inputs 一致）＋素材限制＋空白 prompt。 */
export function draftIssues(ports: readonly Port[], draft: InferenceDraft): string[] {
  const inputs = runInputs(ports, draft);
  const problems: string[] = [];
  for (const port of ports) {
    const value = inputs[port.name];
    const editor = editorFor(port);
    if (!value) {
      if (port.required) problems.push(editor === "materials" ? t("缺少必填的參考素材 {name}", { name: port.name }) : t("缺少必填輸入 {name}（{type_id}）", { name: port.name, type_id: port.type_id }));
      continue;
    }
    if (value.type_id !== port.type_id) problems.push(t("{name} 需要 {type_id}，目前是 {type_id2}", { name: port.name, type_id: port.type_id, type_id2: value.type_id }));
    if (port.transport === "file" && !("file" in value)) problems.push(t("{name} 需要檔案（FileRef）", { name: port.name }));
    if (port.transport === "inline" && "file" in value) problems.push(t("{name} 需要 inline 內容", { name: port.name }));
    if (editor === "prompt" && "value" in value && typeof value.value === "string" && value.value.trim() === "") {
      problems.push(t("{name} 是空白的", { name: port.name }));
    }
    if (editor === "materials") problems.push(...materialIssues(draft.materials[port.name] ?? []).map((message) => t("{name}：{message}", { name: port.name, message })));
  }
  return problems;
}

/** 「建立 run」不能按的原因：接線錯誤、上傳中（草稿還是舊值或不完整）、草稿問題；null＝可以送出。 */
export function submitBlockReason(state: { wiringErrors: number; uploading: number; problems: readonly string[] }): string | null {
  if (state.wiringErrors > 0) return t("接線有 {wiringErrors} 個錯誤（見上方）", { wiringErrors: state.wiringErrors });
  if (state.uploading > 0) return t("上傳中：完成後才能建立 run");
  return state.problems[0] ?? null;
}

/** 草稿有沒有任何內容（決定「清除」是否可用）。 */
export function draftHasContent(draft: InferenceDraft): boolean {
  return draft.label.trim() !== "" || Object.values(draft.inputs).some(Boolean) || Object.values(draft.materials).some((list) => list.length > 0);
}

export interface AssetCandidate {
  key: string;
  asset: Asset;
  runId: string;
  runLabel: string;
  where: string;
  createdAt: string;
}

/** 近期 run 的輸出（含各步驟）中的 Asset（實測的幀數、fps、畫幅）；依 asset_id 去重、保留 run 的順序（新到舊）。 */
export function assetCandidates(runs: readonly WireRun[]): AssetCandidate[] {
  const seen = new Set<string>();
  const out: AssetCandidate[] = [];
  const add = (run: WireRun, where: string, value: WireTypedValue) => {
    if (value.type_id !== "media.asset.v1" || !("value" in value)) return;
    const asset = asAsset(value.value);
    if (!asset || seen.has(asset.asset_id)) return;
    seen.add(asset.asset_id);
    out.push({ key: asset.asset_id, asset, runId: run.run_id, runLabel: runDisplayName(run), where, createdAt: run.created_at });
  };
  for (const run of runs) {
    for (const [name, value] of Object.entries(asTypedValueMap(run.outputs))) add(run, t("輸出 {name}", { name }), value);
    for (const step of runSteps(run)) for (const [port, value] of Object.entries(step.outputs)) add(run, `${step.step_id}.${port}`, value);
  }
  return out;
}
