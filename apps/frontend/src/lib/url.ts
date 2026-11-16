// URL 檢查：把伺服器給的字串當成連結或 API 路徑之前先過這裡。

/** 絕對的 http(s) 網址；其他 scheme（javascript:、data:…）或解析失敗 → null。Node 回報的來源與授權連結用這個決定要不要畫成連結。 */
export function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** URL 路徑的一段：`.` 與 `..` 會被瀏覽器正規化掉、把請求導到上一層，所以換成不可能存在的 `_`（伺服器回 404／422）。 */
export function pathSegment(value: string): string {
  return value === "." || value === ".." ? "_" : encodeURIComponent(value);
}

/** 路徑（不含 query）是否含有 `.`／`..` 區段。 */
export function hasDotSegment(path: string): boolean {
  return (path.split(/[?#]/, 1)[0] ?? "").split("/").some((part) => part === "." || part === "..");
}
