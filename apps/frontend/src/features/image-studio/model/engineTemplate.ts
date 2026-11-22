// 用範本建立生圖引擎的規劃（純函式）：依圖片模式選元件組合頁的內建範本（文生圖 t2i／圖生圖 i2i），每一步列出這台主控
// 上可以用的元件（第一個是預設：就緒的優先，與元件組合頁的範本對話框相同），再依選好的元件接成元件組合，確認它是
// Image Studio 這個模式可以用的圖片元件組合（接線、參數與輸出都由範本決定；不寫死任何主機）。不送出任何請求。
import type { Catalog } from "@/api/generated/contracts";
import { componentUsable, indexCatalog } from "@/api/catalog";
import type { WirePipeline } from "@/api/types";
import { buildFromTemplate, makeLookup, slotCandidates, templateById, validatePipeline, type ComponentOption } from "@/features/pipelines";
import { uniqueName } from "@/lib/ids";
import type { ImageMode } from "../types";
import { ROLE_LABELS, type ImageStepRole } from "./constants";
import { supportsImageMode, deriveImageRoute } from "./routes";
import { t } from "@/i18n";

export type EngineTemplate = ReturnType<typeof templateById>;
type TemplateSlot = EngineTemplate["slots"][number];

/** 範本的步驟 → Image Studio 的角色（畫面上用角色名稱，不寫元件類型的 id）。 */
const SLOT_ROLES: Partial<Record<string, ImageStepRole>> = { prepare: "prepare", te: "te", venc: "venc", dit: "dit", vae: "decode", compose: "compose" };

export function engineTemplate(mode: ImageMode): EngineTemplate {
  return templateById(mode === "i2i" ? "i2i" : "t2i");
}

export function slotRoleName(slot: TemplateSlot): string {
  const role = SLOT_ROLES[slot.id];
  return role ? ROLE_LABELS[role] : slot.id;
}

/** 元件能用（就緒、呼叫中，或用到時自動載入，而且 Node 在線上）。 */
export function optionUsable(option: ComponentOption): boolean {
  return !option.node.stale && componentUsable(option.descriptor);
}

export interface SlotChoice {
  slot: TemplateSlot;
  candidates: ComponentOption[];
  /** 使用者選的，沒選時是第一個候選；這台主控沒有可用的元件時 null。 */
  chosen: ComponentOption | null;
}

/** 範本每一步的候選與目前的選擇（choices：步驟 id → 選項值）。 */
export function slotChoices(spec: EngineTemplate, options: readonly ComponentOption[], choices: Readonly<Record<string, string>>): SlotChoice[] {
  return spec.slots.map((slot) => {
    const candidates = slotCandidates(options, slot.kinds, slot.outputType, slot.variant);
    return { slot, candidates, chosen: candidates.find((option) => option.value === choices[slot.id]) ?? candidates[0] ?? null };
  });
}

export interface EnginePlan {
  pipeline: WirePipeline | null;
  /** 不能建立的原因；null＝可以建立。 */
  problem: string | null;
  /** 接線或檢查沒通過的細節（提示用）。 */
  details: string[];
}

/**
 * 依選好的元件接成元件組合（pipeline_id 取範本的預設，已被用掉時加序號，不覆寫既有的元件組合），並確認它是 Image Studio
 * 這個模式可以用的圖片元件組合。元件沒有就緒不影響建立（之後在「生成引擎」啟動）。
 */
export function planEngine(spec: EngineTemplate, rows: readonly SlotChoice[], taken: ReadonlySet<string>, catalog: Catalog | undefined, mode: ImageMode): EnginePlan {
  const missing = rows.find((row) => row.chosen === null);
  if (missing) return { pipeline: null, problem: t("這台主控沒有可以當「{role}」的元件", { role: slotRoleName(missing.slot) }), details: [] };
  const chosen = rows.flatMap((row) => (row.chosen ? [{ slot: row.slot, descriptor: row.chosen.descriptor }] : []));
  const build = buildFromTemplate(spec, chosen, uniqueName(spec.defaultPipelineId, taken), spec.label);
  const errors = validatePipeline(build.pipeline, makeLookup(catalog)).filter((issue) => issue.severity === "error");
  const route = deriveImageRoute(build.pipeline, indexCatalog(catalog));
  const details = [...build.unresolved, ...errors.map((issue) => issue.message)];
  if (details.length > 0 || !route || !supportsImageMode(route, mode)) {
    return { pipeline: null, problem: t("範本接不起這些元件，沒有建立。可以到元件組合頁用範本手動建立。"), details };
  }
  return { pipeline: build.pipeline, problem: null, details: [] };
}
