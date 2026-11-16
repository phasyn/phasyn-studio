/** 把任意路徑轉成合法的 DOM id 片段（同一頁面以 prefix 區隔）。 */
export function domId(prefix: string, path: string): string {
  return `${prefix}-${path.replace(/[^A-Za-z0-9_-]+/g, "-") || "root"}`;
}
