// 「從其他專案加入」的規則：同一個檔案的判斷、另一個專案可以拿來加入的素材、勾選的範圍、加入時的複本與磚的版面（純函式；
// 只有 importedCopies 取現在的時間與新的 item_id）。
// 素材庫項目只是檔案的參照：檔案在主控／Node 的檔案庫，主控保留任何專案素材庫引用的檔案（刪除 run 時也不刪），所以把參照
// 複製進這個專案就能直接使用，不必重新上傳。
import type { FileRef, StudioLibraryItem, StudioProjectSummary } from "@/api/generated/contracts";
import { libraryFold, librarySearchTerms } from "../../model/library";
import { newLocalId } from "../../references/ids";
import { videoLibrary } from "../../references/materials";
import { parseJobNote } from "../../swap/job";

/** 同一個檔案＝同一個 node_id＋file_id（不分大小寫，與主控保留素材庫檔案時的比對相同）。 */
function fileKey(file: Pick<FileRef, "node_id" | "file_id">): string {
  return `${file.node_id.toLowerCase()}/${file.file_id.toLowerCase()}`;
}

/** 素材庫的素材，依檔案（node_id＋file_id）與依內容（sha256，小寫；沒有 sha256 的不在裡面）索引。 */
export interface LibraryFiles {
  byFile: ReadonlyMap<string, StudioLibraryItem>;
  byContent: ReadonlyMap<string, StudioLibraryItem>;
}

/**
 * 素材庫裡每個檔案對應的素材（同一個檔案有幾個時取第一個）。包含 Image Studio 的遮罩：檔案已經在這個專案，就不再加一次。
 * 也依內容索引：同一張圖下載後再上傳會拿到新的 file_id，內容（sha256）相同就是同一份素材。
 */
export function libraryFiles(library: readonly StudioLibraryItem[]): LibraryFiles {
  const byFile = new Map<string, StudioLibraryItem>();
  const byContent = new Map<string, StudioLibraryItem>();
  for (const item of library) {
    const key = fileKey(item.file);
    if (!byFile.has(key)) byFile.set(key, item);
    const content = item.file.sha256.toLowerCase();
    if (content !== "" && !byContent.has(content)) byContent.set(content, item);
  }
  return { byFile, byContent };
}

/** 這個素材庫裡已經有的同一個檔案或同樣內容的素材；沒有 → null。 */
export function existingItem(files: LibraryFiles, item: Pick<StudioLibraryItem, "file">): StudioLibraryItem | null {
  // An empty sha256 finds nothing by content: byContent has no entry for it
  return files.byFile.get(fileKey(item.file)) ?? files.byContent.get(item.file.sha256.toLowerCase()) ?? null;
}

/**
 * 另一個專案可以拿來加入的素材：與那個專案的素材庫列出的相同（Image Studio 的遮罩只在 Image Studio 使用，不列出），
 * 同一個檔案只列一次，最新加入的在前。
 */
export function sourceItems(library: readonly StudioLibraryItem[]): StudioLibraryItem[] {
  const seen = new Set<string>();
  const items: StudioLibraryItem[] = [];
  for (const item of videoLibrary(library)) {
    const key = fileKey(item.file);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.item_id.localeCompare(b.item_id));
}

/** 專案名稱或 ID 是否符合全部搜尋詞（與素材庫的搜尋相同：空白分開、NFKC＋大小寫折疊）。 */
export function projectMatches(summary: StudioProjectSummary, query: string): boolean {
  const terms = librarySearchTerms(query);
  if (terms.length === 0) return true;
  const text = libraryFold(`${summary.title}\n${summary.project_id}`);
  return terms.every((term) => text.includes(term));
}

/**
 * Shift＋點一下（或 Shift＋空白鍵）：從錨點到 id 的每個可以勾選的素材都設成 checked（勾選或取消一整段，跟著這一下的新狀態）。
 * order＝畫面上的順序（篩選後）；錨點不在畫面上時只改 id 本身。
 */
export function checkRange(selected: ReadonlySet<string>, order: readonly string[], anchor: string | null, id: string, checked: boolean, selectable: (itemId: string) => boolean): Set<string> {
  const to = order.indexOf(id);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const range = to < 0 ? [] : from < 0 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
  const next = new Set(selected);
  for (const itemId of range) {
    if (!selectable(itemId)) continue;
    if (checked) next.add(itemId);
    else next.delete(itemId);
  }
  return next;
}

/**
 * 加入這個專案的複本：新的 item_id、同一個檔案參照、名稱與媒體資訊；加入時間是 addedAt。
 * 備註只帶使用者寫的：一鍵換角來源影片的備註是那個專案的換角工作設定，帶過來會讓這個專案被當成換角專案。
 * 來源（Image Studio 的某個 take）指向那個專案的圖片，在這裡不成立，所以不帶（沒有來源＝一般的參考素材）。
 */
function importedCopy(item: StudioLibraryItem, itemId: string, addedAt: string): StudioLibraryItem {
  const copy: StudioLibraryItem = {
    item_id: itemId,
    kind: item.kind,
    name: item.name,
    // A deep copy: the project document never shares objects with the cached document of the other project
    file: structuredClone(item.file),
    created_at: addedAt,
    duration_seconds: item.duration_seconds,
    width: item.width,
    height: item.height,
    has_audio: item.has_audio,
  };
  if (item.note && parseJobNote(item.note) === null) copy.note = item.note;
  return copy;
}

/**
 * 要加入的複本（依 items 的順序）：每個一個新的 item_id（與上傳相同的 newLocalId("lib")）。加入時間是現在、彼此差 1 ms，
 * 越前面的越新：依「加入時間」排序時，複本保持 items 的先後（來源最新加入的在前）。
 */
export function importedCopies(items: readonly StudioLibraryItem[]): StudioLibraryItem[] {
  const base = Date.now();
  return items.map((item, index) => importedCopy(item, newLocalId("lib"), new Date(base + items.length - 1 - index).toISOString()));
}

/**
 * 磚之間的間距、格子的內距、磚的外框（1 px border＋6 px padding，兩邊合計 14）與縮圖下兩行文字的高度（px）：
 * 4 px 間距＋名稱一行 18（text-caption）＋4 px 間距＋媒體資訊一行 16（leading-4）＝42。磚至少 MIN_TILE 寬。
 */
const GRID_GAP = 12;
const GRID_PAD = 12;
const TILE_CHROME = 14;
const TILE_CAPTION = 42;
const MIN_TILE = 150;

export interface TileLayout {
  columns: number;
  thumbHeight: number;
  tileHeight: number;
  /** 一列的高度（含間距）。 */
  rowHeight: number;
  gap: number;
  pad: number;
}

/** width＝捲動容器的寬度：一列放幾個磚（至少 MIN_TILE 寬），縮圖 16:9。 */
export function tileLayout(width: number): TileLayout {
  const inner = Math.max(0, width - GRID_PAD * 2);
  const columns = Math.max(1, Math.floor((inner + GRID_GAP) / (MIN_TILE + GRID_GAP)));
  const tileWidth = inner > 0 ? (inner - GRID_GAP * (columns - 1)) / columns : MIN_TILE;
  const thumbHeight = Math.max(48, Math.round((tileWidth - TILE_CHROME) * (9 / 16)));
  const tileHeight = thumbHeight + TILE_CHROME + TILE_CAPTION;
  return { columns, thumbHeight, tileHeight, rowHeight: tileHeight + GRID_GAP, gap: GRID_GAP, pad: GRID_PAD };
}
