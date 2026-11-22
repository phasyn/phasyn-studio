// 「套用到 Image Studio」（純函式）：把候選 prompt 與生成設定寫成 Studio 專案裡一個新的圖片鏡頭（契約 StudioImageShot）。
// 只新增、不改既有鏡頭；文生圖、沒有參考圖與遮罩；不會自動生成（takes 為空）。
import type { StudioImageShot, StudioProject } from "@/api/generated/contracts";
import type { PromptCandidate, PromptVariant, GenerationSettings } from "../types";
import { localId } from "./study";
import { t } from "@/i18n";

export type ImageSeedMode = StudioImageShot["seed_mode"];

/** 寫入時需要的專案形狀：既有的圖片鏡頭原樣保留。 */
export type ProjectShots = Pick<StudioProject, "title" | "image_shots">;

export const MAX_IMAGE_SHOTS = 500;
export const DEFAULT_REFERENCE_RESOLUTION = 1024;

export interface ApplyInput {
  studyTitle: string;
  versionLabel: string;
  variant: PromptVariant;
  candidate: PromptCandidate;
  settings: GenerationSettings;
  /** -1＝每次生成隨機（seed_mode random）。 */
  seed: number;
  seedMode: ImageSeedMode;
  title: string;
}

export function imageShotFromCandidate(input: ApplyInput, id = localId("is")): StudioImageShot {
  const random = input.seed < 0 || input.seedMode === "random";
  return {
    image_shot_id: id,
    title: input.title.trim() || t("{studyTitle}・{versionLabel} {variant}", { studyTitle: input.studyTitle, versionLabel: input.versionLabel, variant: input.variant }),
    mode: "t2i",
    prompt: input.candidate.prompt,
    // guidance ≤ 1 不使用負面提示詞；照實帶過去，由 Image Studio 依同一規則處理
    negative_prompt: input.settings.negative_prompt,
    width: input.settings.width,
    height: input.settings.height,
    seed: random ? -1 : input.seed,
    seed_mode: random ? "random" : input.seedMode,
    batch: 1,
    steps: input.settings.steps,
    guidance: input.settings.guidance,
    sigma_schedule: input.settings.sigma_schedule,
    flow_shift_mu: input.settings.flow_shift_mu,
    route: input.settings.route,
    references: [],
    base_index: null,
    reference_resolution: DEFAULT_REFERENCE_RESOLUTION,
    mask_item_id: null,
    mask_invert: false,
    decode: input.settings.decode,
    preview: { mode: input.settings.preview.mode, every: input.settings.preview.every },
    takes: [],
    active_take_id: null,
    note: t("來自圖片反推「{studyTitle}」{versionLabel} {variant}", { studyTitle: input.studyTitle, versionLabel: input.versionLabel, variant: input.variant }),
  };
}

/** 確認框列出的內容（會寫進專案的欄位）。 */
export function applySummary(shot: StudioImageShot, projectTitle: string): string[] {
  return [
    t("專案「{projectTitle}」新增圖片鏡頭「{title}」（文生圖；不改既有鏡頭）", { projectTitle, title: shot.title }),
    t("prompt：{promptCount} 字{value}", { promptCount: shot.prompt.length, value: shot.negative_prompt.trim() ? t("；負面提示詞 {negative_promptCount} 字{value}", { negative_promptCount: shot.negative_prompt.length, value: shot.guidance > 1 ? "" : t("（guidance ≤ 1 時不使用）") }) : "" }),
    t("{width}×{height} · {steps} 步 · guidance {guidance} · sigma {sigma_schedule} · μ {value} · 解碼 {decode}", { width: shot.width, height: shot.height, steps: shot.steps, guidance: shot.guidance, sigma_schedule: shot.sigma_schedule, value: shot.flow_shift_mu ?? t("自動"), decode: shot.decode }),
    t("seed：{value} · 張數 1", { value: shot.seed_mode === "random" ? t("每次隨機（實際值生成時記錄）") : t("{seed}（{value}）", { seed: shot.seed, value: shot.seed_mode === "fixed" ? t("固定") : t("遞增") }) }),
    t("元件組合：{value}", { value: shot.route || t("（未選擇）") }),
    t("不會自動生成；到 Image Studio 確認後再按生成"),
  ];
}

/** 套用前的檢查；可以時為 null。 */
export function applyBlockReason(project: ProjectShots | null, shot: StudioImageShot): string | null {
  if (!project) return t("請選擇要寫入的 Studio 專案");
  if ((project.image_shots?.length ?? 0) >= MAX_IMAGE_SHOTS) return t("專案的圖片鏡頭已達上限 {maxImageShots} 個", { maxImageShots: MAX_IMAGE_SHOTS });
  if (!shot.prompt.trim()) return t("候選 prompt 是空的");
  if (!shot.route) return t("請先在生成設定選擇元件組合（t2i）");
  return null;
}

/** 在專案最後加上新的圖片鏡頭（其他欄位與既有鏡頭原樣保留；revision 與內容由伺服器依契約檢查）。 */
export function withImageShot<P extends ProjectShots>(project: P, shot: StudioImageShot): P {
  return { ...project, image_shots: [...(project.image_shots ?? []), shot] };
}
