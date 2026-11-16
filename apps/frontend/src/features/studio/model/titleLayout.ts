// 文字圖層：在瀏覽器把標題排版成與序列同尺寸的透明 PNG（匯出時 media.concat 以 overlay 疊上；
// 這套部署的 FFmpeg 沒有 drawtext，伺服器不排字）。預覽與匯出共用輸出尺寸的排版規則；預覽只縮小已排好的文字。
// layoutTitle 是純函式（量字寬由呼叫端提供），renderTitlePng 只在瀏覽器執行。
import type { Title, TitlePosition, TitleSize } from "./clipEffects";
import { t } from "@/i18n";

export type TitleText = Pick<Title, "text" | "position" | "size" | "style">;
export type TitleStyle = NonNullable<Title["style"]>;

/** 字級相對畫面高度。 */
export const TITLE_SIZE_RATIO: Record<TitleSize, number> = { small: 0.05, medium: 0.075, large: 0.11 };
export const TITLE_FONT_STACK = '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif';
export const TITLE_MAX_LINES = 3;
export const TITLE_FONT_FAMILIES: Record<TitleStyle["font_family"], string> = {
  sans: TITLE_FONT_STACK,
  serif: '"Noto Serif TC", "Songti TC", "PMingLiU", serif',
  mono: 'ui-monospace, "Noto Sans Mono", "Cascadia Mono", monospace',
};

/** User text is never interpolated into a font family; only this closed allowlist is used. */
export function defaultTitleStyle(title?: Pick<Title, "position" | "size">): TitleStyle {
  const position = title?.position ?? "center";
  return { font_family: "sans", font_size: Math.round(1080 * TITLE_SIZE_RATIO[title?.size ?? "medium"]), font_weight: 700, color: "#ffffff", align: position === "lower_third" ? "left" : "center", x: position === "lower_third" ? 0.06 : 0.5, y: position === "top" ? 0.13 : position === "bottom" ? 0.85 : position === "lower_third" ? 0.79 : 0.5 };
}

export interface TitleLayout {
  fontPx: number;
  lineHeight: number;
  lines: string[];
  align: "center" | "left" | "right";
  font: string;
  color: string;
  /** 對齊基準的 x（center＝中心線、left＝左緣）。 */
  x: number;
  /** 第一行的頂端。 */
  top: number;
  maxWidth: number;
  /** 外框（描邊）寬度。 */
  strokePx: number;
  /** 左下字幕條的底色方塊；其他位置沒有。 */
  band: { x: number; y: number; width: number; height: number } | null;
}

/** 可斷行的單位：連續的拉丁字母／數字（含後面的空白）為一個，其餘（中日韓字、標點）每個字元一個。 */
function tokens(text: string): string[] {
  const parts = text.match(/[A-Za-z0-9_'’\-.,!?:;]+\s*|\s+|./gu) ?? [];
  const out: string[] = [];
  for (const part of parts) {
    const previous = out.at(-1);
    if (/^[，。！？、；：）】」』…]+$/u.test(part) && previous !== undefined) out[out.length - 1] = previous + part;
    else out.push(part);
  }
  return out;
}

function wrap(paragraph: string, maxWidth: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const token of tokens(paragraph)) {
    if (!line.trim()) line = token.trimStart();
    else if (measure((line + token).trimEnd()) <= maxWidth) line += token;
    else {
      lines.push(line.trimEnd());
      line = token.trimStart();
    }
    // 單一個比整行還寬的拉丁字：逐字元切開（以 code point 為單位，不切斷 surrogate pair）
    while ([...line.trimEnd()].length > 1 && measure(line.trimEnd()) > maxWidth) {
      const chars = [...line.trimEnd()];
      let cut = chars.length - 1;
      while (cut > 1 && measure(chars.slice(0, cut).join("")) > maxWidth) cut -= 1;
      lines.push(chars.slice(0, cut).join(""));
      line = chars.slice(cut).join("");
    }
  }
  if (line.trim() || lines.length === 0) lines.push(line.trimEnd());
  return lines;
}

/**
 * 排版：自訂樣式使用明確字型、字級、色彩與座標；舊預設保留最多 3 行與省略號。
 * measure(text, fontPx, style) 回傳文字寬度（px）；排版與量字必須使用相同的字型與字重。
 */
export function layoutTitle(
  title: TitleText,
  width: number,
  height: number,
  measure: (text: string, fontPx: number, style?: TitleStyle) => number,
): TitleLayout {
  const style = title.style;
  const fontPx = style ? Math.max(1, height * style.font_size / 1080) : Math.max(10, Math.round(height * TITLE_SIZE_RATIO[title.size]));
  const lineHeight = Math.round(fontPx * 1.3);
  const position: TitlePosition = title.position;
  const lowerThird = !style && position === "lower_third";
  const maxWidth = Math.round(width * (lowerThird ? 0.78 : 0.88));
  const measureAt = (text: string) => measure(text, fontPx, style);
  const lines = title.text
    .split(/\r?\n/)
    .flatMap((paragraph) => wrap(paragraph, maxWidth, measureAt));
  const lineLimit = style ? lines.length : TITLE_MAX_LINES;
  if (lines.length > lineLimit) {
    const kept = lines.slice(0, lineLimit);
    let last = `${kept[lineLimit - 1] ?? ""}…`;
    while (last.length > 1 && measureAt(last) > maxWidth) last = `${last.slice(0, -2)}…`;
    kept[lineLimit - 1] = last;
    lines.splice(0, lines.length, ...kept);
  }
  const blockHeight = lines.length * lineHeight;
  const strokePx = Math.max(2, Math.round(fontPx * 0.12));
  let top: number;
  if (style) top = style.y * height - blockHeight / 2;
  else if (position === "top") top = Math.round(height * 0.08);
  else if (position === "center") top = Math.round((height - blockHeight) / 2);
  else if (position === "bottom") top = Math.round(height * 0.9 - blockHeight);
  else top = Math.round(height * 0.84 - blockHeight);
  const x = style ? style.x * width : lowerThird ? Math.round(width * 0.06) : Math.round(width / 2);
  let band: TitleLayout["band"] = null;
  if (lowerThird) {
    const textWidth = Math.max(...lines.map((line) => measureAt(line)), fontPx);
    const pad = Math.round(fontPx * 0.45);
    band = { x: x - pad, y: top - pad, width: Math.min(width - (x - pad), textWidth + pad * 2), height: blockHeight + pad * 2 };
  }
  return { fontPx, lineHeight, lines, align: style?.align ?? (lowerThird ? "left" : "center"), font: fontFor(fontPx, style), color: style?.color ?? "#ffffff", x, top, maxWidth, strokePx, band };
}

function fontFor(fontPx: number, style?: TitleStyle): string {
  return `${style?.font_weight ?? 600} ${fontPx}px ${style ? TITLE_FONT_FAMILIES[style.font_family] : TITLE_FONT_STACK}`;
}

/** 在 canvas 上畫出標題；舊預設保留白字黑邊與左下字幕條，自訂樣式使用指定字色。 */
export function drawTitle(context: CanvasRenderingContext2D, layout: TitleLayout): void {
  context.save();
  if (layout.band) {
    context.fillStyle = "rgba(0, 0, 0, 0.55)";
    context.fillRect(layout.band.x, layout.band.y, layout.band.width, layout.band.height);
  }
  context.font = layout.font;
  context.textAlign = layout.align;
  context.textBaseline = "top";
  context.lineJoin = "round";
  context.miterLimit = 2;
  layout.lines.forEach((line, index) => {
    const y = layout.top + index * layout.lineHeight + Math.round((layout.lineHeight - layout.fontPx) / 2);
    context.lineWidth = layout.strokePx;
    context.strokeStyle = "rgba(0, 0, 0, 0.85)";
    context.strokeText(line, layout.x, y, layout.maxWidth);
    context.fillStyle = layout.color;
    context.fillText(line, layout.x, y, layout.maxWidth);
  });
  context.restore();
}

/** 以 canvas 量字寬的 measure（給 layoutTitle）。 */
export function canvasMeasure(context: CanvasRenderingContext2D): (text: string, fontPx: number, style?: TitleStyle) => number {
  return (text, fontPx, style) => {
    context.font = fontFor(fontPx, style);
    return context.measureText(text).width;
  };
}

/** 排版並輸出成序列尺寸的透明 PNG（瀏覽器）。 */
export async function renderTitlePng(title: TitleText, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(t("瀏覽器無法建立 2D 畫布，不能產生文字圖層"));
  await document.fonts.ready.catch(() => undefined);
  drawTitle(context, layoutTitle(title, width, height, canvasMeasure(context)));
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t("無法把文字圖層輸出成 PNG")))), "image/png");
  });
}
