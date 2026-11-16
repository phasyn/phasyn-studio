// Prompt 編輯器的對外介面（Studio 鏡頭屬性使用）。實作由 prompt/ 模組負責；這裡的匯出名稱與型別是固定契約。
export { PromptEditor, type PromptEditorProps } from "./PromptEditor";
/** 專業編輯器管理鏡頭參考所需的寫入（PromptEditor 的 referenceEditing）。 */
export type { ShotReferenceEditing } from "./PromptWorkbench";
export { compilePrompt, PROMPT_MAX_LENGTH, type CompiledPrompt } from "./compile";
/** 在 prompt 的指定位置插入 @alias（例如參考素材面板的「插入」按鈕：插在文末）。 */
export { insertMentionAt } from "./mentions";
