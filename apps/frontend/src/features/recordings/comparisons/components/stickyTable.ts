// 比較表的固定欄列：外層內容區（DockBody）是唯一 scroll owner，表格本身不再包一層捲動容器，
// 所以表頭可以固定在內容區頂端、列標題（路徑／指標名稱）在橫向捲動時固定在左側。
// border-collapse 的格線不會跟著 sticky 格移動：改用 inset 陰影畫分隔線。
// 疊放順序：角落 > 表頭 > 列標題 > 一般格（往下捲時列標題要滑到表頭底下）。

/** 表頭格（欄＝recording）。 */
export const HEAD_CELL = "sticky top-0 z-[2] shadow-[inset_0_-1px_0_var(--color-line)]";

/** 左上角格（「路徑」「指標」）。 */
export const CORNER_CELL = "sticky top-0 left-0 z-[3] shadow-[inset_-1px_-1px_0_var(--color-line)]";

/** 每列的列標題格：不透明底色蓋住橫向捲過去的值。 */
export const ROW_HEAD_CELL = "sticky left-0 z-[1] bg-surface shadow-[inset_-1px_0_0_var(--color-line-subtle)]";

/** 基準欄（第 1 筆）的表頭：頂端 2 px 品牌漸層標記（目前項目的標記，不是好壞）。疊在 HEAD_CELL 之後。 */
export const BASELINE_HEAD = "bg-(image:--gradient-brand) bg-size-[100%_2px] bg-top bg-no-repeat";

/** 基準欄的一般格：很淡的品牌底色，讓比較時眼睛有錨點；資料仍是一般文字色。 */
export const BASELINE_CELL = "bg-brand-soft/35";
