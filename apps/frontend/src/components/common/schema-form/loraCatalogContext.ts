import { createContext } from "react";
import type { LoraCatalogEntry } from "./loraStackModel";

/** 元件編輯器提供給 LoRA 串接欄位的目錄（provider describe 的 facts.lora_catalog）與草稿目前的 variant。 */
export interface LoraCatalogValue {
  entries: readonly LoraCatalogEntry[];
  variant: string | null;
}

export const LoraCatalogContext = createContext<LoraCatalogValue>({ entries: [], variant: null });
