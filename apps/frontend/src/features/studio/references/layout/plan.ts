// 無看鏡頭版面參考的開關怎麼落到鏡頭上（純函式）。開關沒有自己的狀態：開著＝鏡頭有一個指向片段庫片段的影片參考，而且
// prompt 有那一行版面說明；關掉就把兩者一起拿掉。參考只用片段的前 spanSeconds 秒、不送原聲（不用參考影片的聲音）、不凍結
// 最後一格（凍結會讓結尾變成靜止畫面）；說明句固定（@VideoN 跟著參考換號）。
// 建議：從鏡頭描述讀出景別、動作與角色數，片段庫裡最接近的排第一（只是預選，使用者可以換）。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { newReference } from "../materials";
import { layoutCandidates, type LayoutAction, type LayoutCandidate, type LayoutClip, type LayoutShotSize } from "./library";

/** 版面說明句（H3 的英文 prompt 文字，不翻譯）。 */
export function layoutLine(alias: string): string {
  return `@${alias} is a rough layout reference: follow only its shot order, framing and character positions, and draw every frame fresh with clean, crisp line art and full detail.`;
}

const DETAILED = /^detailed_description:[ \t]*\r?$/m;

/** 把版面說明句加在 detailed_description: 那一行之後（沒有這一行就放最前面、後面空一行）；已經有就不重複。 */
export function withLayoutLine(prompt: string, alias: string): string {
  const line = layoutLine(alias);
  if (prompt.includes(line)) return prompt;
  const marker = DETAILED.exec(prompt);
  if (!marker) return prompt === "" ? line : `${line}\n\n${prompt}`;
  const at = marker.index + marker[0].replace(/\r$/, "").length;
  return `${prompt.slice(0, at)}\n${line}${prompt.slice(at)}`;
}

/** 拿掉版面說明句（連同它的換行；放在最前面時連同後面的空行）。 */
export function withoutLayoutLine(prompt: string, alias: string): string {
  const line = layoutLine(alias);
  if (prompt.startsWith(`${line}\n\n`)) return prompt.slice(line.length + 2);
  return prompt.replace(`\n${line}`, "").replace(line, "");
}

/** 這個鏡頭目前的版面參考：指向片段庫片段、prompt 也有說明句的影片參考；沒有為 null。 */
export function activeLayout(prompt: string, references: readonly StudioReference[], library: readonly StudioLibraryItem[], candidates: readonly LayoutCandidate[] = layoutCandidates(library)): { reference: StudioReference; candidate: LayoutCandidate } | null {
  for (const reference of references) {
    if (reference.kind !== "video" || !prompt.includes(layoutLine(reference.alias))) continue;
    const candidate = candidates.find((entry) => entry.item.item_id === reference.item_id);
    if (candidate) return { reference, candidate };
  }
  return null;
}

/** 參考的結束秒數：片段的 spanSeconds，素材比較短時到結尾。 */
function spanEnd(candidate: LayoutCandidate): number {
  const duration = candidate.item.duration_seconds;
  return duration != null && duration > 0 ? Math.min(candidate.clip.spanSeconds, duration) : candidate.clip.spanSeconds;
}

/** 片段在鏡頭上的參考：前 spanSeconds 秒（素材比較短時用到結尾）、不送原聲、不凍結。超出 H3 的影片數量 → null。 */
export function layoutReference(candidate: LayoutCandidate, references: readonly StudioReference[], refId: string): StudioReference | null {
  const created = newReference(candidate.item, references, refId);
  if (!created) return null;
  const end = spanEnd(candidate);
  return { ...created, start_seconds: 0, end_seconds: end, use_embedded_audio: false, hold_last_frame: false };
}

/** 開：加參考與說明句。 */
export function turnOn(prompt: string, references: readonly StudioReference[], candidate: LayoutCandidate, refId: string): { prompt: string; references: StudioReference[] } | null {
  const reference = layoutReference(candidate, references, refId);
  if (!reference) return null;
  return { prompt: withLayoutLine(prompt, reference.alias), references: [...references, reference] };
}

/** 關：拿掉參考與說明句。 */
export function turnOff(prompt: string, references: readonly StudioReference[], reference: StudioReference): { prompt: string; references: StudioReference[] } {
  return { prompt: withoutLayoutLine(prompt, reference.alias), references: references.filter((ref) => ref.ref_id !== reference.ref_id) };
}

/** 換片段：同一個參考（同一個 @ 名稱）改指向另一段，片段長度跟著換。 */
export function switchClip(references: readonly StudioReference[], reference: StudioReference, candidate: LayoutCandidate): StudioReference[] {
  const end = spanEnd(candidate);
  return references.map((ref) => (ref.ref_id === reference.ref_id ? { ...ref, item_id: candidate.item.item_id, start_seconds: 0, end_seconds: end } : ref));
}

// ---------------------------------------------------------------- 建議

// 比對用的詞（英文 prompt 為主，也認得中文與日文）；不是介面文字。
const SIZE_WORDS: readonly (readonly [LayoutShotSize, RegExp])[] = [
  ["close", /close[- ]?ups?|close shot|\bextreme close|特寫|特写|クローズアップ|アップ/gi], // i18n-ignore
  ["medium", /\bmedium\b|waist[- ]up|over[- ]the[- ]shoulder|\bbust shot|中景|過肩|过肩|半身|バストショット|ミディアム|肩越し/gi], // i18n-ignore
  ["wide", /wide shot|\bwide\b|establishing|long shot|full shot|high angle looks down|\baerial|遠景|远景|全景|大遠景|俯瞰|ロングショット|引きの/gi], // i18n-ignore
];
const ACTION_WORDS: readonly (readonly [LayoutAction, RegExp])[] = [
  ["clash", /\bclash|\bparr(y|ies|ied)|\bblocks?\b|\bstrikes?\b|\bslash|\bswings?\b|\bpunch|\bkicks?\b|\bimpact|point of contact|交鋒|交锋|格擋|格挡|斬|斩|劈|揮|挥|出拳|撞擊|撞击|打ち合|斬り合|激突/gi], // i18n-ignore
  ["charge", /\bcharg|\bdash|\blunge|\bbursts? toward|\brush|\bsprints? (at|toward)|衝|冲|突進|突进|撲向|扑向|飛びかか|突撃/gi], // i18n-ignore
  ["chase", /\bchas|\bpursu|\bruns? after|\bflee|追|逃|追いかけ/gi], // i18n-ignore
  ["faceoff", /face[- ]off|stand[- ]?off|circl(e|es|ing) each other|squar(e|es|ing) off|對峙|对峙|對望|对望|にらみ合|対峙/gi], // i18n-ignore
  ["aftermath", /aftermath|knocked (back|away|into)|\bcrash(es)? into|collaps|dust settles|倒地|餘波|余波|飛出|吹き飛|倒れ/gi], // i18n-ignore
  ["solo_move", /\bwalks?\b|\bruns?\b|\breach(es|ing)? (for|after)|\bfollows?\b|走|跑|伸手|歩く|走る/gi], // i18n-ignore
];
const SUBJECT = /<Subject\s*(\d+)>/g;

function hits(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function strongest<K extends string>(text: string, words: readonly (readonly [K, RegExp])[]): K | null {
  let best: K | null = null;
  let bestCount = 0;
  for (const [key, pattern] of words) {
    const count = hits(text, pattern);
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

export interface ShotReading {
  shotSize: LayoutShotSize | null;
  action: LayoutAction | null;
  /** 描述裡點名的 <Subject N> 個數；沒有點名為 null。 */
  cast: number | null;
}

/** 從鏡頭描述讀出景別、動作與角色數（版面參考只影響前幾秒，所以只讀第一個 [Shot 2] 之前的描述）。 */
export function readShot(prompt: string): ShotReading {
  const detailed = /^detailed_description:[ \t]*$/m.exec(prompt);
  const body = detailed ? prompt.slice(detailed.index) : prompt;
  const cut = /\[Shot\s*2\b/i.exec(body);
  const opening = cut ? body.slice(0, cut.index) : body;
  const subjects = new Set([...prompt.matchAll(SUBJECT)].map((match) => match[1]));
  return { shotSize: strongest(opening, SIZE_WORDS), action: strongest(opening, ACTION_WORDS), cast: subjects.size > 0 ? subjects.size : null };
}

function score(clip: LayoutClip, reading: ShotReading): number {
  return (reading.action === clip.action ? 3 : 0) + (reading.shotSize === clip.shotSize ? 2 : 0) + (reading.cast !== null && Math.min(reading.cast, 2) === clip.cast ? 1 : 0);
}

/** 依鏡頭描述排序的片段（最接近的在前；同分照片段庫順序）與第一名是否真的對上了描述。 */
export function rankCandidates(prompt: string, candidates: readonly LayoutCandidate[]): { ranked: LayoutCandidate[]; suggested: LayoutCandidate | null } {
  const reading = readShot(prompt);
  const ranked = candidates.map((candidate, index) => ({ candidate, index, score: score(candidate.clip, reading) })).sort((a, b) => b.score - a.score || a.index - b.index);
  const first = ranked[0];
  return { ranked: ranked.map((entry) => entry.candidate), suggested: first && first.score > 0 ? first.candidate : null };
}
