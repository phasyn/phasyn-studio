// Search over command items: case- and width-insensitive folding, field matching and scoring, ranking, grouping
// and the per-group / total caps. Items are indexed once per data change; each keystroke only folds the query. Pure.
import { GROUP_LABELS, GROUP_ORDER, keywordVariants, type CommandGroup, type CommandItem } from "./items";
import { recentItems, type RecentEntry } from "./recents";

const GROUP_RANK = Object.fromEntries(GROUP_ORDER.map((group, index) => [group, index])) as Record<CommandGroup, number>;

// ── 文字正規化與比對 ──────────────────────────────────────────────────────

const FOLD_CACHE = new Map<string, string>();

/** 逐個 UTF-16 code unit 折疊（NFKC＋小寫，結果須仍是 1 個 code unit），所以比對位置可直接對回原字串。 */
function foldChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code < 0x80) return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch;
  const cached = FOLD_CACHE.get(ch);
  if (cached !== undefined) return cached;
  const normalized = ch.normalize("NFKC").toLowerCase();
  const lower = ch.toLowerCase();
  const folded = normalized.length === 1 ? normalized : lower.length === 1 ? lower : ch;
  FOLD_CACHE.set(ch, folded);
  return folded;
}

/** 不分大小寫、全形半形（ＡＢＣ、（）、＋、全形空白）一致；長度與原字串相同。 */
export function foldText(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) out += foldChar(text.charAt(index));
  return out;
}

const SEPARATOR = /[\s!-/:-@[-`{-~\u00b7\u2010-\u2027\u3000-\u303f\u30fb\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;
const CJK = /[\u2e80-\u2fdf\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f]/u;
const DIGIT = /[0-9]/;
const ASCII_NEEDLE = /^[\x21-\x7e]+$/;

/** 每個位置是否為「詞首」：分隔符之後、CJK 與拉丁字母交界、字母與數字交界、camelCase 大寫。CJK 連續字之間不算詞首。 */
function wordStarts(original: string, folded: string): boolean[] {
  const starts: boolean[] = [];
  for (let index = 0; index < folded.length; index += 1) {
    if (index === 0) {
      starts.push(true);
      continue;
    }
    const previous = folded.charAt(index - 1);
    const current = folded.charAt(index);
    if (SEPARATOR.test(current)) starts.push(false);
    else if (SEPARATOR.test(previous)) starts.push(true);
    else if (CJK.test(previous) !== CJK.test(current)) starts.push(true);
    else if (CJK.test(current)) starts.push(false);
    else if (DIGIT.test(previous) !== DIGIT.test(current)) starts.push(true);
    else {
      const before = original.charAt(index - 1);
      const here = original.charAt(index);
      starts.push(before !== before.toUpperCase() && here !== here.toLowerCase());
    }
  }
  return starts;
}

interface Field {
  folded: string;
  starts: boolean[];
}

function field(text: string): Field {
  const folded = foldText(text);
  return { folded, starts: wordStarts(text, folded) };
}

/**
 * 分數（高者優先）：title／ident 完全相符 100、開頭 90、詞首 80、子字串 60、ASCII 依序子序列 30；
 * 副標題與關鍵字：完全相符或開頭 70、詞首 50、子字串 40（不做子序列，避免長副標題造成雜訊）。
 */
export const SCORES = {
  exact: 100,
  prefix: 90,
  wordStart: 80,
  secondaryPrefix: 70,
  substring: 60,
  secondaryWordStart: 50,
  secondarySubstring: 40,
  subsequence: 30,
} as const;

export type MatchRange = readonly [start: number, end: number];

interface FieldMatch {
  score: number;
  ranges: MatchRange[];
}

function subsequence(haystack: string, needle: string): number[] | null {
  const positions: number[] = [];
  let next = 0;
  for (let index = 0; index < haystack.length && next < needle.length; index += 1) {
    if (haystack.charAt(index) === needle.charAt(next)) {
      positions.push(index);
      next += 1;
    }
  }
  return next === needle.length ? positions : null;
}

function positionsToRanges(positions: readonly number[]): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const position of positions) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === position) ranges[ranges.length - 1] = [last[0], position + 1];
    else ranges.push([position, position + 1]);
  }
  return ranges;
}

function matchField(target: Field, needle: string, primary: boolean): FieldMatch | null {
  const haystack = target.folded;
  if (!needle || !haystack) return null;
  const whole: MatchRange[] = [[0, needle.length]];
  if (haystack === needle) return { score: primary ? SCORES.exact : SCORES.secondaryPrefix, ranges: whole };
  if (haystack.startsWith(needle)) return { score: primary ? SCORES.prefix : SCORES.secondaryPrefix, ranges: whole };
  let first = -1;
  for (let at = haystack.indexOf(needle, 1); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (target.starts[at]) return { score: primary ? SCORES.wordStart : SCORES.secondaryWordStart, ranges: [[at, at + needle.length]] };
    if (first < 0) first = at;
  }
  if (first >= 0) return { score: primary ? SCORES.substring : SCORES.secondarySubstring, ranges: [[first, first + needle.length]] };
  if (primary && needle.length >= 2 && ASCII_NEEDLE.test(needle)) {
    const positions = subsequence(haystack, needle);
    if (positions) return { score: SCORES.subsequence, ranges: positionsToRanges(positions) };
  }
  return null;
}

/** 已預先正規化的項目（隨資料變動重建一次；每次按鍵只正規化查詢字串）。 */
export interface IndexedItem {
  item: CommandItem;
  /** 面板內穩定的序號（option 的 DOM id 用）。 */
  uid: number;
  /** 原始順序（最後的同分排序依據，例如 run 新到舊）。 */
  order: number;
  title: Field;
  ident: Field;
  subtitle: Field | null;
  keywords: Field[];
}

export function indexItems(items: readonly CommandItem[], firstUid = 0): IndexedItem[] {
  return items.map((item, order) => ({
    item,
    uid: firstUid + order,
    order,
    title: field(item.title),
    ident: field(item.ident),
    subtitle: item.subtitle ? field(item.subtitle) : null,
    keywords: keywordVariants(item.keywords).map(field),
  }));
}

interface ItemMatch {
  score: number;
  title: MatchRange[];
  subtitle: MatchRange[];
}

function matchNeedle(entry: IndexedItem, needle: string): ItemMatch | null {
  const title = matchField(entry.title, needle, true);
  const ident = matchField(entry.ident, needle, true);
  const subtitle = entry.subtitle ? matchField(entry.subtitle, needle, false) : null;
  let best = Math.max(title?.score ?? 0, ident?.score ?? 0, subtitle?.score ?? 0);
  for (const keyword of entry.keywords) best = Math.max(best, matchField(keyword, needle, false)?.score ?? 0);
  if (best === 0) return null;
  // 標題只標示連續相符；子序列只有在它就是相符原因時才標示，避免看起來像亂標。
  const showTitle = title !== null && (title.score >= SCORES.substring || title.score === best);
  return { score: best, title: showTitle ? title.ranges : [], subtitle: subtitle?.ranges ?? [] };
}

/** 查詢字串正規化：折疊、空白收斂；超長輸入截斷。 */
export function normalizeQuery(query: string): string {
  return foldText(query.slice(0, 120)).replace(/\s+/g, " ").trim();
}

/** 整句相符優先；多個詞則每個詞都必須相符（AND），分數取最弱的詞。 */
function matchQuery(entry: IndexedItem, needle: string, tokens: readonly string[]): ItemMatch | null {
  const whole = matchNeedle(entry, needle);
  if (tokens.length <= 1) return whole;
  let score = Infinity;
  const title: MatchRange[] = [];
  const subtitle: MatchRange[] = [];
  for (const token of tokens) {
    const match = matchNeedle(entry, token);
    if (!match) return whole;
    score = Math.min(score, match.score);
    title.push(...match.title);
    subtitle.push(...match.subtitle);
  }
  if (whole && whole.score >= score) return whole;
  return { score, title, subtitle };
}

export interface TextSegment {
  text: string;
  match: boolean;
}

/** 依相符範圍切段（範圍會排序、合併並截在字串長度內）。 */
export function segmentText(text: string, ranges: readonly MatchRange[]): TextSegment[] {
  const sorted = ranges
    .map(([start, end]) => [Math.max(0, start), Math.min(text.length, end)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length || segments.length === 0) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

export interface RankedOption {
  item: CommandItem;
  uid: number;
  order: number;
  /** 0＝未搜尋（空查詢的預設清單）。 */
  score: number;
  title: TextSegment[];
  subtitle: TextSegment[] | null;
}

const COLLATOR = new Intl.Collator("zh-Hant-TW", { numeric: true, sensitivity: "base" });

/** 分數高者優先；同分依群組順序、標題，最後保留原始順序。 */
export function compareRanked(a: RankedOption, b: RankedOption): number {
  return (
    b.score - a.score ||
    GROUP_RANK[a.item.group] - GROUP_RANK[b.item.group] ||
    COLLATOR.compare(a.item.title, b.item.title) ||
    a.order - b.order
  );
}

function plainOption(entry: IndexedItem): RankedOption {
  return {
    item: entry.item,
    uid: entry.uid,
    order: entry.order,
    score: 0,
    title: segmentText(entry.item.title, []),
    subtitle: entry.item.subtitle ? segmentText(entry.item.subtitle, []) : null,
  };
}

/** 排序後的相符項目（未分組、未截斷）；空查詢回傳空陣列。 */
export function rankItems(entries: readonly IndexedItem[], query: string): RankedOption[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const tokens = needle.split(" ");
  const ranked: RankedOption[] = [];
  for (const entry of entries) {
    const match = matchQuery(entry, needle, tokens);
    if (!match) continue;
    ranked.push({
      item: entry.item,
      uid: entry.uid,
      order: entry.order,
      score: match.score,
      title: segmentText(entry.item.title, match.title),
      subtitle: entry.item.subtitle ? segmentText(entry.item.subtitle, match.subtitle) : null,
    });
  }
  return ranked.sort(compareRanked);
}

// ── 分組與上限 ─────────────────────────────────────────────────────────────

export interface CommandIndex {
  recent: IndexedItem[];
  live: IndexedItem[];
}

/** 建索引：最近開啟（以目前資料更新標題）＋所有即時項目；uid 在兩者之間不重複。 */
export function buildCommandIndex(items: readonly CommandItem[], recents: readonly RecentEntry[]): CommandIndex {
  const recent = indexItems(recentItems(recents, items));
  return { recent, live: indexItems(items, recent.length) };
}

export interface SearchCaps {
  /** 每個群組最多顯示幾項。 */
  perGroup: number;
  /** 全部最多顯示幾項。 */
  total: number;
  /** 空查詢時顯示幾個元件。 */
  defaultComponents: number;
}

export const DEFAULT_CAPS: SearchCaps = { perGroup: 8, total: 40, defaultComponents: 5 };

export interface CommandSection {
  group: CommandGroup;
  label: string;
  options: RankedOption[];
  /** 此群組相符（或可列出）的總數；大於 options.length 表示被截斷。 */
  total: number;
}

export interface SearchResult {
  /** 正規化後的查詢；空字串＝預設清單。 */
  query: string;
  sections: CommandSection[];
  /** 依顯示順序攤平的選項（鍵盤移動用）。 */
  options: RankedOption[];
  /** 所有群組相符的總數（含被截斷的）。 */
  matched: number;
}

function sectionOf(group: CommandGroup, options: RankedOption[], total: number): CommandSection {
  return { group, label: GROUP_LABELS[group], options, total };
}

/**
 * 空查詢：最近開啟＋全部頁面＋前幾個元件。
 * 有查詢：所有群組一起排序；已出現在「最近開啟」的目的地不在原群組重複；
 * 區段依最佳結果出現的順序排列，每群組與總數各有上限。
 */
export function searchCommands(index: CommandIndex, query: string, caps: SearchCaps = DEFAULT_CAPS): SearchResult {
  const needle = normalizeQuery(query);
  if (!needle) {
    const sections: CommandSection[] = [];
    if (index.recent.length > 0) sections.push(sectionOf("recent", index.recent.map(plainOption), index.recent.length));
    const pages = index.live.filter((entry) => entry.item.group === "page");
    if (pages.length > 0) sections.push(sectionOf("page", pages.map(plainOption), pages.length));
    const components = index.live.filter((entry) => entry.item.group === "component");
    if (components.length > 0) {
      sections.push(sectionOf("component", components.slice(0, caps.defaultComponents).map(plainOption), components.length));
    }
    const options = sections.flatMap((section) => section.options);
    return { query: "", sections, options, matched: options.length };
  }

  const recent = rankItems(index.recent, needle);
  const recentTargets = new Set(recent.map((option) => option.item.to));
  const live = rankItems(index.live, needle).filter((option) => !recentTargets.has(option.item.to));
  const ranked = [...recent, ...live].sort(compareRanked);

  const byGroup = new Map<CommandGroup, CommandSection>();
  let shown = 0;
  for (const option of ranked) {
    let section = byGroup.get(option.item.group);
    if (!section) {
      section = sectionOf(option.item.group, [], 0);
      byGroup.set(option.item.group, section);
    }
    section.total += 1;
    if (section.options.length < caps.perGroup && shown < caps.total) {
      section.options.push(option);
      shown += 1;
    }
  }
  const sections = [...byGroup.values()].filter((section) => section.options.length > 0);
  return { query: needle, sections, options: sections.flatMap((section) => section.options), matched: ranked.length };
}
