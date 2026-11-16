// 換角表的送出前檢查（純函式；CLI 的 swap_cast.py 是同一套規則）。
// 換角表＝素材庫裡一鍵換角寫下的角色附註（「取代：…」「外觀：…」，三種介面語言的標籤都認得）。專案沒有換角表就不檢查。
// 擋下兩種錯：
//   1. prompt 寫「<Subject n> replaces X」，X 不在換角表裡：表外角色不換角，那一段建議剪掉，由使用者決定；
//   2. 「<Subject n> is …外觀… in @ImageK」寫的是表上某個角色的外觀，@ImageK 卻是另一個角色的圖。
// 換角表裡，新角色（外觀相同）已經取代過前面某個原角色的條目，不算獨立的角色：一鍵換角曾讓第三個原角色也對到現有角色
// （例如第三位原角色被對到已經換過的角色），那一條視同表外。名稱用字詞重疊比對（Jaccard ≥ 0.6），之後改寫原角色的叫法
// （blood magic → dark magic）仍然對得上。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { t } from "@/i18n";

const WHO_LABELS = ["取代：", "Replace: ", "差し替え対象："]; // i18n-ignore: labels read back from the swap notes in every UI language
const APPEARANCE_LABELS = ["外觀：", "Appearance: ", "外見："]; // i18n-ignore: labels read back from the swap notes in every UI language
const DETERMINER = /^(the|a|an)\s+/;
/** 外觀比對只看開頭這麼多字元（prompt 裡的外觀可能被截短或接著別的描述）。 */
const APPEARANCE_PREFIX = 60;
const NAME_MATCH = 0.6;
const INDEX_LABEL = /(\d+)\s*$/;
const REPLACES = /<Subject (\d+)> replaces (.+?)(?=,? and <Subject \d+>|\.(?:\s|$)|\n|$)/g;
const DEFINITION = /<Subject (\d+)> is (.+?) in @Image(\d+)\b/g;

export interface SwapCastEntry {
  itemId: string;
  who: string;
  appearance: string;
  /** 這個新角色已經取代過前面條目的原角色。 */
  duplicate: boolean;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.。]+$/u, "").replace(DETERMINER, "");
}

function words(text: string): Set<string> {
  return new Set(text.match(/[a-z0-9]+/g) ?? []);
}

/** 兩個原角色的叫法是否指同一個人（字詞重疊 ≥ NAME_MATCH）。 */
export function sameName(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const word of wa) if (wb.has(word)) shared += 1;
  return shared / new Set([...wa, ...wb]).size >= NAME_MATCH;
}

function labelled(lines: readonly string[], labels: readonly string[]): string | null {
  for (const line of lines) {
    const label = labels.find((prefix) => line.startsWith(prefix));
    if (label) return line.slice(label.length).trim();
  }
  return null;
}

/** 素材庫的換角表：每張帶角色附註的圖片一筆，依角色編號排序。 */
export function swapCast(library: readonly StudioLibraryItem[]): SwapCastEntry[] {
  const found: { index: number; itemId: string; who: string; appearance: string }[] = [];
  for (const item of library) {
    if (item.kind !== "image" || !item.note) continue;
    const lines = item.note.split("\n").map((line: string) => line.trim());
    const who = labelled(lines, WHO_LABELS);
    const appearance = labelled(lines, APPEARANCE_LABELS);
    if (!who || !appearance) continue;
    const index = INDEX_LABEL.exec(lines[0] ?? "");
    found.push({ index: index ? Number(index[1]) : found.length + 1, itemId: item.item_id, who: norm(who), appearance: norm(appearance).slice(0, APPEARANCE_PREFIX) });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  return found.map((entry) => {
    const duplicate = seen.has(entry.appearance);
    seen.add(entry.appearance);
    return { itemId: entry.itemId, who: entry.who, appearance: entry.appearance, duplicate };
  });
}

/** 擋下的原因（空陣列＝可以送出）。prompt 是套用插件後、編譯前的文字（還是 @Image 名稱）。 */
export function swapCastProblems(prompt: string, references: readonly StudioReference[], library: readonly StudioLibraryItem[]): string[] {
  const cast = swapCast(library);
  if (cast.length === 0) return [];
  const problems: string[] = [];
  const own = cast.filter((entry) => !entry.duplicate).map((entry) => entry.who);
  for (const match of prompt.matchAll(REPLACES)) {
    const who = norm(match[2] ?? "");
    if (who && !own.some((name) => sameName(who, name))) {
      problems.push(t("<Subject {n}> 取代的「{who}」不在換角表裡：表外的角色不換角，這一段建議剪掉", { n: match[1] ?? "", who: (match[2] ?? "").trim() }));
    }
  }
  const imageItem = new Map<string, string>();
  for (const ref of references) if (ref.kind === "image" && ref.item_id) imageItem.set(ref.alias, ref.item_id);
  const byItem = new Map(cast.map((entry) => [entry.itemId, entry]));
  for (const match of prompt.matchAll(DEFINITION)) {
    const described = norm(match[2] ?? "");
    const drawn = cast.find((entry) => !entry.duplicate && described.includes(entry.appearance));
    const image = byItem.get(imageItem.get(`Image${match[3] ?? ""}`) ?? "");
    if (drawn && image && drawn.itemId !== image.itemId && drawn.appearance !== image.appearance) {
      problems.push(t("<Subject {n}> 寫的是取代「{drawn}」那個角色的外觀，但 @Image{k} 是取代「{image}」那個角色的圖", { n: match[1] ?? "", drawn: drawn.who, k: match[3] ?? "", image: image.who }));
    }
  }
  return problems;
}
