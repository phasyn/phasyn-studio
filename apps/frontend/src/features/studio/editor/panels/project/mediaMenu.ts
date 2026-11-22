// The actions of one item of the Project panel (its "⋯" menu, the same on right click): open it in the Source
// monitor, create or recreate its playback proxy, show it in the asset library, and apply a shorter take that waits.
// An action that cannot run stays in the menu with its reason.
import { Gauge, Library, MonitorPlay, Scissors } from "lucide-react";
import type { TimelineSource } from "@/api/generated/contracts";
import type { MenuItem } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { openAssetLibrary } from "../../../components/library/libraryOpen";
import type { Editor } from "../../editorContext";
import { proxyState, type MediaItem } from "./media";

/** What applying a shorter take does, for the tooltip of its button (a confirmation follows the press). */
export const APPLY_SHORTER_HINT = t("改用這個鏡頭較短的新 take：超出新素材的片段會裁短，後面的片段往前接上，剪輯歷程重新開始；按下後會先確認");

/** Why no proxy can be made of this source now; null when one can. */
export function proxyBlocked(editor: Pick<Editor, "busy">, source: TimelineSource): string | null {
  if (editor.busy) return t("請等目前的渲染或匯出完成");
  // A proxy run (RunRequest.purpose = proxy) takes no run slot, so it does not wait for one
  if (!source.file || source.kind !== "video" || source.width < 2 || source.height < 2) return t("請先選取已完成且尺寸已知的影片素材");
  return proxyState(source) === "building" ? t("代理媒體正在建立") : null;
}

/** Starts the proxy run of a source. The run's answer is written to the timeline's source, so the source joins the timeline first. */
export function createProxy(editor: Editor, source: TimelineSource): void {
  const { timeline } = editor;
  const bound = timeline.sources.some((item) => item.source_id === source.source_id);
  const next = bound ? timeline : { ...timeline, sources: [...timeline.sources, source] };
  if (editor.commit(next)) void editor.createProxy(next, source);
}

export interface MediaMenuActions {
  /** Load the item into the Source monitor. */
  open: () => void;
  /** Apply the shorter take that waits. */
  applyShorter: () => void;
}

export function mediaMenu(editor: Editor, item: MediaItem, actions: MediaMenuActions): MenuItem[] {
  const { source } = item;
  const libraryId = source.library_id;
  return [
    { id: "open", label: t("在來源監看器開啟"), icon: MonitorPlay, shortcut: "Enter", onSelect: actions.open },
    {
      id: "proxy",
      label: item.proxy === "ready" ? t("重新建立代理") : t("建立代理"),
      icon: Gauge,
      separatorBefore: true,
      disabledReason: proxyBlocked(editor, source),
      onSelect: () => { createProxy(editor, source); },
    },
    {
      id: "library",
      label: t("在素材庫顯示"),
      icon: Library,
      disabledReason: (libraryId != null && libraryId !== "") ? null : t("素材庫只能定位上傳的素材；鏡頭的 take 在素材庫的「渲染結果」"),
      onSelect: () => { openAssetLibrary(libraryId ?? null); },
    },
    ...(item.shorter ? [{ id: "shorter", label: t("套用並裁短…"), icon: Scissors, separatorBefore: true, onSelect: actions.applyShorter }] : []),
  ];
}
