// 用字規則（多數是製作建議）：抽象品質詞、感受詞、輸出規格字、速度只寫成形容詞、節奏矛盾、括號運鏡指令、
// 一鏡多種運鏡、整份中文、否定寫法（鏡頭行以外；鏡頭行裡的由 shots.ts 的 shot.negation 回報）；以及長度規則（參考素材
// 鏡頭 350–500 字、API 7000 字元、Studio 16384 字元）。
// 「整份中文」的主句說模型怎麼看待中文（可以渲染、官方範例用英文），不把「複製改寫指令」當成主要做法。
import { sectionOf, type Segment } from "../parse";
import { blank, clauses, countCjk, englishWords, mostlyEnglish, proseOnly } from "../text";
import { bracketCameraCommands, bracketCameraToSentences } from "../transforms";
import type { Finding } from "../types";
import { fieldName, fieldWithKey } from "../words";
import { excerpt, finding, listSome, type RuleContext } from "./context";
import { shotRanges } from "./shots";
import { t } from "@/i18n";

const VAGUE_QUALITY =
  /史詩級|史詩般|史詩感|電影感|電影級|大片感|好萊塢大片|超高品質|最高品質|高品質|頂級畫質|極致畫質|超高畫質|高畫質|精美絕倫|絕美|唯美|傑作|神作|\bmasterpiece\b|\bbest quality\b|\bhigh[- ]quality\b|\bhighest quality\b|\bultra[- ]detailed\b|\bhighly detailed\b|\baward[- ]winning\b|\bstunning\b|\bbreathtaking\b|\bbeautiful\b|\bgorgeous\b|\bepic\b/gi;
const FEELING = /壓迫感|衝擊力|衝擊感|情緒張力|高張力|張力|爆發力|打擊感|氣勢|熱血|震撼|高能量|速度感|臨場感|魄力|\bintense\b|\bpowerful\b|\bimpactful\b|\benergetic\b|\badrenaline\b/gi;
const SPEC_TERMS = /(?<![A-Za-z0-9])(?:8K|4K|2K|1080p|720p|2160p|4320p|UHD|HDR)(?![A-Za-z0-9])|(?<![A-Za-z0-9.])\d{2,3}\s?(?:fps|幀\/秒|幀每秒)(?![A-Za-z])|高幀率|超高解析度|高解析度|超高清|超清/gi;
const FAST =
  /超高速|高速度|高速|快速|極快|飛快|急速|迅速|瞬間|全速|疾速|加速|立即|立刻|隨即|lightning[- ]fast|high[- ]speed|full(?: real-time)?[- ]speed|\bfast(?:er|est)?\b|\brapid(?:ly)?\b|\bquick(?:ly)?\b|\bswift(?:ly)?\b|\bblazing\b|\bimmediately\b|\binstantly\b/gi;
const SLOW = /慢動作|慢鏡頭|慢速|緩慢|緩緩|慢慢|凝視|停留|定格|靜止畫面|slow[- ]motion|\bslowly\b|\bslow pan\b|\blingers?\b|\blingering\b|freeze[- ]frame|\bfreezes\b|\bholds? on\b|\bgazes?\b|\bstares?\b/gi;
const CAMERA_WORDS = /鏡頭|攝影機|運鏡|機位|\bcamera\b|\blens\b/i;
const CUT_WORDS = /切換|切鏡|剪接|剪輯|快切|\bcuts?\b|\bediting\b/i;
const MOTION =
  /衝|跑|奔|跳|躍|揮|斬|砍|刺|擊|閃|躲|突進|俯衝|翻|滾|撞|踢|拳|穿|飛|落地|轉|旋身|移|換位|追|撲|擋|拉扯|反彈|纏繞|切割|甩出|步|退|碰|壓|出招|動作|\b(?:sprint|run|dash|leap|jump|swing|slash|strike|stab|dodge|roll|punch|kick|charge|lunge|dive|spin|pivot|race|rush|dart|thrust|block|parr|clash|tackle|sword|blade|spear|fist|feet|foot|step|limb|mov|pass|cross|turn|rebound|sweep|fl[yi]|shoot|slid|fall|land|rise|throw|hit|impact|contact|press|deflect|draw)\w*/i;
const CAMERA_MOVES: readonly (readonly [string, RegExp])[] = [
  ["推近", /推近|推進|推鏡|\bpush(?:es|ing)? in\b|\bdolly(?:ing)? in\b/i],
  ["拉遠", /拉遠|拉開|拉出|\bpull(?:s|ing)? (?:out|back)\b|\bdolly(?:ing)? out\b/i],
  ["變焦", /變焦|\bzoom/i],
  ["搖鏡", /搖鏡|橫搖|左搖|右搖|\bpans?\b|\bpanning\b/i],
  ["俯仰", /俯仰|上搖|下搖|\btilt/i],
  ["平移", /橫移|平移|\btrucks?\b|\btrucking\b/i],
  ["升降", /升降|升鏡|降鏡|\bpedestal|\bcrane/i],
  ["環繞", /環繞|繞拍|弧形運鏡|\barc(?:s|ing)?\b|\borbit/i],
  ["跟拍", /跟拍|跟隨|追蹤|追拍|\btrack(?:s|ing)?\b|\bfollows?\b/i],
  ["手持晃動", /手持|晃動|震動|\bshak(?:e|es|ing)\b|\bhandheld\b/i],
  ["翻滾", /翻滾|旋轉|\brolls?\b/i],
  ["甩鏡", /甩鏡|甩動|急甩|\bwhip/i],
  ["固定", /固定鏡頭|靜止鏡頭|\bstatic\b|\bremains fixed\b/i],
];
const NEGATION = /不要|避免|禁止|不得|請勿|切勿|不可(?:以)?(?:出現|有)|不能(?:出現|有)|別讓|\bavoid(?:s|ing)?\b|\bdo not\b|\bdon't\b|\bno [A-Za-z][A-Za-z-]*(?: [A-Za-z-]+)?,/gi;

/** 畫面描述的文字（不含兩個聲音欄位，避免把「快速鼓點」當成動作速度）；位置不變。 */
function visualText(ctx: RuleContext): string {
  const ranges = ["overall_soundscape", "non_diegetic_music"].flatMap((name) => {
    const section = sectionOf(ctx.scan, name as "overall_soundscape" | "non_diegetic_music");
    return section ? [{ start: section.lineStart, end: section.end }] : [];
  });
  return blank(ctx.text, ranges);
}

function distinctMatches(text: string, pattern: RegExp): { terms: string[]; first: { start: number; end: number } | null } {
  const matches = [...text.matchAll(pattern)];
  const first = matches[0];
  return { terms: [...new Set(matches.map((match) => match[0]))], first: first ? { start: first.index, end: first.index + first[0].length } : null };
}

function vagueRules(ctx: RuleContext): Finding[] {
  const out: Finding[] = [];
  const quality = distinctMatches(ctx.text, VAGUE_QUALITY);
  if (quality.first) {
    out.push(
      finding("wording.vague-quality", {
        title: t("抽象的品質詞：{terms}", { terms: listSome(quality.terms) }),
        detail: t("改寫成看得到、聽得到的內容：構圖、光線、動作的起點與落點、碰撞、運鏡與聲音。這些詞很難從畫面判斷有沒有做到；放在 [Shot 1] 開頭當風格標籤（例如 Live-action, cinematic）是官方範例的寫法。"),
        range: quality.first,
      }),
    );
  }
  const feeling = distinctMatches(ctx.text, FEELING);
  if (feeling.first) {
    out.push(
      finding("wording.abstract-feeling", {
        title: t("畫面上看不出來的感受詞：{terms}", { terms: listSome(feeling.terms) }),
        detail: t("把感受變成看得到的事件：每一鏡寫出誰在哪裡、正在做什麼、動作怎麼發展（開始、碰撞、反應、結束）、什麼時候、從哪裡看、聽到什麼。感受詞可以留著補充氣氛，但不能取代這些事件。"),
        range: feeling.first,
      }),
    );
  }
  const spec = distinctMatches(ctx.text, SPEC_TERMS);
  if (spec.first) {
    out.push(
      finding("wording.spec-terms", {
        title: t("輸出規格寫在 prompt 裡：{terms}", { terms: listSome(spec.terms) }),
        detail: t("這些字不會改變輸出規格，可以刪掉：畫面大小由專案的畫面格式決定，影格率固定每秒 24 格。寫在 prompt 裡只是模型讀到的一般文字。"),
        range: spec.first,
      }),
    );
  }
  return out;
}

interface SpeedHit {
  kind: "camera" | "cut" | "subject" | "generic";
  start: number;
  end: number;
  clause: string;
}

function speedHits(text: string): SpeedHit[] {
  const out: SpeedHit[] = [];
  for (const clause of clauses(text)) {
    for (const match of clause.text.matchAll(FAST)) {
      const kind = CAMERA_WORDS.test(clause.text) ? "camera" : CUT_WORDS.test(clause.text) ? "cut" : MOTION.test(clause.text) ? "subject" : "generic";
      const start = clause.start + match.index;
      out.push({ kind, start, end: start + match[0].length, clause: clause.text });
    }
  }
  return out;
}

function tempoRules(ctx: RuleContext): Finding[] {
  const visual = visualText(ctx);
  const hits = speedHits(visual);
  const out: Finding[] = [];
  const generic = hits.filter((hit) => hit.kind === "generic");
  const subject = hits.filter((hit) => hit.kind === "subject");
  const camera = hits.filter((hit) => hit.kind === "camera");
  const firstGeneric = generic[0];
  if (firstGeneric && (generic.length >= 2 || subject.length === 0)) {
    out.push(
      finding("wording.speed-generic", {
        title: t("{genericCount} 處「快」只是形容詞", { genericCount: generic.length }),
        detail: t(
          "把快拆成三件事寫：人物從哪裡到哪裡、多久接近、碰撞後怎麼立刻反應；鏡頭往哪個方向、多快移動；在哪些時間切到什麼新內容。像「{listSome}」這些速度詞沒有連到看得見的動作。一開場就在動、短促的碰撞、連續的動作與位移參照（掠過柱子、碎石往後飛）能讓速度在畫面上看得出來；這是製作建議，還沒有用生成結果驗證。",
          { listSome: listSome(generic.map((hit) => excerpt(hit.clause, 16)), 3) },
        ),
        range: firstGeneric,
      }),
    );
  }
  const firstCamera = camera[0];
  if (firstCamera && subject.length === 0) {
    out.push(
      finding("wording.speed-camera-only", {
        title: t("只寫了鏡頭快，沒寫人物怎麼快"),
        detail: t("另外寫出人物的位移、出招的時間與碰撞後的動作；鏡頭快不代表人物也快，例如「{clause}」。", { clause: excerpt(firstCamera.clause) }),
        range: firstCamera,
      }),
    );
  }
  const slow = [...visual.matchAll(SLOW)];
  const firstSlow = slow[0];
  if (firstSlow && hits.length > 0) {
    const where = ctx.scan.segments.find((segment) => firstSlow.index >= segment.start && firstSlow.index < segment.end);
    out.push(
      finding("wording.tempo-conflict", {
        title: t("同時要求快與「{map}」", { map: listSome(slow.map((match) => match[0])) }),
        detail: t("先決定快和慢各在哪個時段，再分開寫清楚：{value}「{visual}」和其他地方的高速要求並存。這是指令之間的節奏矛盾，不代表某個字一定會讓畫面變慢（還沒有用生成結果驗證）。", {
          value: where && where.kind !== "paragraph" ? t("{label}的", { label: where.label }) : "",
          visual: excerpt(visual.slice(firstSlow.index, firstSlow.index + 20)),
        }),
        range: { start: firstSlow.index, end: firstSlow.index + firstSlow[0].length },
      }),
    );
  }
  return out;
}

function cameraRules(ctx: RuleContext): Finding[] {
  const out: Finding[] = [];
  const commands = bracketCameraCommands(ctx.text);
  const firstCommand = commands[0];
  if (firstCommand) {
    out.push(
      finding("wording.bracket-camera", {
        title: t("括號運鏡指令：{map}", { map: listSome(commands.map((command) => ctx.text.slice(command.start, command.end))) }),
        detail: t("把運鏡寫成完整句子：運鏡方式，需要時加上幅度與速度，不要堆成句尾的標籤。例如 The camera pushes in with small amplitude at slow speed toward the letter.；括號標籤不是保證有效的控制方式。"),
        range: firstCommand,
        fix: { label: t("改成完整句子（之後可補幅度與速度）"), apply: bracketCameraToSentences },
      }),
    );
  }
  const visual = visualText(ctx);
  const crowded: { segment: Segment; moves: string[] }[] = [];
  for (const segment of ctx.scan.segments) {
    const moves = new Set<string>();
    for (const clause of clauses(visual.slice(segment.start, segment.end), segment.start)) {
      if (!CAMERA_WORDS.test(clause.text)) continue;
      for (const [name, pattern] of CAMERA_MOVES) if (pattern.test(clause.text)) moves.add(name);
    }
    if (moves.size >= 3) crowded.push({ segment, moves: [...moves] });
  }
  const firstCrowded = crowded[0];
  if (firstCrowded) {
    out.push(
      finding("wording.multi-camera", {
        title: t("{label}有 {movesCount} 種運鏡", { label: firstCrowded.segment.label, movesCount: firstCrowded.moves.length }),
        detail: t("先選一種主要運鏡；要同時用好幾種時，寫清楚哪一個負責跟住人物、哪一個只在碰撞瞬間出現，否則很難從結果判斷哪個要求做到了。現在有：{listSome}。{value}", {
          listSome: listSome(firstCrowded.moves, 6),
          value: crowded.length > 1 ? t("另有 {crowdedCount} 段也是這樣。", { crowdedCount: crowded.length - 1 }) : "",
        }),
        range: { start: firstCrowded.segment.start, end: Math.min(firstCrowded.segment.end, firstCrowded.segment.start + 40) },
      }),
    );
  }
  return out;
}

function languageRules(ctx: RuleContext): Finding[] {
  const prose = proseOnly(ctx.scan);
  const cjk = countCjk(prose);
  const words = englishWords(prose);
  if (cjk < 20 || words > cjk / 10) return [];
  return [
    finding("wording.chinese-only", {
      title: t("這份 prompt 主要是中文"),
      detail: t(
          "中文 prompt 可以直接渲染，只是官方範例與寫作指南都用英文寫畫面與聲音，只有台詞、歌詞與畫面上的文字保留原文。目前沒有中英文效果的比較，不能說英文一定比較好；想試英文版時，可以複製這個鏡頭、只改語言，用同樣的 seed 比較兩版。有慣用的 LLM 時，「複製改寫指令」會把整理成英文結構稿需要的說明和這個鏡頭的條件一起複製下來。",
        ),
    }),
  ];
}

function negationRule(ctx: RuleContext): Finding[] {
  // Inside a [Shot N] line, shot.negation reports it (as a warning, with the measured result)
  const shots = shotRanges(ctx);
  const hits = [...ctx.text.matchAll(NEGATION)].filter((hit) => !shots.some((range) => hit.index >= range.start && hit.index < range.end));
  const first = hits[0];
  if (!first) return [];
  return [
    finding("wording.negation", {
      title: t("「不要…」這類寫法不保證有效"),
      detail: t("改成直接描述你想要的畫面。找到「{map}」：H3 沒有「不要出現」的欄位，否定句會和其他文字一樣送給模型，模型不一定照做；點名不想要的東西，有時反而會讓它出現（未驗證）。", {
        map: listSome(hits.map((hit) => hit[0].replace(/,$/, ""))),
      }),
      range: { start: first.index, end: first.index + first[0].length },
    }),
  ];
}

function lengthRules(ctx: RuleContext): Finding[] {
  const { text, mode, scan } = ctx;
  const out: Finding[] = [];
  if (text.length > 16384) {
    out.push(
      finding("length.studio-limit", {
        title: t("{textCount} 字元，超過 16,384 字元上限", { textCount: text.length.toLocaleString("en-US") }),
        detail: t("刪減到 16,384 字元以內；超過的部分無法儲存。"),
      }),
    );
  } else if (text.length > 7000) {
    out.push(
      finding("length.api-limit", {
        title: t("{textCount} 字元，超過 MiniMax 線上 API 的 7,000 字元", { textCount: text.length.toLocaleString("en-US") }),
        detail: t("在這台機器渲染不受這個限制（上限是 16,384 字元），只有改用 MiniMax 線上 API 時才要縮短。較長的 prompt 會讓文字編碼與生成用掉更多記憶體與時間（沒有量測）。"),
      }),
    );
  }
  const detailed = sectionOf(scan, "detailed_description");
  if (mode === "ref2va" && detailed && detailed.body !== "") {
    // 只數描述用字：台詞內容、H3 標籤、@ 名稱與分鏡標記不算
    const prose = blank(text, [
      ...scan.dialogues.filter((dialogue) => dialogue.closed).map((dialogue) => ({ start: dialogue.innerStart, end: dialogue.innerEnd })),
      ...scan.labels,
      ...scan.mentions,
      ...scan.shots,
    ]).slice(detailed.bodyStart, detailed.end);
    if (mostlyEnglish(prose)) {
      const words = englishWords(prose);
      if (words < 350 || words > 500) {
        out.push(
          finding("length.detailed-words", {
            title: t("{field}約 {words} 個英文字（建議 350–500）", { field: fieldName("detailed_description"), words }),
            detail: t("把{field}寫到約 350–500 個英文字；台詞很多時，以放得下完整的台詞為優先。這是官方的篇幅建議，不是硬性限制；一鏡到底也不代表可以寫得比較短。字數不算標籤、@ 名稱、分鏡標記與台詞。", {
              field: fieldWithKey("detailed_description"),
            }),
            range: { start: detailed.nameStart, end: detailed.nameEnd },
          }),
        );
      }
    }
  }
  const visible = proseOnly(scan);
  const short = mostlyEnglish(visible) ? englishWords(visible) < 12 : countCjk(visible) < 25 && englishWords(visible) < 12;
  if (short && scan.sections.length === 0) {
    out.push(
      finding("length.short", {
        title: t("描述很短"),
        detail: t("每一鏡補上：誰在哪裡、正在做什麼、動作怎麼發展、什麼時候發生、從哪裡看、聽到什麼。長短不是目標，但要能交代完動作與素材的關係。"),
      }),
    );
  }
  return out;
}

export function wordingRules(ctx: RuleContext): Finding[] {
  return [...vagueRules(ctx), ...tempoRules(ctx), ...cameraRules(ctx), ...languageRules(ctx), ...negationRule(ctx), ...lengthRules(ctx)];
}
