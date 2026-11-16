// 參考素材（H3 ref2va）的對外介面：素材庫上傳、鏡頭的參考清單、轉成 h3.materials.v1。匯出名稱與型別是固定契約。
export { ReferencesPanel, type ReferencesPanelProps } from "./ReferencesPanel";
export { materialsFor, validateReferences } from "./materials";
/** 不擋渲染的提醒（官方 2–15 秒建議、長度未知、超過生成長度會被截斷）。 */
export { referenceWarnings } from "./materials";
/** 送出順序（圖片 → 聲音 → 影片，各自依 alias 序號）：materials 與 take 記錄共用，順序決定 H3 的 <Picture n>／<Audio n>／<Video n> 編號。 */
export { orderedReferences } from "./materials";
/** 參考影片在終點之後凍結最後一格（hold_last_frame）：materials、take 記錄與時間預估都以生成長度計算這段影片。 */
export { heldReference } from "./materials";
