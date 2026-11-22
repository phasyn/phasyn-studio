// The asset library's filter and sort vocabulary, shared by the library dialog and the import dialog.
import { AudioLines, Film, Image as ImageIcon, Library, Link2, Unlink, type LucideIcon } from "lucide-react";
import type { LibraryKindFilter, LibrarySortKey, LibraryUsageFilter } from "../../model/library";
import { t } from "@/i18n";

export interface KindFilterEntry {
  id: LibraryKindFilter;
  /** The library's category list (全部素材). */
  label: string;
  /** A compact segmented control (the import dialog's 全部). */
  short: string;
  icon: LucideIcon;
}

export const KIND_FILTERS: readonly KindFilterEntry[] = [
  { id: "all", label: t("全部素材"), short: t("全部"), icon: Library },
  { id: "image", label: t("圖片"), short: t("圖片"), icon: ImageIcon },
  { id: "video", label: t("影片"), short: t("影片"), icon: Film },
  { id: "audio", label: t("聲音"), short: t("聲音"), icon: AudioLines },
];

export const USAGE_FILTERS: readonly { id: LibraryUsageFilter; label: string; icon: LucideIcon }[] = [
  { id: "all", label: t("不限"), icon: Library },
  { id: "used", label: t("使用中"), icon: Link2 },
  { id: "unused", label: t("沒有使用"), icon: Unlink },
];

export const SORT_LABEL: Record<LibrarySortKey, string> = { name: t("名稱"), created: t("加入時間"), size: t("大小"), duration: t("長度") };
/** 渲染成品沒有「加入」：建立時間。 */
export const RENDER_SORT_LABEL: Record<LibrarySortKey, string> = { ...SORT_LABEL, created: t("建立時間") };
