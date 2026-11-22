// Rules learned from generated takes:
// - a one-take shot written with timestamps or Shot numbers tends to hard-cut;
// - a style reference image that shows a character carries its pose, props and figures into the take;
// - wings written as flapping (also in the sound) deform on the downstroke; spread, steady and gliding wings hold.
// Each is a warning with what to write instead; only the one-take rule has a fix (removing the markers is exact).
import { scanPrompt, sectionOf, type PromptScan } from "../parse";
import type { Finding, FindingFix, TextRange } from "../types";
import { excerpt, finding, listSome, type RuleContext } from "./context";
import { t } from "@/i18n";

const ONE_TAKE =
  /\bsingle (?:continuous )?(?:camera move|shot|take)\b|\bone[- ](?:take|shot|continuous shot)\b|\bcontinuous (?:take|shot|camera move)\b|\bwithout (?:a |any )?cuts?\b|\bno cuts?\b|\buncut\b|\bunbroken (?:shot|take)\b|一鏡到底|一鏡完成|長鏡頭|不切鏡|沒有切鏡|不剪接|ワンカット|長回し/i; // i18n-ignore: matching words
const TIMESTAMP = /(?:\bAt\s+)?\b\d{1,2}:\d{2}(?:[.,]\d{1,3})?\b(?:\s*[-–]\s*\d{1,2}:\d{2}(?:[.,]\d{1,3})?\b)?,?\s*/g;
const STYLE_REFERENCE = /\b(?:art|visual|painting|drawing)?\s*style (?:reference|plate|guide)\b|\bstyle plate\b|\bfollows? its (?:art )?style\b|畫風參考|風格參考|畫風圖|スタイル参照|画風参照/i; // i18n-ignore: matching words
const CHARACTER =
  /<Subject \d+>|\b(?:girl|boy|man|woman|men|women|child|kid|character|characters|person|people|figure|figures|warrior|hero|heroine|fighter|knight|samurai)\b|角色|人物|女孩|男孩|少女|少年|女生|男生|主角|キャラクター/i; // i18n-ignore: matching words
const FLAPPING =
  /\bflap(?:s|ped|ping)?\b|\bwing ?beats?\b|\bwings? (?:beat|beats|beating|pump|pumping)\b|\bbeat(?:s|ing)? (?:its|her|his|their|the|both) wings\b|拍翅|振翅|拍打翅膀|拍動翅膀|搧動翅膀|扇動翅膀|揮動翅膀|羽ばたき|羽ばたく/gi; // i18n-ignore: matching words
const MENTION = /@Image\d+/g;

/** The `[Shot n]` markers (with their `At …,`) and the loose timestamps of the text, as ranges to remove. */
function timeMarkers(text: string, scan: PromptScan): TextRange[] {
  const ranges: TextRange[] = scan.shots.map((shot) => ({ start: shot.start, end: shot.end }));
  for (const match of text.matchAll(TIMESTAMP)) {
    const start = match.index;
    if (!ranges.some((range) => start >= range.start && start < range.end)) ranges.push({ start, end: start + match[0].length });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** The one-take fix: drop every Shot marker and timestamp, then tidy the spaces they leave. Applying it twice is the same. */
export function removeTimeMarkers(text: string, ranges: readonly TextRange[]): string {
  let out = "";
  let at = 0;
  for (const range of ranges) {
    if (range.start < at) continue;
    out += text.slice(at, range.start);
    at = range.end;
  }
  out += text.slice(at);
  return out.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+(?=\S)/gm, "");
}

const ONE_TAKE_FIX: FindingFix = {
  label: t("刪掉時間戳與 Shot 編號"),
  apply: (text) => removeTimeMarkers(text, timeMarkers(text, scanPrompt(text))),
};

/** The line (or the sentence of a long line) around `offset`. */
function lineAround(text: string, offset: number): { start: number; text: string } {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const endAt = text.indexOf("\n", offset);
  const end = endAt === -1 ? text.length : endAt;
  return { start, text: text.slice(start, end) };
}

/** `@ImageN` names that define a `<Subject n>` (the image is a character reference). */
function characterImages(ctx: RuleContext): Set<string> {
  const out = new Set<string>();
  const definitions = sectionOf(ctx.scan, "subject_definitions");
  const text = definitions ? ctx.text.slice(definitions.bodyStart, definitions.end) : "";
  for (const line of text.split("\n")) {
    if (!/<Subject \d+>/.test(line)) continue;
    for (const match of line.matchAll(MENTION)) out.add(match[0]);
  }
  return out;
}

export function measuredRules(ctx: RuleContext): Finding[] {
  const out: Finding[] = [];
  const oneTake = ONE_TAKE.exec(ctx.text);
  const markers = oneTake ? timeMarkers(ctx.text, ctx.scan) : [];
  const firstMarker = markers[0];
  if (oneTake && firstMarker) {
    out.push(
      finding("timeline.one-take-markers", {
        title: t("一鏡到底的鏡頭寫了時間戳或 Shot 編號：{text}", { text: excerpt(ctx.text.slice(firstMarker.start, firstMarker.end), 20) }),
        detail: t(
          "刪掉時間戳（At 00:03.000）和 [Shot n] 編號，改成一整句連續的運鏡：The whole sequence is a single continuous camera move from start to end: the camera starts …, and as the camera keeps moving, …, and, without stopping, …。寫了時間戳的一鏡到底，6 支有 5 支被硬切成好幾個鏡頭；改寫後 86 支只有 1 支。",
        ),
        range: firstMarker,
        fix: ONE_TAKE_FIX,
      }),
    );
  }

  const characters = characterImages(ctx);
  const plates: { name: string; range: TextRange }[] = [];
  for (const match of ctx.text.matchAll(MENTION)) {
    const line = lineAround(ctx.text, match.index);
    if (!STYLE_REFERENCE.test(line.text)) continue;
    const rest = line.text.replace(match[0], "");
    if (CHARACTER.test(rest) || characters.has(match[0])) plates.push({ name: match[0], range: { start: match.index, end: match.index + match[0].length } });
  }
  const firstPlate = plates[0];
  if (firstPlate) {
    out.push(
      finding("ref.style-plate-character", {
        title: t("畫風參考圖不只有風景：{names}", { names: listSome(plates.map((item) => item.name)) }),
        detail: t(
          "畫風參考（Style Plate）只放沒有人物的風景圖，參考行寫「{name} is the art style reference: the whole clip follows its art style …」，不要寫它畫了哪個角色；角色另外用自己的參考圖。畫了角色的畫風圖，姿勢、手上的道具、構圖和人物會被照搬到成品裡（25 支有 5 支），只有風景時 43 支都沒有。",
          { name: firstPlate.name },
        ),
        range: firstPlate.range,
      }),
    );
  }

  const flaps = [...ctx.text.matchAll(FLAPPING)];
  const firstFlap = flaps[0];
  if (firstFlap) {
    out.push(
      finding("wording.wing-flapping", {
        title: t("寫了拍翅：{terms}", { terms: listSome(flaps.map((match) => match[0])) }),
        detail: t(
          "翅膀改寫成張開、穩定、滑翔，例如 Her wings stay fully spread and steady the whole time as she glides；翅膀在背面時加上 both wings clearly visible。聲音欄位也不要寫 wings beating，改寫風聲。寫了拍翅的鏡頭，每次下拍翅膀都會變成布料或手臂的形狀。",
        ),
        range: { start: firstFlap.index, end: firstFlap.index + firstFlap[0].length },
      }),
    );
  }
  return out;
}
