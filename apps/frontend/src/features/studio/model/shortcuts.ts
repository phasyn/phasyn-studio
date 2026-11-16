// What the "?" dialog lists: the editor's key map (editor/keymap.ts, the only place a shortcut is defined) grouped
// into tabs, followed by the pointer gestures and the keys of lists, panels and menus that are not commands.
import { t } from "@/i18n";
import type { KeyLike } from "@/lib/keyboard";
import { KEY_BINDINGS, type KeyGroupId } from "../editor/keymap";

/** One row: alternative chords (each a list of keys pressed together; "Mod" = Ctrl or ⌘), what it does and where. */
export interface Shortcut {
  keys: string[][];
  action: string;
  /** Scope or precondition (for example "focus on a shot row"). */
  where?: string;
}

export interface ShortcutGroup {
  /** Stable id (element ids are built from it, never from the translated title). */
  id: string;
  title: string;
  items: Shortcut[];
}

const KEY_GROUP_TITLES: Record<KeyGroupId, string> = {
  playback: t("播放與導覽"),
  marking: t("標記與三點編輯"),
  editing: t("修剪與編輯"),
  tools: t("工具與檢視"),
  general: t("一般"),
};

function keyGroup(id: KeyGroupId, extra: Shortcut[] = []): ShortcutGroup {
  const items = KEY_BINDINGS.filter((binding) => binding.group === id).map((binding): Shortcut => ({ keys: binding.keys, action: binding.label }));
  return { id, title: KEY_GROUP_TITLES[id], items: [...items, ...extra] };
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  keyGroup("playback"),
  keyGroup("marking"),
  keyGroup("editing"),
  keyGroup("tools"),
  keyGroup("general", [
    { keys: [["Mod", "Shift", "P"]], action: t("開啟命令面板"), where: t("每一頁都有效；「編輯」以外也可以按 Ctrl／⌘＋K") },
    { keys: [["?"]], action: t("開啟這份快速鍵說明"), where: t("焦點不在文字欄位時") },
  ]),
  {
    id: "pointer",
    title: t("滑鼠與拖曳"),
    items: [
      { keys: [[t("拖曳")]], action: t("依目前的工具移動、修剪、外滑或內滑片段"), where: t("時間軸的片段") },
      { keys: [["Alt", t("拖曳")]], action: t("拖曳時暫時不靠齊"), where: t("時間軸的片段") },
      { keys: [["Shift", t("點按")]], action: t("加入或移出選取範圍"), where: t("時間軸的片段") },
      { keys: [[t("右鍵")], ["Shift", "F10"]], action: t("開啟片段、轉場、軌道或時間尺的選單"), where: t("時間軸") },
      { keys: [["Mod", t("滾輪")], ["Alt", t("滾輪")]], action: t("以指標為中心縮放時間軸"), where: t("指標在時間軸") },
      { keys: [["Shift", t("滾輪")]], action: t("左右捲動時間軸"), where: t("指標在時間軸") },
      { keys: [[t("拖曳")]], action: t("拖曳捲軸兩端縮放、拖曳中段捲動"), where: t("時間軸下方的縮放捲軸") },
      { keys: [[t("拖曳")]], action: t("拖曳軌道標頭的下緣調整軌道高度"), where: t("軌道標頭") },
      { keys: [[t("拖曳")]], action: t("移動、縮放或旋轉選取的圖層"), where: t("節目監看器的變形控制框") },
      { keys: [["Esc"]], action: t("取消拖曳中的編輯"), where: t("時間軸") },
    ],
  },
  {
    id: "panels",
    title: t("鏡頭、面板與選單"),
    items: [
      { keys: [["Alt", "↑"], ["Alt", "↓"]], action: t("調整鏡頭在影片中的順序"), where: t("焦點在「鏡頭」清單的鏡頭") },
      { keys: [["Delete"], ["Backspace"]], action: t("刪除鏡頭（會先確認）"), where: t("焦點在「鏡頭」清單的鏡頭") },
      { keys: [["Shift", "F10"], [t("選單鍵")]], action: t("開啟動作選單（也可按右鍵）"), where: t("焦點在清單項目或片段") },
      { keys: [["Mod", "Enter"]], action: t("渲染鏡頭"), where: t("焦點在鏡頭的屬性面板") },
      { keys: [["←"], ["→"], ["↑"], ["↓"]], action: t("調整面板大小（每次 16 px）"), where: t("焦點在面板分隔線") },
      { keys: [["Home"], ["End"]], action: t("面板縮到最小／放到最大"), where: t("焦點在面板分隔線") },
      { keys: [["Enter"]], action: t("還原預設大小（也可以雙擊分隔線）"), where: t("焦點在面板分隔線") },
      { keys: [["←"], ["→"]], action: t("切換分頁"), where: t("焦點在面板分頁") },
      { keys: [["↑"], ["↓"]], action: t("移到上一個／下一個選項"), where: t("選單") },
      { keys: [["Enter"], ["Space"]], action: t("執行選項"), where: t("選單") },
      { keys: [["Esc"]], action: t("關閉選單或對話框並回到原本的位置") },
    ],
  },
];

/** "?": opens the shortcut list (most layouts need Shift for it, so Shift is not checked). */
export function isHelpKey(event: KeyLike): boolean {
  return event.isComposing !== true && event.key !== "Process" && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === "?";
}

/** The shortcuts dialog (mounted once in the Studio frame, no trigger of its own) opens on "?" or this event. */
export const SHORTCUTS_OPEN_EVENT = "phasyn:studio-shortcuts";

/** Opens the shortcuts dialog from anywhere (the project manager, the Edit workspace's header). */
export function openShortcuts(): void {
  window.dispatchEvent(new Event(SHORTCUTS_OPEN_EVENT));
}
