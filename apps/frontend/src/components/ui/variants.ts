import { cva } from "class-variance-authority";

// 按鈕（契約 v2）：primary＝深色操作漸層（#2767DE→#4D5FE3→#7A4FD9）＋白字（三個色標上 ≥ 5.1:1；hover 的 brightness-105 仍 ≥ 4.7）＋
// 1 px 頂端內光；hover 與鍵盤焦點加品牌光暈（焦點框仍是全域的 focus 外框）。disabled 同時移除漸層、光暈與陰影，看起來不能按。
// 動作：pressable——按下 90 ms 縮到 0.97、放開以 snappy 彈簧回彈，顏色 120 ms。每個任務區域只放一個 primary。
export const buttonVariants = cva(
  [
    "pressable inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap select-none",
    "disabled:cursor-not-allowed disabled:border-line-subtle disabled:bg-raised disabled:bg-none disabled:text-fg-disabled disabled:shadow-none disabled:brightness-100",
    "aria-busy:cursor-progress [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary:
          "border-transparent bg-action-gradient font-semibold text-[#fff] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.18),0_1px_2px_rgb(0_0_0_/_0.35)] hover:shadow-glow-sm hover:brightness-105 focus-visible:shadow-glow-sm active:brightness-95 aria-busy:animate-shimmer",
        secondary: "border-line-strong bg-raised text-fg shadow-edge hover:border-action/60 hover:bg-overlay active:bg-sunken",
        quiet: "border-transparent bg-transparent text-fg-secondary hover:bg-raised hover:text-fg active:bg-sunken",
        danger: "border-danger/40 bg-danger/10 text-danger hover:border-danger/70 hover:bg-danger/15 active:bg-danger/20",
        // 淺色實心＋深色文字：hover／按下用亮度微調（文字對比仍 ≥ 9:1），不套用中性 hover
        "danger-confirm":
          "border-danger-fill bg-danger-fill font-semibold text-on-accent hover:bg-danger-fill enabled:hover:brightness-105 active:bg-danger-fill enabled:active:brightness-95",
      },
      size: {
        md: "min-h-10 px-3.5 text-body",
        sm: "min-h-8 px-3 text-data",
        icon: "size-10 p-0",
        "icon-sm": "size-8 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

// 狀態色只表達語意狀態，並一律搭配文字（常與圖示一起），不單靠顏色。膠囊形（契約 v2：chip＝full）。
export const badgeVariants = cva(
  "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-px text-caption font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-line bg-raised text-fg-secondary",
        info: "border-info/30 bg-info/12 text-info",
        success: "border-success/30 bg-success/12 text-success",
        warning: "border-warning/30 bg-warning/12 text-warning",
        danger: "border-danger/30 bg-danger/12 text-danger",
        entity: "border-entity/30 bg-entity/12 text-entity",
        file: "border-file/30 bg-file/12 text-file",
        action: "border-action/30 bg-action/12 text-action-fg",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);
