// Number formatting shared by the swap wizard steps.
import { t } from "@/i18n";

export const seconds = (value: number) => t("{value} 秒", { value: value.toFixed(3) });
export const frameSeconds = (frames: number, fps = 24) => t("{frames} 秒", { frames: (frames / fps).toFixed(2) });
export const round3 = (value: number) => Math.round(value * 1000) / 1000;
