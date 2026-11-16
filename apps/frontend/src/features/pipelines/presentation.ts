// 元件組合（PHASYN FLOW）頁面共用的外觀片段。class 字串必須完整寫出（Tailwind 只掃描字面值）。

/**
 * 清單或卡片中「目前選取／使用中」的項目：低透明度品牌漸層底＋左側 2 px 直向品牌漸層標記（before 偽元素）。
 * 元素本身需要 relative（標記以它定位）。狀態永遠另有文字（例如「目前使用」），顏色只是第二線索。
 */
export const SELECTED_ITEM =
  "bg-brand-gradient-soft text-fg before:pointer-events-none before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-linear-to-b before:from-brand-cyan before:via-brand-blue before:to-brand-violet";

/**
 * 可選取的小卡片（範本、instance 候選；不是表格列）：滑過時以 snappy 彈簧抬升 1 px 並加深陰影，按下縮到 0.98；
 * 顏色與邊框 120 ms。只動 translate／scale／陰影，不影響版面）。
 * 彈簧 token 由共用 CSS 提供；尚未載入時退回標準曲線。
 */
export const LIFT_CARD =
  "transition-[translate,scale,box-shadow,background-color,border-color] [transition-duration:var(--duration-spring-snappy,440ms),var(--duration-spring-snappy,440ms),var(--duration-spring-snappy,440ms),var(--duration-fast),var(--duration-fast)] [transition-timing-function:var(--ease-spring-snappy,cubic-bezier(0.2,0,0,1)),var(--ease-spring-snappy,cubic-bezier(0.2,0,0,1)),var(--ease-spring-snappy,cubic-bezier(0.2,0,0,1)),var(--ease-standard),var(--ease-standard)] hover:shadow-raised hover:-translate-y-px active:scale-[0.98]";

/**
 * 正在編輯的卡片（焦點在卡片內）：1 px 品牌漸層邊。以兩層背景畫出（padding-box 填 surface、border-box 填漸層、
 * 邊框透明），不用 ::after，也不會被 tailwind-merge 當成邊框顏色合併掉；邊框寬度不變、版面不動。
 */
export const ACTIVE_CARD_EDGE =
  "focus-within:border-transparent focus-within:[background:linear-gradient(var(--color-surface),var(--color-surface))_padding-box,linear-gradient(115deg,var(--color-brand-cyan),var(--color-brand-blue),var(--color-brand-violet))_border-box]";

/** List items entering one after another (played only when an item first mounts): the shared look and motion recipes. */
export { RISE_IN as APPEAR } from "@/components/ui/look";
