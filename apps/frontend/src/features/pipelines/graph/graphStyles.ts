// 節點圖（PHASYN FLOW）的共用外觀。class 字串必須完整寫出（Tailwind 只掃描字面值）。

/**
 * 深空畫布：sunken 底＋靜態 24 px 點陣，上方一層很淡的品牌藍光暈（靜態：不隨平移移動、不動畫）。
 * 兩層背景：點陣（24 px 重複）、光暈（整塊、不重複）。
 */
export const GRAPH_CANVAS =
  "bg-sunken bg-[image:radial-gradient(var(--color-line-subtle)_1px,transparent_1px),radial-gradient(120%_70%_at_50%_-12%,rgb(79_123_255/0.09),transparent_62%)] bg-size-[24px_24px,100%_100%] [background-repeat:repeat,no-repeat]";

/**
 * 選取的節點卡：1 px 品牌漸層邊（青→藍→紫）＋淡品牌光暈。
 * 漸層邊以兩層背景畫出（padding-box 填 surface、border-box 填漸層，邊框本身透明）：不使用 ::after，
 * 所以接點圓點仍畫在邊框上層，也不會被 tailwind-merge 當成邊框顏色而與類型色邊框合併掉。邊框寬度不變（接點位置不動）。
 */
export const SELECTED_NODE =
  "border-transparent shadow-glow-sm [background:linear-gradient(var(--color-surface),var(--color-surface))_padding-box,linear-gradient(115deg,var(--color-brand-cyan),var(--color-brand-blue),var(--color-brand-violet))_border-box]";

/** 選取的流程輸出徽章：同樣的漸層邊，內部疊一層低透明度品牌底色。 */
export const SELECTED_EXPORT =
  "border-transparent text-fg shadow-glow-sm [background:linear-gradient(var(--color-brand-soft),var(--color-brand-soft))_padding-box,linear-gradient(var(--color-surface),var(--color-surface))_padding-box,linear-gradient(115deg,var(--color-brand-cyan),var(--color-brand-blue),var(--color-brand-violet))_border-box]";
