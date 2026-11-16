// 顯示用的非元件小工具（.tsx 只匯出元件，Fast Refresh 才能運作）：檔案網址、背景樣式、take 狀態文字。
// 元件類型（qimg.*、image.compose 的圖示與色調）統一在 components/workbench/kinds.ts。
import type { FileRef } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import type { ImageTakeState } from "../types";
import { t } from "@/i18n";

export type Backdrop = "checker" | "white" | "black";

/** 透明區的背景：棋盤格（靜態空間參考，用既有 token）、白底、黑場。 */
export const BACKDROP_CLASS: Record<Backdrop, string> = {
  checker: "bg-sunken bg-[conic-gradient(var(--color-raised)_25%,var(--color-sunken)_0_50%,var(--color-raised)_0_75%,var(--color-sunken)_0)] bg-[length:16px_16px]",
  white: "bg-[#ffffff]",
  black: "bg-stage",
};

export const BACKDROP_LABELS: Record<Backdrop, string> = { checker: t("棋盤格（看透明區）"), white: t("白底"), black: t("黑場") };

export function fileUrl(file: Pick<FileRef, "node_id" | "file_id"> | null | undefined): string | null {
  return file ? mediaUrl(file.node_id, file.file_id) : null;
}

const TAKE_STATE_LABELS: Record<ImageTakeState, string> = { rendering: t("生成中"), succeeded: t("完成"), failed: t("失敗"), cancelled: t("已取消"), interrupted: t("已中斷") };

export function takeStateLabel(state: ImageTakeState): string {
  return TAKE_STATE_LABELS[state];
}

/** 縮圖格目前的欄數（auto-fill 的 grid；方向鍵 ↑↓ 跨一列用）。 */
export function gridColumns(list: HTMLElement | null): number {
  if (!list) return 1;
  return Math.max(1, getComputedStyle(list).gridTemplateColumns.split(" ").filter(Boolean).length);
}

/** 縮圖格的方向鍵：←→ 前後一格、↑↓ 跨一列、Home／End 到頭尾；不是這些鍵時 undefined。 */
export function gridStep(key: string, index: number, columns: number, count: number): number | undefined {
  const next = { ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - columns, ArrowDown: index + columns, Home: 0, End: count - 1 }[key];
  return next === undefined ? undefined : Math.max(0, Math.min(count - 1, next));
}
