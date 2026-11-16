// textarea 游標的畫面座標（相對 textarea 內容左上角，未扣捲動）：用一個複製樣式的隱藏 div 量測。
// 只在事件處理中呼叫（讀 DOM），不在 render 期間使用。
const COPIED = [
  "direction",
  "box-sizing",
  "width",
  "height",
  "overflow-x",
  "overflow-y",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-style",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-size",
  "font-size-adjust",
  "line-height",
  "font-family",
  "text-align",
  "text-transform",
  "text-indent",
  "letter-spacing",
  "word-spacing",
  "tab-size",
  "white-space",
  "word-break",
  "overflow-wrap",
];

export interface CaretPoint {
  top: number;
  left: number;
  height: number;
}

export function caretPoint(textarea: HTMLTextAreaElement, position: number): CaretPoint {
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const property of COPIED) mirror.style.setProperty(property, computed.getPropertyValue(property));
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.overflow = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(position) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = Number.parseFloat(computed.lineHeight);
  const point = {
    top: marker.offsetTop + Number.parseFloat(computed.borderTopWidth || "0"),
    left: marker.offsetLeft + Number.parseFloat(computed.borderLeftWidth || "0"),
    height: Number.isFinite(lineHeight) ? lineHeight : Number.parseFloat(computed.fontSize) * 1.5,
  };
  mirror.remove();
  return point;
}
