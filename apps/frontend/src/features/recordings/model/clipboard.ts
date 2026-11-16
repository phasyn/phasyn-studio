// 複製到剪貼簿：內網 HTTP（非 secure context）沒有 navigator.clipboard 時，退回暫時 textarea 選取複製。

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && "clipboard" in navigator) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 改用下方的選取複製
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    // execCommand 已不建議使用，但它是非 secure context 唯一可用的複製方式
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
