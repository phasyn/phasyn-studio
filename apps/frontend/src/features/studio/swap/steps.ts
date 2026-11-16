// 換角精靈的步驟名稱與圖示（步驟清單、底部提示、建立前的待處理清單共用）。
import { FileVideo, ScanSearch, Settings2, SplitSquareHorizontal, UsersRound, type LucideIcon } from "lucide-react";
import type { StepId } from "./draft";
import { t } from "@/i18n";

export const STEP_LABELS: Record<StepId, string> = { source: t("來源影片"), characters: t("角色"), cuts: t("切鏡偵測"), plan: t("分段計畫"), output: t("輸出與建立") };
export const STEP_ICONS: Record<StepId, LucideIcon> = { source: FileVideo, characters: UsersRound, cuts: ScanSearch, plan: SplitSquareHorizontal, output: Settings2 };
