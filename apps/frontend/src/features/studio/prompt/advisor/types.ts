// 「Prompt 修正與建議」的型別（純資料）：分析輸入、發現（finding）、修正與改寫動作。
// 修正與改寫動作都是純函式 apply(text) → text：只在使用者按下時由呼叫端套用（面板先預覽差異；工具列浮層的一鍵修正
// 留下可以復原的提示），這個模組從不自動改字。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import type { PromptRules } from "../../model/providerTraits";
import { t } from "@/i18n";

/** 鏡頭的 H3 任務（= 運算路由的 capability）。Studio 的 fl2va 有首幀：前一鏡最後一格或素材庫圖片（官方 I2VA 寫法）。 */
export type PromptMode = "t2va" | "fl2va" | "ref2va";

/** error：幾乎確定送錯或與設定矛盾；warning：偏離官方格式或程式行為；suggestion：製作建議；info：背景說明。 */
export type Severity = "error" | "warning" | "suggestion" | "info";

/** official：官方文件明文；code：已安裝程式的行為；guide：指南的製作建議（未經生成驗證）。 */
export type Basis = "official" | "code" | "guide";

export interface TextRange {
  /** 在 prompt 原文中的 [start, end)（UTF-16 位置，與 textarea 的選取位置相同）。 */
  start: number;
  end: number;
}

export interface FindingFix {
  /** 按鈕與預覽標題（繁中，描述會改什麼）。 */
  label: string;
  /** 純函式：從「目前」的全文重新找出問題再修正；對已修正的文字再套用一次結果不變。 */
  apply: (text: string) => string;
}

export interface Finding {
  /** 規則 id（例如 timeline.first-shot-time）；同一條規則可以有多個發現。 */
  id: string;
  severity: Severity;
  /** 一行：這份 prompt 哪裡有問題（白話，用畫面上看得到的東西命名，不引用文件）。 */
  title: string;
  /** 第一句說要怎麼做（工具列的浮層只顯示這一句），之後是原因；出處一律放在 source。 */
  detail: string;
  basis: Basis;
  /** 依據的出處（短）：官方文件章節、程式檔案或指南段落；只在「完整說明與依據」裡出現。 */
  source?: string;
  range?: TextRange;
  /** 真的修正：套用後這個問題就解決了。工具列的浮層一鍵套用，面板先預覽。 */
  fix?: FindingFix;
  /** 不是修正、而是一個改寫動作：會留下要使用者填的空段（例如改成完整格式）。只在面板裡預覽後套用。 */
  action?: FindingFix;
}

export interface AnalyzeInput {
  /** 鏡頭 prompt 原文（可含 @Image1／@Video1／@Audio1）。 */
  text: string;
  /** 任務；undefined／null＝未知（運算路由沒有提供 capability），只做與任務無關的檢查。 */
  mode?: PromptMode | null;
  /** 鏡頭影格數（24 fps，對齊前後皆可）；0 或負值＝未知。 */
  frames: number;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  /** 有首幀（I2VA）；省略時 fl2va 視為有首幀。 */
  firstFrame?: boolean;
  /** 路線的 prompt 與長度規則（model/promptRules.ts）；省略時用 H3 的規則。不是 H3 的路線只做與模型無關的檢查。 */
  rules?: PromptRules;
}

export const SEVERITY_ORDER: readonly Severity[] = ["error", "warning", "suggestion", "info"];

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: t("錯誤"),
  warning: t("警告"),
  suggestion: t("建議"),
  info: t("資訊"),
};

export const BASIS_LABEL: Record<Basis, string> = {
  official: t("官方寫法"),
  code: t("實際行為"),
  guide: t("製作建議"),
};

export const BASIS_DESCRIPTION: Record<Basis, string> = {
  official: t("MiniMax 官方的 prompt 寫作指南與 API 文件寫明的規則"),
  code: t("這台機器上的生成程式與 Studio 實際怎麼處理 prompt"),
  guide: t("Phasyn Studio 寫作指南的製作建議，還沒有用生成結果驗證"),
};

/** 生成方式的白話名稱（與鏡頭生成列的「方式」同一組詞）。 */
export const MODE_LABEL: Record<PromptMode, string> = {
  t2va: t("只用文字"),
  fl2va: t("首幀"),
  ref2va: t("參考素材"),
};

/** 官方的任務名稱：只放在提示文字裡。 */
export const MODE_OFFICIAL: Record<PromptMode, string> = {
  t2va: "T2VA",
  fl2va: "I2VA",
  ref2va: "Ref2VA",
};
