// Time and path helpers for palette rows and "is this where I already am" checks. Pure.
import { t } from "@/i18n";

/** 相對時間（中文）；無法解析、超過 30 天或明顯在未來（時鐘偏差）回傳 null，由呼叫端改顯示絕對時間。 */
export function formatRelativeTime(iso: string, nowMs: number): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const diff = nowMs - time;
  if (diff < -60_000) return null;
  if (diff < 60_000) return t("剛剛");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("{minutes} 分鐘前", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{hours} 小時前", { hours });
  const days = Math.floor(hours / 24);
  return days <= 30 ? t("{days} 天前", { days }) : null;
}

/** 本地時區的精簡絕對時間（MM/DD HH:mm）。 */
export function formatShortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The project open on the current page: the `project` query of a Video Studio or Image Studio page, else null. The
 * Video Studio pages of the palette open it, so "Video Studio・編輯" lands in that project instead of the project list.
 */
export function openProjectOf(pathname: string, search: string): string | null {
  if (pathname !== "/image" && !pathname.startsWith("/studio/")) return null;
  return new URLSearchParams(search).get("project") || null;
}

/** 路由路徑（去掉 query 與 hash）。 */
export function pathnameOf(to: string): string {
  const cut = to.search(/[?#]/);
  return cut < 0 ? to : to.slice(0, cut);
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 比較兩個 pathname（容許百分比編碼差異）。 */
export function samePathname(a: string, b: string): boolean {
  return decodeSafe(a) === decodeSafe(b);
}

function normalizeSearch(search: string): string {
  try {
    return new URLSearchParams(search).toString();
  } catch {
    return search;
  }
}

/** 目前位置（pathname＋search）是否就是導覽目的地 to（query 編碼差異視為相同；忽略 hash）。 */
export function sameTarget(pathname: string, search: string, to: string): boolean {
  const hash = to.indexOf("#");
  const withoutHash = hash < 0 ? to : to.slice(0, hash);
  const query = withoutHash.indexOf("?");
  const targetSearch = query < 0 ? "" : withoutHash.slice(query);
  return samePathname(pathname, pathnameOf(withoutHash)) && normalizeSearch(search) === normalizeSearch(targetSearch);
}
