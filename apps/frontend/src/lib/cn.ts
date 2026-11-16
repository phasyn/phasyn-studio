// SPDX-License-Identifier: Apache-2.0 AND MIT
// cn() follows the shadcn/ui helper convention (clsx + tailwind-merge; https://github.com/shadcn-ui/ui, MIT License,
// Copyright (c) 2023 shadcn). See THIRD_PARTY_NOTICES.md.
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge 需要知道 index.css 自訂的名稱，否則會誤判並合併掉：
 * - 字級（text-title…）不是顏色；圓角、陰影（含品牌光暈、視窗／浮層陰影）、動畫與彈簧曲線是主題值；
 * - 品牌漸層填色（bg-brand-gradient、bg-brand-gradient-soft、bg-action-gradient）是背景圖，不是背景色——
 *   和 bg-surface 等底色並存（底色是後備、漸層蓋在上面）；
 * - border-brand-gradient（::after 光邊）與 text-brand-gradient（漸層文字）、材質（material-*）、pressable、stagger 各自一組，
 *   不和邊框色、文字色或其他 utility 互相覆蓋。
 */
type PhasynClassGroup = "border-brand-gradient" | "text-brand-gradient" | "material" | "pressable" | "stagger";

const twMerge = extendTailwindMerge<PhasynClassGroup>({
  extend: {
    theme: {
      text: ["title", "page", "section", "body", "data", "caption", "reading", "metric"],
      radius: ["sm", "md", "lg", "xl", "2xl", "full"],
      shadow: ["raised", "edge", "overlay", "popover", "window", "glow", "glow-sm"],
      breakpoint: ["sm", "md", "lg", "xl"],
      animate: [
        "fade-in",
        "fade-out",
        "pop-in",
        "dialog-in",
        "dialog-out",
        "sheet-in",
        "sheet-out",
        "drawer-in",
        "drawer-out",
        "reveal",
        "shimmer",
        "glow-pulse",
        "rise-in",
      ],
      ease: ["standard", "enter", "exit", "spring-smooth", "spring-snappy", "spring-bouncy"],
    },
    classGroups: {
      "bg-image": ["bg-brand-gradient", "bg-brand-gradient-soft", "bg-action-gradient"],
      "border-brand-gradient": ["border-brand-gradient"],
      "text-brand-gradient": ["text-brand-gradient"],
      material: ["material-sidebar", "material-popover", "material-sheet", "material-hud"],
      pressable: ["pressable"],
      stagger: ["stagger"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
