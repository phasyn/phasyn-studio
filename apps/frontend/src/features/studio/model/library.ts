// 專案素材庫的移除（純函式）：一個素材在專案裡被哪些地方使用，以及把它從素材庫拿掉。
// 素材庫由 Video Studio 與 Image Studio 共用。還在使用的素材不能移除：移除不替使用者改鏡頭設定（不拿掉參考、不把首幀
// 改成不使用），也不留下找不到檔案的參考，要先在使用它的鏡頭拿掉。時間軸上的片段也算使用：主控接受拿掉素材的專案文件，
// 時間軸來源會留著失去素材庫連結的 library_id，所以在這裡擋下，要先在時間軸刪除那些片段。一鍵換角的來源影片帶著換角工作的設定，也不能移除
// （這一項由呼叫端傳入 swapSourceId；reducer 只看鏡頭的使用）。
// 移除只改專案文件、不刪除檔案：已渲染的 take（記著自己送出的檔案）、run 紀錄與其他專案照常使用那個檔案。
import type { Asset, StudioExport, StudioLibraryItem, StudioProject, StudioShot, StudioTake } from "@/api/generated/contracts";
import { firstFrameItemId } from "./continuity";
import { t } from "@/i18n";

/** 素材的一個使用處；index＝影片鏡頭（或 Image Studio 圖片）在清單中的位置（從 0 起）。 */
export type LibraryUse =
  /** 影片鏡頭的參考素材（同一個檔案可以用幾個 @ 名稱加入同一個鏡頭）。 */
  | { kind: "reference"; shotId: string; index: number; title: string; aliases: string[] }
  /** 影片鏡頭以這張圖片當首幀（fl2va）。 */
  | { kind: "first_frame"; shotId: string; index: number; title: string }
  | { kind: "previs"; shotId: string; index: number; title: string }
  /** Image Studio 圖片的參考圖。 */
  | { kind: "image_reference"; shotId: string; index: number; title: string }
  /** Image Studio 圖片的遮罩。 */
  | { kind: "image_mask"; shotId: string; index: number; title: string }
  /** 一鍵換角的來源影片：素材的 note 帶著換角工作的設定，匯出時的原音軌也從它取。 */
  | { kind: "swap_source" }
  /** 專案時間軸上播放這個素材的片段（clips＝片段數，停用的片段也算：它們仍留在文件裡）。 */
  | { kind: "timeline"; clips: number };

/** 列表用的穩定 key（同一種使用、同一個鏡頭只出現一次）。 */
export function libraryUseKey(use: LibraryUse): string {
  return "shotId" in use ? `${use.kind}:${use.shotId}` : use.kind;
}

/**
 * 時間軸上每個素材（item_id）的片段數：片段的來源記著這個素材（library_id），或是不跟著鏡頭的來源剛好用著素材的檔案
 * （同一個 node_id＋file_id；舊文件的來源可能沒有 library_id）。
 */
function timelineClipCounts(project: StudioProject): Map<string, number> {
  const counts = new Map<string, number>();
  const timeline = project.timeline;
  const library = project.library ?? [];
  if (!timeline || library.length === 0) return counts;
  const known = new Set(library.map((item) => item.item_id));
  const byFile = new Map(library.map((item) => [`${item.file.node_id}/${item.file.file_id}`, item.item_id]));
  const itemOfSource = new Map<string, string>();
  for (const source of timeline.sources) {
    const linked = source.library_id !== undefined && known.has(source.library_id) ? source.library_id : undefined;
    const byItsFile = source.shot_id === undefined && source.file !== null ? byFile.get(`${source.file.node_id}/${source.file.file_id}`) : undefined;
    const itemId = linked ?? byItsFile;
    if (itemId !== undefined) itemOfSource.set(source.source_id, itemId);
  }
  for (const clip of timeline.clips) {
    const itemId = itemOfSource.get(clip.source_id);
    if (itemId !== undefined) counts.set(itemId, (counts.get(itemId) ?? 0) + 1);
  }
  return counts;
}

/**
 * 每個素材（item_id）在專案裡的使用處，一次走過整個專案：影片鏡頭（依鏡頭順序，同一個鏡頭的參考在首幀之前）→
 * Image Studio 圖片 → 一鍵換角的來源影片（swapSourceId＝換角工作的來源影片 item_id，不是換角專案時 null）→ 時間軸上的片段。
 * 沒有出現在結果裡的素材沒有地方使用，可以移除。
 */
export function libraryUses(project: StudioProject, swapSourceId: string | null = null): Map<string, LibraryUse[]> {
  const uses = new Map<string, LibraryUse[]>();
  const add = (itemId: string, use: LibraryUse) => {
    const list = uses.get(itemId);
    if (list) list.push(use);
    else uses.set(itemId, [use]);
  };
  project.shots.forEach((shot, index) => {
    const aliases = new Map<string, string[]>();
    for (const ref of shot.references ?? []) aliases.set(ref.item_id, [...(aliases.get(ref.item_id) ?? []), `@${ref.alias}`]);
    for (const [itemId, list] of aliases) add(itemId, { kind: "reference", shotId: shot.shot_id, index, title: shot.title, aliases: list });
    for (const itemId of new Set(shot.previs?.layers.map((layer) => layer.item_id))) {
      if ((itemId != null && itemId !== "")) add(itemId, { kind: "previs", shotId: shot.shot_id, index, title: shot.title });
    }
    const frame = firstFrameItemId(shot);
    if (frame !== null) add(frame, { kind: "first_frame", shotId: shot.shot_id, index, title: shot.title });
  });
  (project.image_shots ?? []).forEach((shot, index) => {
    for (const itemId of new Set(shot.references.map((ref) => ref.item_id))) add(itemId, { kind: "image_reference", shotId: shot.image_shot_id, index, title: shot.title });
    if (shot.mask_item_id !== null) add(shot.mask_item_id, { kind: "image_mask", shotId: shot.image_shot_id, index, title: shot.title });
  });
  if (swapSourceId !== null) add(swapSourceId, { kind: "swap_source" });
  for (const [itemId, clips] of timelineClipCounts(project)) add(itemId, { kind: "timeline", clips });
  return uses;
}

/** 一個素材的使用處（順序同 libraryUses）；空陣列＝沒有地方使用，可以移除。 */
export function libraryItemUses(project: StudioProject, itemId: string, swapSourceId: string | null = null): LibraryUse[] {
  return libraryUses(project, swapSourceId).get(itemId) ?? [];
}

/**
 * 把素材從素材庫拿掉；Image Studio 的 take 若記著它是由那個 take 加入的（library_item_id），一併清成 null（之後可以再加入）。
 * 素材不存在、或還有影片鏡頭或 Image Studio 圖片使用它時回傳原物件（不留下找不到檔案的參考）。
 */
export function withoutLibraryItem(project: StudioProject, itemId: string): StudioProject {
  const library = project.library ?? [];
  if (!library.some((item) => item.item_id === itemId) || libraryItemUses(project, itemId).length > 0) return project;
  const next: StudioProject = { ...project, library: library.filter((item) => item.item_id !== itemId) };
  const linked = (shot: NonNullable<StudioProject["image_shots"]>[number]) => shot.takes.some((take) => take.library_item_id === itemId);
  if (project.image_shots?.some(linked) === true) {
    next.image_shots = project.image_shots.map((shot) =>
      linked(shot) ? { ...shot, takes: shot.takes.map((take) => (take.library_item_id === itemId ? { ...take, library_item_id: null } : take)) } : shot,
    );
  }
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// 素材庫管理（Asset Library 對話框）：分類、搜尋、排序、改名與備註的規則（純函式）。
// 參考 galgame-editor 的素材庫規則：搜尋詞以空白分開、全部都要符合（AND），比對前做 NFKC＋大小寫折疊；名稱在素材庫內
// 不分大小寫唯一；名稱排序由小到大、大小與時間由大到小，同值依 item_id；衍生項目（Image Studio 遮罩）不列出；
// 還在使用的素材不能移除（withoutLibraryItem）。

export type LibraryKindFilter = "all" | StudioLibraryItem["kind"];
export type LibraryUsageFilter = "all" | "used" | "unused";
export type LibrarySortKey = "name" | "created" | "size" | "duration";

export const LIBRARY_SORT_KEYS: readonly LibrarySortKey[] = ["name", "created", "size", "duration"];
/** 契約上限（StudioLibraryItem.name／note）。 */
export const LIBRARY_NAME_MAX = 200;
export const LIBRARY_NOTE_MAX = 2000;

/** 搜尋與名稱比對用的折疊（NFKC＋小寫）：全形英數、大小寫視為相同。 */
export function libraryFold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** 搜尋詞（空白分開、去掉重複）；空字串＝沒有搜尋。 */
export function librarySearchTerms(query: string): string[] {
  return [...new Set(libraryFold(query).split(/\s+/).filter(Boolean))];
}

/** 素材是否符合全部搜尋詞（比對名稱、備註、類型與 item_id）。 */
export function libraryMatches(item: StudioLibraryItem, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const text = libraryFold(`${item.name}\n${item.note ?? ""}\n${item.kind}\n${item.item_id}`);
  return terms.every((term) => text.includes(term));
}

/**
 * 素材的使用處數（同一個鏡頭同時當參考與首幀只算一次；Image Studio 圖片分開算；一鍵換角與時間軸各算一處）。
 */
export function libraryUseCount(uses: readonly LibraryUse[]): number {
  return new Set(uses.map((use) => ("shotId" in use ? `${use.kind.startsWith("image_") ? "image" : "video"}:${use.shotId}` : use.kind))).size;
}

export interface LibraryFilter {
  kind: LibraryKindFilter;
  usage: LibraryUsageFilter;
  query: string;
}

/** 依類型、使用狀態與搜尋詞篩選（順序不變）。 */
export function filterLibrary<T extends StudioLibraryItem>(items: readonly T[], filter: LibraryFilter, uses: ReadonlyMap<string, readonly LibraryUse[]>): T[] {
  const terms = librarySearchTerms(filter.query);
  return items.filter((item) => {
    if (filter.kind !== "all" && item.kind !== filter.kind) return false;
    if (filter.usage !== "all" && (uses.has(item.item_id) ? "used" : "unused") !== filter.usage) return false;
    return libraryMatches(item, terms);
  });
}

/** 預設方向：名稱由小到大，建立時間、大小與長度由大到小。 */
export function defaultSortDescending(key: LibrarySortKey): boolean {
  return key !== "name";
}

function sortValue(item: StudioLibraryItem, key: LibrarySortKey): string | number | null {
  switch (key) {
    case "name":
      return libraryFold(item.name);
    case "created":
      return item.created_at;
    case "size":
      return item.file.size_bytes;
    case "duration":
      return item.duration_seconds;
  }
}

/** 排序；沒有值的（圖片沒有長度）不論方向都排在最後；同值依 item_id（與方向相同）。 */
export function sortLibrary<T extends StudioLibraryItem>(items: readonly T[], key: LibrarySortKey, descending: boolean): T[] {
  const direction = descending ? -1 : 1;
  const compare = (a: string | number, b: string | number) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));
  return [...items].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
    } else {
      const order = compare(left, right);
      if (order !== 0) return order * direction;
    }
    return a.item_id.localeCompare(b.item_id) * direction;
  });
}

/** 改名的問題（可以改名＝null）：不能空白、不能超過上限、素材庫內（不分大小寫）不能重名。 */
export function libraryRenameProblem(library: readonly StudioLibraryItem[], itemId: string, name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t("名稱不能空白");
  if (trimmed.length > LIBRARY_NAME_MAX) return t("名稱最多 {max} 個字元", { max: LIBRARY_NAME_MAX });
  const key = libraryFold(trimmed);
  const clash = library.find((item) => item.item_id !== itemId && libraryFold(item.name.trim()) === key);
  return clash ? t("素材庫已經有「{name}」（名稱不分大小寫）", { name: clash.name }) : null;
}

/** 改一個素材的名稱或備註（找不到 → 原陣列）；note 空字串＝拿掉備註。 */
export function withLibraryItemPatch(library: readonly StudioLibraryItem[], itemId: string, patch: { name?: string; note?: string }): StudioLibraryItem[] {
  const index = library.findIndex((item) => item.item_id === itemId);
  const current = library[index];
  if (!current) return [...library];
  const next: StudioLibraryItem = { ...current };
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.note !== undefined) {
    if (patch.note.trim()) next.note = patch.note;
    else delete next.note;
  }
  return library.map((item, at) => (at === index ? next : item));
}

// ---------------------------------------------------------------------------------------------------------------
// 素材庫的「渲染結果」與「匯出成片」（純函式）：專案渲染成功、有檔案的 take 與序列匯出。它們不是素材庫項目
// （不在 project.library）：素材庫的改名、備註與移除不適用；這裡只列出、搜尋與排序。

/** 一個渲染成品：take（鏡頭的一次渲染）或序列匯出。id 加上前綴，不會與素材 item_id 或彼此相撞。 */
export type RenderEntry =
  | { kind: "take"; id: string; shot: StudioShot; shotIndex: number; take: StudioTake; takeNumber: number; active: boolean; asset: Asset; createdAt: string; durationSeconds: number | null }
  | { kind: "export"; id: string; record: StudioExport; exportNumber: number; asset: Asset; createdAt: string; durationSeconds: number | null };

export type RenderSection = "takes" | "exports";

export const takeEntryId = (takeId: string) => `take:${takeId}`;
export const exportEntryId = (exportId: string) => `export:${exportId}`;

/** 資產的長度（秒）：資產記著自己的 fps 時用它，否則用專案的 fps；沒有影格數＝未知。 */
function assetSeconds(asset: Asset, fallbackFps: number): number | null {
  const fps = asset.fps && asset.fps.den > 0 ? asset.fps.num / asset.fps.den : fallbackFps;
  return asset.frame_count > 0 && fps > 0 ? asset.frame_count / fps : null;
}

/**
 * 專案中渲染成功且有檔案的 take（依鏡頭順序，鏡頭內依 take 順序）；active＝鏡頭使用中的 take（activeOf＝model/project 的
 * activeTake，由呼叫端傳入：project.ts 已經匯入這個模組，反過來匯入會形成循環）。
 */
export function projectTakeEntries(project: StudioProject, activeOf: (shot: StudioShot) => StudioTake | null): RenderEntry[] {
  const fps = project.format.fps.den > 0 ? project.format.fps.num / project.format.fps.den : 24;
  const entries: RenderEntry[] = [];
  project.shots.forEach((shot, shotIndex) => {
    const chosen = activeOf(shot);
    shot.takes.forEach((take, index) => {
      if (take.state !== "succeeded" || !take.asset) return;
      entries.push({
        kind: "take",
        id: takeEntryId(take.take_id),
        shot,
        shotIndex,
        take,
        takeNumber: index + 1,
        active: chosen?.take_id === take.take_id,
        asset: take.asset,
        createdAt: take.created_at,
        durationSeconds: assetSeconds(take.asset, fps),
      });
    });
  });
  return entries;
}

/** 專案中成功且有檔案的序列匯出（exportNumber＝第幾次匯出，從 1 起，依 exports 順序）。 */
export function projectExportEntries(project: StudioProject): RenderEntry[] {
  const fps = project.format.fps.den > 0 ? project.format.fps.num / project.format.fps.den : 24;
  const entries: RenderEntry[] = [];
  project.exports.forEach((record, index) => {
    if (record.state !== "succeeded" || !record.asset) return;
    entries.push({ kind: "export", id: exportEntryId(record.export_id), record, exportNumber: index + 1, asset: record.asset, createdAt: record.created_at, durationSeconds: assetSeconds(record.asset, fps) });
  });
  return entries;
}

/** 顯示名稱：「<鏡頭標題> take 2」或「匯出 3」。 */
export function renderEntryName(entry: RenderEntry): string {
  return entry.kind === "take" ? t("{title} take {take}", { title: entry.shot.title || t("未命名鏡頭"), take: entry.takeNumber }) : t("匯出 {number}", { number: entry.exportNumber });
}

/** 是否符合全部搜尋詞（take：名稱、prompt、seed、路由、run 與 take id；匯出：名稱、run 與 export id）。 */
export function renderMatches(entry: RenderEntry, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const fields =
    entry.kind === "take"
      ? [renderEntryName(entry), entry.take.prompt, entry.take.seed === null ? "" : `seed ${String(entry.take.seed)}`, entry.take.route, entry.take.run_id, entry.take.take_id]
      : [renderEntryName(entry), entry.record.run_id, entry.record.export_id];
  const text = libraryFold(fields.join("\n"));
  return terms.every((term) => text.includes(term));
}

/** 依鏡頭（take；null＝全部鏡頭）與搜尋詞篩選（順序不變）。 */
export function filterRenders(entries: readonly RenderEntry[], query: string, shotId: string | null): RenderEntry[] {
  const terms = librarySearchTerms(query);
  return entries.filter((entry) => (shotId === null || (entry.kind === "take" && entry.shot.shot_id === shotId)) && renderMatches(entry, terms));
}

function renderSortValue(entry: RenderEntry, key: LibrarySortKey): string | number | null {
  switch (key) {
    case "name":
      return libraryFold(renderEntryName(entry));
    case "created":
      return entry.createdAt;
    case "size":
      return entry.asset.file.size_bytes;
    case "duration":
      return entry.durationSeconds;
  }
}

/** 與 sortLibrary 相同的規則：沒有值的排在最後；同值依 id。名稱排序時同一個鏡頭的 take 依編號（take 10 在 take 9 之後）。 */
export function sortRenders(entries: readonly RenderEntry[], key: LibrarySortKey, descending: boolean): RenderEntry[] {
  const direction = descending ? -1 : 1;
  return [...entries].sort((a, b) => {
    const left = renderSortValue(a, key);
    const right = renderSortValue(b, key);
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
    } else {
      const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true });
      if (order !== 0) return order * direction;
    }
    return a.id.localeCompare(b.id) * direction;
  });
}
