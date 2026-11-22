// 元件 instance 的介面分類資料夾（ComponentDescriptor.folder，以 / 分層）：純函式。
// folder 為 null 時依 provider 放進預設分類；預設分類只在介面使用，不寫回 Node。
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { t } from "@/i18n";

/** 契約 ComponentFolder：每層 1–60 字、不含 / 與換行，最多 6 層；整個路徑最多 200 字。 */
export const FOLDER_PATTERN = /^[^/\n]{1,60}(\/[^/\n]{1,60}){0,5}$/u;
export const FOLDER_MAX_LENGTH = 200;
export const FOLDER_MAX_DEPTH = 6;
export const FOLDER_SEGMENT_MAX = 60;

// 預設分類＝繁中原文：與 Node 回報的 folder（deploy 設定）相同、也是排序用的 key，不能翻譯；
// 畫面上的資料夾名稱用 folderDisplayName／folderDisplayPath 顯示譯文。
// i18n-ignore-start
const GENERATION = "生成";
const TEXT_CONDITION = "生成/文字條件";
const DIT = "生成/H3 DiT";
const VAE_ENCODE = "生成/VAE 編碼";
const VAE_DECODE = "生成/VAE 解碼";
// Qwen-Image（與 examples/components/qimg-*.json 的 folder 相同）
const IMAGE = "生成/圖片";
const IMAGE_TEXT = "生成/圖片/文字條件";
const IMAGE_VAE = "生成/圖片/VAE";
const IMAGE_IO = "生成/圖片/前後處理";
const MEDIA = "媒體處理";
const SEMANTICS = "語意與資料集";
const IMAGE_REVERSE = "語意與資料集/圖片反推";
const OTHER = "其他";
const TEST = "測試";
// i18n-ignore-end

/**
 * Display names of the default categories, keyed by their full path (read at display time, in the current language).
 * Levels whose name is not Chinese (H3 DiT, VAE) read the same in every language and are not listed.
 */
const DEFAULT_FOLDER_LABELS: ReadonlyMap<string, () => string> = new Map([
  [GENERATION, () => t("生成")],
  [TEXT_CONDITION, () => t("文字條件")],
  [VAE_ENCODE, () => t("VAE 編碼")],
  [VAE_DECODE, () => t("VAE 解碼")],
  [IMAGE, () => t("圖片")],
  [IMAGE_TEXT, () => t("文字條件")],
  [IMAGE_IO, () => t("前後處理")],
  [MEDIA, () => t("媒體處理")],
  [SEMANTICS, () => t("語意與資料集")],
  [IMAGE_REVERSE, () => t("圖片反推")],
  [OTHER, () => t("其他")],
  [TEST, () => t("測試")],
]);

const EXACT: Readonly<Record<string, string>> = {
  "h3.conditioning": TEXT_CONDITION,
  "h3.dit": DIT,
  "h3.reference": VAE_ENCODE,
  "h3.video_encode": VAE_ENCODE,
  "h3.audio_encode": VAE_ENCODE,
  "h3.video_decode": VAE_DECODE,
  "h3.audio_decode": VAE_DECODE,
  "qwen_vl.describe": SEMANTICS,
  "caption.compile": SEMANTICS,
  "dataset.export": SEMANTICS,
  "qimg.conditioning": IMAGE_TEXT,
  "qimg.prepare": IMAGE_IO,
  "image.compose": IMAGE_IO,
  "qimg.vae_encode": IMAGE_VAE,
  "qimg.vae_decode": IMAGE_VAE,
  "qimg.dit": IMAGE,
  "qimg.vision": IMAGE_REVERSE,
  "prompt.scene_compile": IMAGE_REVERSE,
  "prompt.scene_score": IMAGE_REVERSE,
};

/**
 * 同層資料夾的排列：已知分類依資料流程（文字條件 → 編碼 → DiT → 解碼），自訂資料夾排在已知分類之後、
 * 「其他」「測試」之前（同級時依名稱）。
 */
const RANK: Readonly<Record<string, number>> = {
  [GENERATION]: 0,
  [TEXT_CONDITION]: 0,
  [VAE_ENCODE]: 1,
  [DIT]: 2,
  [VAE_DECODE]: 3,
  [IMAGE]: 4,
  [IMAGE_TEXT]: 0,
  [IMAGE_VAE]: 1,
  [IMAGE_IO]: 2,
  [MEDIA]: 1,
  [SEMANTICS]: 2,
  [OTHER]: 1000,
  [TEST]: 1001,
};
const CUSTOM_RANK = 500;

/** 依 provider 的預設分類。 */
export function defaultFolderFor(providerId: string | null | undefined): string {
  if (!(providerId != null && providerId !== "")) return OTHER;
  const exact = EXACT[providerId];
  if (exact != null && exact !== "") return exact;
  if (providerId.startsWith("media.")) return MEDIA;
  if (providerId.startsWith("test.")) return TEST;
  return OTHER;
}

type FolderSource = Pick<ComponentDescriptor, "provider_id"> & { folder?: string | null };

/** instance 實際顯示的資料夾：有指定（合法）用指定的，否則用 provider 預設分類。 */
export function folderOf(descriptor: FolderSource): string {
  const assigned = descriptor.folder;
  if (typeof assigned === "string" && FOLDER_PATTERN.test(assigned)) return assigned;
  return defaultFolderFor(descriptor.provider_id);
}

/** 沒有指定資料夾（null 或空字串）＝目前顯示的是預設分類。 */
export function usesDefaultFolder(descriptor: FolderSource): boolean {
  return !(typeof descriptor.folder === "string" && FOLDER_PATTERN.test(descriptor.folder));
}

/** 「生成/H3 DiT」→ ["生成", "生成/H3 DiT"]（由淺到深，含自己）。 */
export function folderAncestors(path: string): string[] {
  const segments = path.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

export function folderName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

/** The display name of a folder's last level: a default category's translation, otherwise the name as entered. */
export function folderDisplayName(path: string): string {
  return DEFAULT_FOLDER_LABELS.get(path)?.() ?? folderName(path);
}

/**
 * The display text of a folder path. Folder values (default categories, the folders Nodes report, user input) keep
 * their source text; on screen only the levels that are default categories are translated, so 「生成/H3 DiT/自訂」 reads
 * "Generation/H3 DiT/自訂" in English. A user's own folder name is never translated, even when it happens to equal
 * some other interface text.
 */
export function folderDisplayPath(path: string): string {
  return folderAncestors(path).map(folderDisplayName).join("/");
}

export interface FolderInput {
  /** 正規化後的路徑；空白＝null（改回預設分類）。 */
  value: string | null;
  error: string | null;
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

/** 使用者輸入的資料夾 → 契約值：去掉每層前後空白；空白＝null；不合法時回傳繁中原因（保留使用者輸入）。 */
export function parseFolderInput(raw: string): FolderInput {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: null };
  if (/[\r\n]/.test(trimmed)) return { value: null, error: t("資料夾名稱不能換行") };
  const segments = trimmed.split("/").map((segment) => segment.trim());
  if (segments.some((segment) => segment === "")) return { value: null, error: t("每一層都要有名稱：不要用開頭、結尾或連續的「/」") };
  if (segments.length > FOLDER_MAX_DEPTH) return { value: null, error: t("最多 {folderMaxDepth} 層（目前 {segmentsCount} 層）", { folderMaxDepth: FOLDER_MAX_DEPTH, segmentsCount: segments.length }) };
  const long = segments.find((segment) => codePoints(segment) > FOLDER_SEGMENT_MAX);
  if (long !== undefined) return { value: null, error: t("每一層最多 {folderSegmentMax} 個字（「{long}…」太長）", { folderSegmentMax: FOLDER_SEGMENT_MAX, long: long.slice(0, 12) }) };
  const value = segments.join("/");
  if (codePoints(value) > FOLDER_MAX_LENGTH) return { value: null, error: t("整個路徑最多 {folderMaxLength} 個字", { folderMaxLength: FOLDER_MAX_LENGTH }) };
  if (!FOLDER_PATTERN.test(value)) return { value: null, error: t("資料夾格式不合法") };
  return { value, error: null };
}

export interface FolderNode<T> {
  /** 完整路徑（同一棵樹內唯一）。 */
  path: string;
  name: string;
  /** 0＝最上層。 */
  depth: number;
  folders: FolderNode<T>[];
  /** 直接放在這個資料夾的項目（依輸入順序）。 */
  items: T[];
  /** 含所有子資料夾的項目數。 */
  total: number;
}

function rankOf(path: string): number {
  return RANK[path] ?? CUSTOM_RANK;
}

const collator = new Intl.Collator("zh-Hant", { numeric: true, sensitivity: "base" });

export function compareFolderPaths(a: string, b: string): number {
  return rankOf(a) - rankOf(b) || collator.compare(folderName(a), folderName(b)) || collator.compare(a, b);
}

/** 依資料夾路徑建立樹（只建立有項目的路徑與其祖先）；同層依 compareFolderPaths 排列。 */
export function buildFolderTree<T>(items: readonly T[], pathOf: (item: T) => string): FolderNode<T>[] {
  const roots: FolderNode<T>[] = [];
  const byPath = new Map<string, FolderNode<T>>();
  const ensure = (path: string): FolderNode<T> => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const at = path.lastIndexOf("/");
    const parent = at < 0 ? null : ensure(path.slice(0, at));
    const node: FolderNode<T> = { path, name: folderName(path), depth: parent ? parent.depth + 1 : 0, folders: [], items: [], total: 0 };
    byPath.set(path, node);
    (parent ? parent.folders : roots).push(node);
    return node;
  };
  for (const item of items) {
    const leaf = ensure(pathOf(item));
    leaf.items.push(item);
    for (const ancestor of folderAncestors(leaf.path)) {
      const node = byPath.get(ancestor);
      if (node) node.total += 1;
    }
  }
  const sort = (list: FolderNode<T>[]) => {
    list.sort((a, b) => compareFolderPaths(a.path, b.path));
    for (const node of list) sort(node.folders);
  };
  sort(roots);
  return roots;
}

/** 樹中所有資料夾路徑（深度優先，與畫面順序相同）。 */
export function folderPathsOf<T>(tree: readonly FolderNode<T>[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly FolderNode<T>[]) => {
    for (const node of list) {
      out.push(node.path);
      walk(node.folders);
    }
  };
  walk(tree);
  return out;
}

export type FolderRow<T> = { kind: "folder"; node: FolderNode<T>; expanded: boolean } | { kind: "item"; item: T; depth: number; folder: string };

/** 表格／清單用的攤平列：資料夾列後面接它的項目，再接子資料夾；收合的資料夾不輸出後代。 */
export function flattenFolderTree<T>(tree: readonly FolderNode<T>[], collapsed: ReadonlySet<string>): FolderRow<T>[] {
  const rows: FolderRow<T>[] = [];
  const walk = (list: readonly FolderNode<T>[]) => {
    for (const node of list) {
      const expanded = !collapsed.has(node.path);
      rows.push({ kind: "folder", node, expanded });
      if (!expanded) continue;
      for (const item of node.items) rows.push({ kind: "item", item, depth: node.depth + 1, folder: node.path });
      walk(node.folders);
    }
  };
  walk(tree);
  return rows;
}

/** 資料夾輸入的建議清單：這些 instance 目前所在的資料夾（含上層），依畫面順序。 */
export function folderSuggestions(descriptors: readonly FolderSource[]): string[] {
  const paths = new Set<string>();
  for (const descriptor of descriptors) for (const ancestor of folderAncestors(folderOf(descriptor))) paths.add(ancestor);
  return [...paths].sort((a, b) => {
    // 依樹的深度優先順序：逐層比較祖先。
    const left = folderAncestors(a);
    const right = folderAncestors(b);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const order = compareFolderPaths(left[index] ?? "", right[index] ?? "");
      if (order !== 0) return order;
    }
    return left.length - right.length;
  });
}
