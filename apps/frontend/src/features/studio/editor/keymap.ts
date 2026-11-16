// The Video Studio's one key map: every editor shortcut with its keys, its name and the test that recognizes it.
// The editor provider runs it (useEditorKeys) and the "?" dialog lists it, so the two cannot disagree.
import { t } from "@/i18n";
import type { KeyLike } from "@/lib/keyboard";

export type EditorCommandId =
  | "playToggle"
  | "shuttleBack"
  | "shuttleStop"
  | "shuttleForward"
  | "shuttleBackSlow"
  | "shuttleForwardSlow"
  | "stepBack"
  | "stepForward"
  | "stepBackFive"
  | "stepForwardFive"
  | "previousEdit"
  | "nextEdit"
  | "goStart"
  | "goEnd"
  | "markIn"
  | "markOut"
  | "goIn"
  | "goOut"
  | "insert"
  | "overwrite"
  | "rippleTrimPrevious"
  | "rippleTrimNext"
  | "trimPrevious"
  | "trimNext"
  | "extendEdit"
  | "addEdit"
  | "addEditAll"
  | "lift"
  | "extract"
  | "toggleEnabled"
  | "defaultVideoTransition"
  | "defaultAudioTransition"
  | "defaultTransitions"
  | "delete"
  | "rippleDelete"
  | "addMarker"
  | "addText"
  | "toggleSnap"
  | "toolSelect"
  | "toolRipple"
  | "toolRoll"
  | "toolRazor"
  | "toolSlip"
  | "toolSlide"
  | "zoomFit"
  | "zoomIn"
  | "zoomOut"
  | "undo"
  | "redo"
  | "copy"
  | "cut"
  | "paste"
  | "pasteInsert"
  | "pasteAttributes"
  | "selectAll"
  | "deselect"
  | "toggleLink"
  | "save";

export type KeyGroupId = "playback" | "marking" | "editing" | "tools" | "general";

/** all = the Shots and the Edit workspace; edit = the Edit workspace only (the only place that changes the timeline's clips). */
export type KeyScope = "all" | "edit";

export interface KeyBinding {
  id: EditorCommandId;
  /** Alternative chords, each a list of keys pressed together ("Mod" = Ctrl or ⌘). */
  keys: string[][];
  label: string;
  group: KeyGroupId;
  scope: KeyScope;
  matches: (event: KeyLike) => boolean;
  /** Works while typing in a text field too (saving). */
  inText?: boolean;
}

const plain = (event: KeyLike) => !event.ctrlKey && !event.metaKey && !event.altKey;
const bare = (event: KeyLike) => plain(event) && !event.shiftKey;
const shifted = (event: KeyLike) => plain(event) && event.shiftKey;
const mod = (event: KeyLike) => (event.ctrlKey || event.metaKey) && !event.altKey;
const modAlt = (event: KeyLike) => (event.ctrlKey || event.metaKey) && event.altKey;
const letter = (event: KeyLike, char: string) => event.key.toLowerCase() === char || event.code === `Key${char.toUpperCase()}`;
const key = (event: KeyLike, ...names: string[]) => names.includes(event.key);

export const KEY_BINDINGS: readonly KeyBinding[] = [
  { id: "playToggle", keys: [["Space"]], label: t("播放／暫停"), group: "playback", scope: "all", matches: (e) => bare(e) && (e.key === " " || e.code === "Space") },
  { id: "shuttleBack", keys: [["J"]], label: t("倒轉穿梭（再按一次加速）"), group: "playback", scope: "all", matches: (e) => bare(e) && letter(e, "j") },
  { id: "shuttleStop", keys: [["K"]], label: t("停止"), group: "playback", scope: "all", matches: (e) => bare(e) && letter(e, "k") },
  { id: "shuttleForward", keys: [["L"]], label: t("正向穿梭（再按一次加速）"), group: "playback", scope: "all", matches: (e) => bare(e) && letter(e, "l") },
  { id: "shuttleBackSlow", keys: [["Shift", "J"]], label: t("慢速倒轉（再按一次更慢）"), group: "playback", scope: "all", matches: (e) => shifted(e) && letter(e, "j") },
  { id: "shuttleForwardSlow", keys: [["Shift", "L"]], label: t("慢速播放（再按一次更慢）"), group: "playback", scope: "all", matches: (e) => shifted(e) && letter(e, "l") },
  { id: "stepBack", keys: [["←"]], label: t("上一影格"), group: "playback", scope: "all", matches: (e) => bare(e) && key(e, "ArrowLeft") },
  { id: "stepForward", keys: [["→"]], label: t("下一影格"), group: "playback", scope: "all", matches: (e) => bare(e) && key(e, "ArrowRight") },
  { id: "stepBackFive", keys: [["Shift", "←"]], label: t("往前五影格"), group: "playback", scope: "all", matches: (e) => shifted(e) && key(e, "ArrowLeft") },
  { id: "stepForwardFive", keys: [["Shift", "→"]], label: t("往後五影格"), group: "playback", scope: "all", matches: (e) => shifted(e) && key(e, "ArrowRight") },
  { id: "previousEdit", keys: [["↑"]], label: t("上一個編輯點"), group: "playback", scope: "all", matches: (e) => bare(e) && key(e, "ArrowUp") },
  { id: "nextEdit", keys: [["↓"]], label: t("下一個編輯點"), group: "playback", scope: "all", matches: (e) => bare(e) && key(e, "ArrowDown") },
  { id: "goStart", keys: [["Home"]], label: t("到開頭"), group: "playback", scope: "all", matches: (e) => bare(e) && key(e, "Home") },
  { id: "goEnd", keys: [["End"]], label: t("到結尾"), group: "playback", scope: "all", matches: (e) => bare(e) && key(e, "End") },

  { id: "markIn", keys: [["I"]], label: t("標記入點"), group: "marking", scope: "edit", matches: (e) => bare(e) && letter(e, "i") },
  { id: "markOut", keys: [["O"]], label: t("標記出點"), group: "marking", scope: "edit", matches: (e) => bare(e) && letter(e, "o") },
  { id: "goIn", keys: [["Shift", "I"]], label: t("到入點"), group: "marking", scope: "edit", matches: (e) => shifted(e) && letter(e, "i") },
  { id: "goOut", keys: [["Shift", "O"]], label: t("到出點"), group: "marking", scope: "edit", matches: (e) => shifted(e) && letter(e, "o") },
  { id: "insert", keys: [[","]], label: t("插入來源的標記範圍"), group: "marking", scope: "edit", matches: (e) => bare(e) && (e.key === "," || e.code === "Comma") },
  { id: "overwrite", keys: [["."]], label: t("覆寫來源的標記範圍"), group: "marking", scope: "edit", matches: (e) => bare(e) && (e.key === "." || e.code === "Period") },
  { id: "lift", keys: [[";"]], label: t("提升入點到出點的範圍"), group: "marking", scope: "edit", matches: (e) => bare(e) && (e.key === ";" || e.code === "Semicolon") },
  { id: "extract", keys: [["'"]], label: t("擷取入點到出點的範圍"), group: "marking", scope: "edit", matches: (e) => bare(e) && (e.key === "'" || e.code === "Quote") },
  { id: "addMarker", keys: [["M"]], label: t("新增標記"), group: "marking", scope: "edit", matches: (e) => bare(e) && letter(e, "m") },

  { id: "rippleTrimPrevious", keys: [["Q"]], label: t("波紋修剪上一個編輯點到播放頭"), group: "editing", scope: "edit", matches: (e) => bare(e) && letter(e, "q") },
  { id: "rippleTrimNext", keys: [["W"]], label: t("波紋修剪下一個編輯點到播放頭"), group: "editing", scope: "edit", matches: (e) => bare(e) && letter(e, "w") },
  { id: "trimPrevious", keys: [["Shift", "Q"]], label: t("修剪上一個編輯點到播放頭（留下空隙）"), group: "editing", scope: "edit", matches: (e) => shifted(e) && letter(e, "q") },
  { id: "trimNext", keys: [["Shift", "W"]], label: t("修剪下一個編輯點到播放頭（留下空隙）"), group: "editing", scope: "edit", matches: (e) => shifted(e) && letter(e, "w") },
  { id: "extendEdit", keys: [["E"]], label: t("把選取片段較近的編輯點延伸到播放頭"), group: "editing", scope: "edit", matches: (e) => bare(e) && letter(e, "e") },
  { id: "addEdit", keys: [["Mod", "K"]], label: t("在播放頭新增編輯點"), group: "editing", scope: "edit", matches: (e) => mod(e) && !e.shiftKey && letter(e, "k") },
  { id: "addEditAll", keys: [["Mod", "Shift", "K"]], label: t("在所有軌道新增編輯點"), group: "editing", scope: "edit", matches: (e) => mod(e) && e.shiftKey && letter(e, "k") },
  { id: "toggleEnabled", keys: [["Shift", "E"]], label: t("啟用／停用片段"), group: "editing", scope: "edit", matches: (e) => shifted(e) && letter(e, "e") },
  { id: "defaultVideoTransition", keys: [["Mod", "D"]], label: t("套用預設視訊轉場（交叉溶接）"), group: "editing", scope: "edit", matches: (e) => mod(e) && !e.shiftKey && letter(e, "d") },
  { id: "defaultAudioTransition", keys: [["Mod", "Shift", "D"]], label: t("套用預設音訊轉場（音訊交叉淡化）"), group: "editing", scope: "edit", matches: (e) => mod(e) && e.shiftKey && letter(e, "d") },
  { id: "defaultTransitions", keys: [["Shift", "D"]], label: t("套用預設視訊與音訊轉場"), group: "editing", scope: "edit", matches: (e) => shifted(e) && letter(e, "d") },
  { id: "delete", keys: [["Delete"], ["Backspace"]], label: t("刪除選取的片段、轉場或字幕"), group: "editing", scope: "edit", matches: (e) => bare(e) && key(e, "Delete", "Backspace") },
  { id: "rippleDelete", keys: [["Shift", "Delete"]], label: t("波紋刪除"), group: "editing", scope: "edit", matches: (e) => shifted(e) && key(e, "Delete", "Backspace") },
  { id: "toggleLink", keys: [["Mod", "L"]], label: t("連結／取消連結"), group: "editing", scope: "edit", matches: (e) => mod(e) && !e.shiftKey && letter(e, "l") },
  { id: "addText", keys: [["T"]], label: t("新增文字圖層"), group: "editing", scope: "edit", matches: (e) => bare(e) && letter(e, "t") },

  { id: "toolSelect", keys: [["V"]], label: t("選取工具"), group: "tools", scope: "edit", matches: (e) => bare(e) && letter(e, "v") },
  { id: "toolRipple", keys: [["B"]], label: t("波紋編輯工具"), group: "tools", scope: "edit", matches: (e) => bare(e) && letter(e, "b") },
  { id: "toolRoll", keys: [["N"]], label: t("滾動編輯工具"), group: "tools", scope: "edit", matches: (e) => bare(e) && letter(e, "n") },
  { id: "toolRazor", keys: [["C"]], label: t("剃刀工具"), group: "tools", scope: "edit", matches: (e) => bare(e) && letter(e, "c") },
  { id: "toolSlip", keys: [["Y"]], label: t("外滑工具"), group: "tools", scope: "edit", matches: (e) => bare(e) && letter(e, "y") },
  { id: "toolSlide", keys: [["U"]], label: t("內滑工具"), group: "tools", scope: "edit", matches: (e) => bare(e) && letter(e, "u") },
  { id: "toggleSnap", keys: [["S"]], label: t("開／關靠齊"), group: "tools", scope: "edit", matches: (e) => bare(e) && letter(e, "s") },
  { id: "zoomFit", keys: [["\\"]], label: t("整段序列放進時間軸"), group: "tools", scope: "all", matches: (e) => plain(e) && (e.key === "\\" || e.code === "Backslash") },
  { id: "zoomIn", keys: [["="]], label: t("放大時間軸"), group: "tools", scope: "all", matches: (e) => plain(e) && key(e, "=", "+") },
  { id: "zoomOut", keys: [["-"]], label: t("縮小時間軸"), group: "tools", scope: "all", matches: (e) => plain(e) && key(e, "-", "_") },

  { id: "undo", keys: [["Mod", "Z"]], label: t("復原"), group: "general", scope: "all", matches: (e) => mod(e) && !e.shiftKey && letter(e, "z") },
  { id: "redo", keys: [["Mod", "Shift", "Z"], ["Mod", "Y"]], label: t("重做"), group: "general", scope: "all", matches: (e) => mod(e) && ((e.shiftKey && letter(e, "z")) || (!e.shiftKey && letter(e, "y"))) },
  { id: "copy", keys: [["Mod", "C"]], label: t("複製"), group: "general", scope: "edit", matches: (e) => mod(e) && !e.shiftKey && letter(e, "c") },
  { id: "cut", keys: [["Mod", "X"]], label: t("剪下"), group: "general", scope: "edit", matches: (e) => mod(e) && !e.shiftKey && letter(e, "x") },
  { id: "paste", keys: [["Mod", "V"]], label: t("貼上（在播放頭覆寫）"), group: "general", scope: "edit", matches: (e) => mod(e) && !e.shiftKey && letter(e, "v") },
  { id: "pasteInsert", keys: [["Mod", "Shift", "V"]], label: t("貼上插入（後面的片段往右移）"), group: "general", scope: "edit", matches: (e) => mod(e) && e.shiftKey && letter(e, "v") },
  { id: "pasteAttributes", keys: [["Mod", "Alt", "V"]], label: t("貼上屬性…"), group: "general", scope: "edit", matches: (e) => modAlt(e) && !e.shiftKey && letter(e, "v") },
  { id: "selectAll", keys: [["Mod", "A"]], label: t("選取全部片段"), group: "general", scope: "edit", matches: (e) => mod(e) && !e.shiftKey && letter(e, "a") },
  { id: "deselect", keys: [["Esc"]], label: t("停止播放並取消選取"), group: "general", scope: "edit", matches: (e) => bare(e) && key(e, "Escape") },
  { id: "save", keys: [["Mod", "S"]], label: t("立即儲存"), group: "general", scope: "all", inText: true, matches: (e) => mod(e) && !e.shiftKey && letter(e, "s") },
];

/** The binding a key event triggers in a workspace of that scope; null when it is not a shortcut (or an IME is composing). */
export function keyBinding(event: KeyLike, scope: KeyScope): KeyBinding | null {
  if (event.isComposing === true || event.key === "Process") return null;
  return KEY_BINDINGS.find((binding) => (scope === "edit" || binding.scope === "all") && binding.matches(event)) ?? null;
}

/** The display chord of a command (for tooltips and menus), e.g. "Mod+K"; empty when it has none. */
export function chordOf(id: EditorCommandId): string {
  return KEY_BINDINGS.find((binding) => binding.id === id)?.keys[0]?.join("+") ?? "";
}
