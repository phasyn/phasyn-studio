// 插件版本（SemVer 2.0，不含 build metadata）的先後：安裝同 id 的檔案時用來說明是更新、換回舊版還是重新安裝。
// 只影響說法與按鈕文字；能不能取代由主控決定。

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION.exec(text);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".") : [] };
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = /^[0-9]+$/.test(a);
  const numericB = /^[0-9]+$/.test(b);
  if (numericA && numericB) return Number(a) - Number(b);
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePre(a: readonly string[], b: readonly string[]): number {
  // 正式版比它的預發行版新
  if (a.length === 0 || b.length === 0) return (a.length === 0 ? 1 : 0) - (b.length === 0 ? 1 : 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = compareIdentifiers(a[index] ?? "", b[index] ?? "");
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/** a 比 b 舊為負、相同為 0、較新為正；任一個不是 SemVer 時為 null。 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    const order = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (order !== 0) return order;
  }
  return comparePre(left.pre, right.pre);
}

export type VersionChange = "upgrade" | "downgrade" | "same" | "unknown";

/** 從 from 換成 to 是哪一種變化。 */
export function versionChange(from: string, to: string): VersionChange {
  const order = compareVersions(to, from);
  if (order === null) return "unknown";
  return order > 0 ? "upgrade" : order < 0 ? "downgrade" : "same";
}
