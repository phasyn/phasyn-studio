// 跨頁連結集中在這裡（路徑本身由 @/app/paths 產生）。
import { componentPath, recordingPath } from "@/app/paths";

/** 元件頁並選取該 instance（「從此 recording 複製設定」只開啟頁面；不重播指令、不自動套用或執行）。 */
export function componentsHref(nodeId: string, componentId: string): string {
  return componentPath(nodeId, componentId);
}

export function recordingHref(recordingId: string): string {
  return recordingPath(recordingId);
}
