// 剪貼簿：成功 → true；瀏覽器拒絕或不支援（非 https、權限、iframe）→ false，由呼叫端改成「選取文字，請按 Ctrl+C」。
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || (!("clipboard" in navigator) || typeof navigator.clipboard.writeText !== "function")) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
