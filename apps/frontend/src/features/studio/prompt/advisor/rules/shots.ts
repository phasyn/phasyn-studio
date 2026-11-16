// 鏡頭行（[Shot N]）的三條規則（詞表與比對方式在 ../../shots/wording），在渲染前先提醒：
//  - shot.subject-missing：定義了角色（subject_definitions 以 <Subject N>、@Image 或 <Picture n> 開頭的行），卻沒有任何鏡頭行
//    點名它：列了卻不在這一段的角色，H3 還是會畫出來。
//  - shot.viewpoint：點名 <Subject N> 的鏡頭行沒寫視角：寫得和參考影片相反時，H3 會先照文字畫、再照抄原片那一鏡。
//  - shot.negation：鏡頭行裡的否定詞：被否定的東西反而會被畫出來（no wings → 翅膀）。
// 一個鏡頭是同號的所有段落（同一鏡的幾個時段合在一起）；台詞不算。只在 prompt 有 [Shot N] 行時檢查；「wording.negation」
// 不再重複回報鏡頭行裡的否定寫法（shotRanges）。
import { t } from "@/i18n";
import { negationWord, statedViewpoint } from "../../shots/wording";
import { sectionOf, type Segment } from "../parse";
import type { Finding, TextRange } from "../types";
import { fieldWithKey } from "../words";
import { finding, listSome, type RuleContext } from "./context";
import { leadingLabels } from "./definitions";

const SUBJECT_TAG = /<Subject[ \t]*(\d{1,3})>/g;
const PICTURE_TAG = /<Picture[ \t]*(\d{1,3})>/g;
const IMAGE_MENTION = /@image([1-9][0-9]?)(?![0-9A-Za-z_])/gi;
const LINE_IMAGE = /@Image[1-9][0-9]?(?![0-9A-Za-z_])|<Picture[ \t]*\d{1,3}>/i;
/** 中文的否定寫法（與「wording.negation」相同，加上「沒有」）；英文的否定詞與插件同一份詞表。 */
const CJK_NEGATION = /不要|避免|禁止|不得|請勿|请勿|切勿|不可(?:以)?(?:出現|有)|不能(?:出現|有)|別讓|别让|沒有|没有/g;

interface ShotGroup {
  number: number;
  segments: Segment[];
  /** 各段落的文字，台詞換成等長的空白（位置不變）。 */
  texts: string[];
}

/** 台詞（<d> 到下一個 </d>，沒有 </d> 就到結尾）換成等長的空白，和插件的比對一樣不算台詞。 */
function blankDialogue(text: string): string {
  return text.replace(/<d>[\s\S]*?(?:<\/d>|$)/g, (spoken) => " ".repeat(spoken.length));
}

function shotGroups(ctx: RuleContext): ShotGroup[] {
  const groups = new Map<number, ShotGroup>();
  for (const segment of ctx.scan.segments) {
    if (segment.kind !== "shot" || !segment.shot) continue;
    const number = segment.shot.shot;
    const group = groups.get(number) ?? { number, segments: [], texts: [] };
    group.segments.push(segment);
    group.texts.push(blankDialogue(ctx.text.slice(segment.shot.bracketEnd, segment.end)));
    groups.set(number, group);
  }
  return [...groups.values()];
}

/** 鏡頭行的位置（「wording.negation」略過這些範圍）。 */
export function shotRanges(ctx: RuleContext): TextRange[] {
  return ctx.scan.segments.filter((segment) => segment.kind === "shot").map((segment) => ({ start: segment.start, end: segment.end }));
}

function markerRange(group: ShotGroup): TextRange | null {
  const marker = group.segments[0]?.shot;
  return marker ? { start: marker.start, end: marker.bracketEnd } : null;
}

function numbers(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

/** 這個鏡頭點名的角色與圖片：<Subject n>、<Picture n>，以及 @Image 名稱（換成編譯後的標籤；不知道時用 @ 名稱）。 */
function namedKeys(ctx: RuleContext, group: ShotGroup): Set<string> {
  const keys = new Set<string>();
  for (const text of group.texts) {
    for (const number of numbers(text, SUBJECT_TAG)) keys.add(`<Subject ${number}>`);
    for (const number of numbers(text, PICTURE_TAG)) keys.add(`<Picture ${number}>`);
    for (const number of numbers(text, IMAGE_MENTION)) keys.add(ctx.plan.byAlias.get(`Image${number}`)?.label ?? `@Image${number}`);
  }
  return keys;
}

/** A defined label as namedKeys writes it: <Subject 01> and <Subject 1> are the same subject (compared by number). */
function definedKey(key: string): string {
  const tag = /^<(Subject|Picture)[ \t]*(\d{1,3})>$/.exec(key);
  return tag ? `<${tag[1]} ${Number(tag[2])}>` : key;
}

function subjectRule(ctx: RuleContext, groups: readonly ShotGroup[]): Finding[] {
  const definitions = sectionOf(ctx.scan, "subject_definitions");
  if (!definitions) return [];
  const named = new Set(groups.flatMap((group) => [...namedKeys(ctx, group)]));
  const seen = new Set<string>();
  const missing = leadingLabels(ctx, definitions).filter((label) => {
    const key = definedKey(label.key);
    const visual = key.startsWith("<Subject") || key.startsWith("<Picture") || /^@Image/i.test(label.text);
    if (!visual || seen.has(key)) return false;
    seen.add(key);
    return !named.has(key);
  });
  const first = missing[0];
  if (!first) return [];
  const subjects = listSome(missing.map((label) => label.text));
  const images = [...new Set(missing.flatMap((label) => (label.key.startsWith("<Subject") ? (LINE_IMAGE.exec(label.rest)?.[0] ?? []) : [label.text])))];
  return [
    finding("shot.subject-missing", {
      title: t("{subjects} 沒有出現在任何鏡頭", { subjects }),
      detail: t(
        "在它出現的那一鏡的 [Shot N] 行寫出 {subjects}；這一段沒有它，就刪掉它在{field}的定義，並從「參考」分頁移除它的參考圖{images}。實測：角色段列了、這一段卻沒有的角色，H3 還是會畫出來。",
        { subjects, field: fieldWithKey("subject_definitions"), images: images.length > 0 ? t("（{images}）", { images: listSome(images) }) : "" },
      ),
      range: { start: first.start, end: first.start + first.text.length },
    }),
  ];
}

function viewpointRule(groups: readonly ShotGroup[]): Finding[] {
  const missing = groups.filter((group) => group.texts.some((text) => numbers(text, SUBJECT_TAG).length > 0) && statedViewpoint(group.texts.join("\n")) === null);
  const first = missing[0];
  if (!first) return [];
  const shots = listSome(missing.map((group) => `[Shot ${group.number}]`));
  return [
    finding("shot.viewpoint", {
      title: t("{shots} 沒寫視角", { shots }),
      detail: t(
        "看著參考影片的畫面，為這些鏡頭寫出和原片一致的視角：正面（seen from the front）、側面（seen from the side）、背影（seen from behind）、斜後方、過肩、俯角或仰角；畫面上的每個人物（連遠處的小人也算）都要點名成其中一個角色。工具列的「逐鏡描述」可以邊看參考畫面邊選。實測：原片是背影、鏡頭行卻寫側面時，H3 先照文字畫出側面的新角色，再照抄原片那一鏡；沒有被任何鏡頭點名的人物，會照原片畫出原角色。",
      ),
      range: markerRange(first),
    }),
  ];
}

interface NegationHit {
  start: number;
  end: number;
  /** 顯示用：否定詞和它後面的一個英文字（no wings）。 */
  text: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 一段文字裡的否定寫法：英文用插件的詞表與比對決定有沒有（再找出它的位置），中文另外比對。 */
function negationHits(text: string, offset: number): NegationHit[] {
  const hits: NegationHit[] = [];
  const word = negationWord(text);
  if (word !== null) {
    const source = escapeRegExp(word).replace(/'/g, "['\u2018\u2019]");
    const found = new RegExp(`(?<![A-Za-z0-9_])${source}(?![A-Za-z0-9_])(?:[ \\t]+[A-Za-z][A-Za-z'\u2019-]*)?`, "i").exec(text);
    if (found) hits.push({ start: offset + found.index, end: offset + found.index + found[0].length, text: found[0] });
  }
  for (const match of text.matchAll(CJK_NEGATION)) hits.push({ start: offset + match.index, end: offset + match.index + match[0].length, text: match[0] });
  return hits.sort((a, b) => a.start - b.start);
}

function negationRule(groups: readonly ShotGroup[]): Finding[] {
  const found = groups.flatMap((group) => {
    const hits = group.segments.flatMap((segment, index) => (segment.shot ? negationHits(group.texts[index] ?? "", segment.shot.bracketEnd) : []));
    return hits.length > 0 ? [{ group, hits }] : [];
  });
  const first = found[0]?.hits[0];
  if (!first) return [];
  return [
    finding("shot.negation", {
      title: t("{shots} 有否定詞：{words}", {
        shots: listSome(found.map((item) => `[Shot ${item.group.number}]`)),
        words: listSome(found.flatMap((item) => item.hits.map((hit) => hit.text))),
      }),
      detail: t(
        "改成描述畫面上有的東西，例如把「no wings」改成寫出背上實際有的東西（a bare back with a red ribbon）。實測：鏡頭行裡被否定的東西反而會被畫出來（no wings → 畫出翅膀）；H3 沒有負向 prompt，否定詞和其他文字一樣送給模型。台詞裡的否定詞不算。",
      ),
      range: { start: first.start, end: first.end },
    }),
  ];
}

export function shotRules(ctx: RuleContext): Finding[] {
  const groups = shotGroups(ctx);
  if (groups.length === 0) return [];
  const reference = ctx.mode === "ref2va" || ctx.mode === null;
  return [...(reference ? subjectRule(ctx, groups) : []), ...(reference ? viewpointRule(groups) : []), ...negationRule(groups)];
}
