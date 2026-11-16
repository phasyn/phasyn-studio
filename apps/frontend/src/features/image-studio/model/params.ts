// take 的 params_snapshot：送出當下實際使用的參數（實際 seed、送出的參考圖與遮罩檔、預覽設定、這張圖在 run 中的輸出名稱）。
// 用途：「載入這組參數」、設定是否已變更、比較兩個 take。純函式；讀舊資料時缺欄位就是 null／不比較，不猜值。
import type { FileRef } from "@/api/generated/contracts";
import { isFileRef } from "@/api/types";
import { isRecord } from "@/lib/json";
import type { DecodeMode, ImageLibraryItem, ImageMode, PreviewMode, SeedMode, SigmaSchedule, StudioImageShot, StudioImageTake } from "../types";
import { RANDOM_SEED } from "./constants";
import { orderedReferences } from "./references";
import { cfgEnabled, type ImageShotPatch } from "./shots";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface SnapshotReference {
  item_id: string;
  order: number;
  file: FileRef | null;
}

export interface ImageParamsSnapshot {
  v: 1;
  mode: ImageMode;
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  /** 這張圖實際的 seed。 */
  seed: number;
  /** 送出時圖片設定的 seed（-1＝每張隨機）。 */
  requested_seed: number;
  seed_mode: SeedMode;
  batch: number;
  /** 這張圖在批次中的位置（0 起）。 */
  batch_index: number;
  steps: number;
  guidance: number;
  sigma_schedule: SigmaSchedule;
  flow_shift_mu: number | null;
  route: string;
  /** 實際送出的參考圖（文生圖為空）。 */
  references: SnapshotReference[];
  /** 實際送出的底圖索引（沒有遮罩時不需要底圖＝null）。 */
  base_index: number | null;
  reference_resolution: number;
  mask_item_id: string | null;
  mask_file: FileRef | null;
  mask_invert: boolean;
  decode: DecodeMode;
  preview: { mode: PreviewMode; every: number };
  /** 這張圖在 run 中的輸出名稱（image／image_0…）。 */
  outputs: { image: string; image_white: string | null };
  /** 完成後是否自動把白底版加入專案素材庫（送出當下的選擇）。 */
  auto_library: boolean;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** 讀回 params_snapshot；必要欄位缺少或型別不符時 null（舊資料或別人寫的資料）。 */
export function parseSnapshot(raw: unknown): ImageParamsSnapshot | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  const mode = oneOf(raw.mode, ["t2i", "i2i"] as const);
  const seedMode = oneOf(raw.seed_mode, ["fixed", "increment", "random"] as const);
  const sigma = oneOf(raw.sigma_schedule, ["native", "karras", "exponential"] as const);
  const decode = oneOf(raw.decode, ["full", "tiled"] as const);
  const preview = isRecord(raw.preview) ? raw.preview : null;
  const previewMode = preview ? oneOf(preview.mode, ["off", "vae_thumbnail", "linear_fit"] as const) : null;
  const outputs = isRecord(raw.outputs) ? raw.outputs : null;
  const imageOutput = outputs ? str(outputs.image) : null;
  const fields = [num(raw.width), num(raw.height), num(raw.seed), num(raw.requested_seed), num(raw.batch), num(raw.batch_index), num(raw.steps), num(raw.guidance), num(raw.reference_resolution)];
  if (!mode || !seedMode || !sigma || !decode || !previewMode || !imageOutput || fields.some((value) => value === null)) return null;
  const [width, height, seed, requestedSeed, batch, batchIndex, steps, guidance, referenceResolution] = fields as number[];
  const references = Array.isArray(raw.references)
    ? raw.references.flatMap((item): SnapshotReference[] => {
        if (!isRecord(item) || typeof item.item_id !== "string" || num(item.order) === null) return [];
        return [{ item_id: item.item_id, order: num(item.order) ?? 0, file: isFileRef(item.file) ? item.file : null }];
      })
    : [];
  return {
    v: 1,
    mode,
    prompt: str(raw.prompt) ?? "",
    negative_prompt: str(raw.negative_prompt) ?? "",
    width: width ?? 0,
    height: height ?? 0,
    seed: seed ?? 0,
    requested_seed: requestedSeed ?? RANDOM_SEED,
    seed_mode: seedMode,
    batch: batch ?? 1,
    batch_index: batchIndex ?? 0,
    steps: steps ?? 0,
    guidance: guidance ?? 0,
    sigma_schedule: sigma,
    flow_shift_mu: num(raw.flow_shift_mu),
    route: str(raw.route) ?? "",
    references,
    base_index: num(raw.base_index),
    reference_resolution: referenceResolution ?? 0,
    mask_item_id: str(raw.mask_item_id),
    mask_file: isFileRef(raw.mask_file) ? raw.mask_file : null,
    mask_invert: raw.mask_invert === true,
    decode,
    preview: { mode: previewMode, every: num(preview?.every) ?? 1 },
    outputs: { image: imageOutput, image_white: outputs ? str(outputs.image_white) : null },
    auto_library: raw.auto_library === true,
  };
}

export function takeSnapshot(take: Pick<StudioImageTake, "params_snapshot">): ImageParamsSnapshot | null {
  return parseSnapshot(take.params_snapshot);
}

/** 與送出時比較，列出已改變的設定（簡短標籤）；snapshot 讀不出來時回傳 ["參數紀錄"]（無法確認＝當成已變更）。 */
export function changedSinceTake(take: Pick<StudioImageTake, "params_snapshot">, shot: StudioImageShot): string[] {
  const snap = takeSnapshot(take);
  if (!snap) return [t("參數紀錄")];
  const out: string[] = [];
  if (snap.mode !== shot.mode) out.push(t("模式"));
  if (snap.prompt !== shot.prompt) out.push("prompt");
  if ((cfgEnabled(snap.guidance) || cfgEnabled(shot.guidance)) && snap.negative_prompt !== shot.negative_prompt) out.push(t("負面提示詞"));
  if (snap.width !== shot.width || snap.height !== shot.height) out.push(t("尺寸"));
  if (shot.seed !== RANDOM_SEED && snap.requested_seed !== shot.seed) out.push("seed");
  if (snap.steps !== shot.steps) out.push(t("步數"));
  if (snap.guidance !== shot.guidance) out.push("guidance");
  if (snap.sigma_schedule !== shot.sigma_schedule) out.push(t("sigma 排程"));
  if (snap.flow_shift_mu !== shot.flow_shift_mu) out.push("flow shift");
  if (snap.route !== shot.route) out.push(t("運算路由"));
  if (snap.decode !== shot.decode) out.push(t("解碼方式"));
  if (shot.mode === "i2i") {
    const sent = snap.references.map((ref) => ref.item_id).join("|");
    const current = orderedReferences(shot.references).map((ref) => ref.item_id).join("|");
    if (sent !== current) out.push(t("參考圖片"));
    if (snap.reference_resolution !== shot.reference_resolution) out.push(t("參考解析度"));
    if ((snap.mask_item_id ?? null) !== shot.mask_item_id || (shot.mask_item_id !== null && snap.mask_invert !== shot.mask_invert)) out.push(t("遮罩"));
    if (shot.mask_item_id !== null && snap.base_index !== shot.base_index) out.push(t("底圖"));
  }
  return out;
}

/**
 * 「載入這組參數」：把 take 送出時的參數套回圖片（實際 seed、固定 seed、生成 1 張）。素材庫裡已不存在的參考圖或遮罩
 * 不會套用，原因放在 warnings。snapshot 讀不出來時回傳 null。
 */
export function loadParamsPatch(take: Pick<StudioImageTake, "params_snapshot" | "seed">, library: readonly ImageLibraryItem[]): { patch: ImageShotPatch; warnings: string[] } | null {
  const snap = takeSnapshot(take);
  if (!snap) return null;
  const items = new Set(library.filter((item) => item.kind === "image").map((item) => item.item_id));
  const warnings: string[] = [];
  const kept = snap.references.filter((ref) => items.has(ref.item_id));
  if (kept.length < snap.references.length) warnings.push(t("{referencesCount} 張參考圖片已不在專案素材庫，沒有套用", { referencesCount: snap.references.length - kept.length }));
  const references = kept.map((ref, order) => ({ item_id: ref.item_id, order }));
  const baseItem = snap.base_index === null ? null : (snap.references[snap.base_index]?.item_id ?? null);
  const baseIndex = baseItem === null ? null : references.findIndex((ref) => ref.item_id === baseItem);
  const maskKept = snap.mask_item_id !== null && items.has(snap.mask_item_id);
  if (snap.mask_item_id !== null && !maskKept) warnings.push(t("遮罩檔案已不在專案素材庫，沒有套用"));
  const patch: ImageShotPatch = {
    mode: snap.mode,
    prompt: snap.prompt,
    negative_prompt: snap.negative_prompt,
    width: snap.width,
    height: snap.height,
    seed: take.seed,
    seed_mode: "fixed",
    batch: 1,
    steps: snap.steps,
    guidance: snap.guidance,
    sigma_schedule: snap.sigma_schedule,
    flow_shift_mu: snap.flow_shift_mu,
    route: snap.route,
    reference_resolution: snap.reference_resolution,
    decode: snap.decode,
    preview: { ...snap.preview },
  };
  // 文生圖的 take 沒有送出參考圖：圖片上現有的參考與遮罩保留不動
  if (snap.mode === "i2i") {
    patch.references = references;
    patch.base_index = baseIndex === null || baseIndex < 0 ? (references.length > 0 && maskKept ? 0 : null) : baseIndex;
    patch.mask_item_id = maskKept ? snap.mask_item_id : null;
    patch.mask_invert = maskKept ? snap.mask_invert : false;
  }
  return { patch, warnings };
}

/** 兩個 take 的參數差異（比較用）：[標籤, A 值, B 值]。 */
export function snapshotDiff(a: ImageParamsSnapshot, b: ImageParamsSnapshot): [string, string, string][] {
  const rows: [string, string, string][] = [];
  const add = (label: string, left: string | number | null, right: string | number | null) => {
    const l = left === null ? "—" : String(left);
    const r = right === null ? "—" : String(right);
    if (l !== r) rows.push([label, l, r]);
  };
  add("seed", a.seed, b.seed);
  add(t("尺寸"), `${a.width}×${a.height}`, `${b.width}×${b.height}`);
  add(t("步數"), a.steps, b.steps);
  add("guidance", a.guidance, b.guidance);
  add(t("sigma 排程"), a.sigma_schedule, b.sigma_schedule);
  add("flow shift μ", a.flow_shift_mu ?? t("自動"), b.flow_shift_mu ?? t("自動"));
  add(t("運算路由"), a.route, b.route);
  add(t("解碼"), a.decode, b.decode);
  add(t("模式"), a.mode, b.mode);
  add("prompt", a.prompt, b.prompt);
  add(t("負面提示詞"), a.negative_prompt, b.negative_prompt);
  add(t("參考圖片"), formatList(a.references.map((ref) => ref.item_id)), formatList(b.references.map((ref) => ref.item_id)));
  add(t("遮罩"), a.mask_item_id, b.mask_item_id);
  return rows;
}
