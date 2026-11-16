// 插件程式碼的權限（manifest.permissions）在介面上的說法。權限限制的是包裡的程式碼能要求主程式做什麼，不是人：
// API 仍然沒有驗證。這個版本不執行任何插件程式碼，權限只供檢視（含程式碼的包狀態是「不相容」）。
import type { LucideIcon } from "lucide-react";
import { Clapperboard, Cpu, Database, FileUp, Film, FolderPen, FolderSearch, Images, ListVideo, ShieldQuestion } from "lucide-react";
import { t } from "@/i18n";

export interface PermissionInfo {
  name: string;
  /** 介面上的說法。 */
  label: string;
  /** 補充（範圍或每次都要確認）；沒有時為 null。 */
  note: string | null;
  icon: LucideIcon;
  /** 這個版本認得的權限；不認得或保留的權限讓整個包不相容。 */
  known: boolean;
}

interface PermissionSpec {
  label: () => string;
  note?: () => string;
  icon: LucideIcon;
}

const CONFIRM_EACH_TIME = () => t("每次都由主程式跳出確認並列出範圍");

const PERMISSIONS: Readonly<Record<string, PermissionSpec>> = {
  "project:read": { label: () => t("讀取目前專案的鏡頭、Prompt、設定與時間軸"), note: () => t("不含媒體內容與其他專案"), icon: FolderSearch },
  "project:write": { label: () => t("修改鏡頭與專案設定"), note: () => t("每次修改都能復原"), icon: FolderPen },
  "timeline:write": { label: () => t("修改時間軸"), note: () => t("進入剪輯的復原紀錄"), icon: ListVideo },
  "media:read": { label: () => t("讀取專案媒體的畫面與聲音"), icon: Images },
  "media:write": { label: () => t("把新檔案加入專案素材庫"), note: () => t("有大小上限"), icon: FileUp },
  "render:start": { label: () => t("要求渲染"), note: CONFIRM_EACH_TIME, icon: Clapperboard },
  "export:start": { label: () => t("要求匯出"), note: CONFIRM_EACH_TIME, icon: Film },
  "engine:read": { label: () => t("讀取元件組合與節點狀態"), note: () => t("含主機與 GPU 名稱"), icon: Cpu },
  storage: { label: () => t("保存插件自己的設定"), icon: Database },
};

/** 一個權限名稱在介面上的說法（不認得的名稱照原樣顯示並標示）。 */
export function permissionInfo(name: string): PermissionInfo {
  const spec = PERMISSIONS[name];
  if (!spec) return { name, label: t("這個版本不認得的權限"), note: null, icon: ShieldQuestion, known: false };
  return { name, label: spec.label(), note: spec.note?.() ?? null, icon: spec.icon, known: true };
}
