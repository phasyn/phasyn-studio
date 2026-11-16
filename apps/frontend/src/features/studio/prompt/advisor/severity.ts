// 嚴重度的圖示與顏色（面板與工具列浮層共用）：顏色只表示嚴重度，一律配圖示與文字。
import { CircleX, Info, Lightbulb, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Severity } from "./types";

export const SEVERITY_STYLE: Record<Severity, { icon: LucideIcon; tone: string }> = {
  error: { icon: CircleX, tone: "text-danger" },
  warning: { icon: TriangleAlert, tone: "text-warning" },
  suggestion: { icon: Lightbulb, tone: "text-info" },
  info: { icon: Info, tone: "text-fg-tertiary" },
};
