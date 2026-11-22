// 範本（純函式）：官方格式骨架，依鏡頭的任務、片長與參考素材預先填好。名稱與說明是白話（會得到什麼、什麼時候用）；
// 官方名稱（任務代號、段落名稱、指南章節）放在 official，只出現在提示文字與範本預覽。
// [TODO: …] 是待填位置，括號裡用中文寫該填什麼——它會原樣送進 H3，所以「還有空段沒填」規則會一直提醒，直到換成實際
// 內容。參考素材用 @ 名稱（Studio 送出前轉成 <Picture n> 等標籤，素材順序改變時編號會跟著更新）。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { GUIDE_EXAMPLES } from "./examples";
import { labelPlan, type LabelPlan, type ReferenceLabel } from "./labels";
import { scanPrompt } from "./parse";
import { clipTiming, formatCueTime, formatSeconds, formatShortSeconds } from "./timing";
import type { PromptMode } from "./types";
import { t } from "@/i18n";

/** 官方 Base 指南 §2.1 的 I2VA 對齊句（必須是第一行，後面空一行）。 */
export const I2VA_ALIGNMENT_LINE = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";

export const PLACEHOLDER = {
  shot1: t("[Shot 1] [TODO: 開場的風格與構圖；誰在哪裡、做什麼、動作怎麼發展、鏡頭怎麼動、同時聽到的台詞與聲音]"),
  soundscape: t("[TODO: 全片聽得到的環境聲、動作聲與人聲（台詞不算），1–4 句；只有要全片完全無聲時才寫 N/A]"),
  music: t("[TODO: 配樂的樂器、速度、節奏與強弱，1–3 句；不要配樂就寫 N/A]"),
  summary: t("[reference generation] [TODO: 用一句話寫這個鏡頭發生什麼；角色用上面定義的 Subject 編號稱呼]"),
  styleOpening: t("[TODO: 一兩句整體風格與畫面質感]"),
  refShot1: t("[Shot 1] [TODO: 構圖、角色的樣子與位置、環境與光線、動作與變化、鏡頭怎麼動、這時的聲音，以及參考內容出現在哪裡]"),
} as const;

/** 放進 [TODO: …] 提示裡的檔名：去掉會讓提示提早結束的方括號與換行，太長時截斷。 */
function hintName(entry: ReferenceLabel): string {
  const name = (entry.item?.name ?? t("這個素材")).replace(/[[\]\r\n]+/g, " ").trim();
  return name.length > 40 ? `${name.slice(0, 40)}…` : name;
}

/**
 * subject_definitions：每個圖片／影片參考一行 <Subject n>，聲音參考用自己的 @ 名稱（官方 Full-Reference 指南 §2.1、§2.4）。
 * 每行都帶 @ 名稱，待填的提示寫出是哪個檔案。
 */
export function subjectDefinitionLines(plan: LabelPlan): string {
  if (plan.entries.length === 0) return t("<Subject 1> is [TODO: 參考內容是誰或什麼、來自哪個素材].");
  let subject = 0;
  return plan.entries
    .map((entry) => {
      const mention = `@${entry.ref.alias}`;
      const file = hintName(entry);
      if (entry.ref.kind === "audio") return t("{mention} is the [TODO: {file} 的用途，例如 voice timbre、music 或 sound effect] reference for [TODO: 用在誰或哪裡，例如 <Subject 1> (S1)].", { mention, file });
      subject += 1;
      if (entry.ref.kind === "video") {
        return t("<Subject {subject}> is [TODO: {file} 裡的誰或什麼動作] in {mention}, [TODO: 要沿用的內容；只參考運鏡或剪接節奏時，整行改成「{mention2} is the reference for its camera movement and cut rhythm.」].", {
          subject,
          file,
          mention,
          mention2: mention,
        });
      }
      return t("<Subject {subject}> is [TODO: {file} 裡的誰或什麼，和要保留的外觀，例如 the girl with long red hair] shown in {mention}.", { subject, file, mention });
    })
    .join("\n");
}

/**
 * 每個參考素材出現在哪幾鏡：它的 @ 名稱（或編譯後的標籤）寫在哪個 [Shot n] 裡，依鏡頭編號排序。
 * 沒有分鏡標記的文字整段算 [Shot 1]；寫在分鏡以外（例如風格段）的不算。
 */
export function shotAppearances(text: string, plan: LabelPlan): Map<string, string[]> {
  const scan = scanPrompt(text);
  const shots = scan.segments.filter((segment) => segment.kind === "shot");
  const found = new Map<string, Set<number>>();
  const add = (alias: string, offset: number) => {
    const shot = shots.length === 0 ? 1 : shots.find((segment) => offset >= segment.start && offset < segment.end)?.shot?.shot;
    if (shot === undefined) return;
    found.set(alias, (found.get(alias) ?? new Set<number>()).add(shot));
  };
  for (const mention of scan.mentions) if (mention.exactCase && plan.byAlias.has(mention.alias)) add(mention.alias, mention.start);
  for (const label of scan.labels) {
    const entry = plan.entries.find((item) => item.label === `<${label.tag} ${String(label.ordinal)}>`);
    if (entry) add(entry.ref.alias, label.start);
  }
  return new Map(
    [...found].map(([alias, numbers]) => [
      alias,
      [...numbers].sort((a, b) => a - b).map((shot) => `[Shot ${String(shot)}]`),
    ]),
  );
}

/**
 * retention_analysis：每個定義過的標籤一行（官方 Full-Reference 指南 §4）。appears in 用 shotAppearances 找到的鏡頭
 * （找不到時是 [Shot 1]）；圖片預設完整保留它的外觀（不必再填），影片與聲音的用途不同，留下要填的提示。
 */
export function retentionLines(plan: LabelPlan, appearances: ReadonlyMap<string, readonly string[]> = new Map()): string {
  if (plan.entries.length === 0) return t("<Subject 1> (appears in [Shot 1]): fully_preserved - [TODO: 要保留的外觀].");
  let subject = 0;
  return plan.entries
    .map((entry) => {
      const file = hintName(entry);
      if (entry.ref.kind === "audio") return t("@{alias}: reference - [TODO: 要參考 {file} 的音色、節奏或風格；要直接用原本的聲音時把 reference 改成 fully_copy].", { alias: entry.ref.alias, file });
      subject += 1;
      const shots = (appearances.get(entry.ref.alias) ?? ["[Shot 1]"]).join(", ");
      if (entry.ref.kind === "video") return t("<Subject {subject}> (appears in {shots}): fully_preserved - [TODO: 要從 {file} 沿用的外觀或動作].", { subject, shots, file });
      return `<Subject ${String(subject)}> (appears in ${shots}): fully_preserved - the appearance shown in @${entry.ref.alias} is retained.`;
    })
    .join("\n");
}

/** T2VA 三欄（官方 Base 指南 §2.2）；i2va＝加上 I2VA 對齊首行。 */
export function baseTemplate(options: { i2va?: boolean } = {}): string {
  const head = (options.i2va === true) ? `${I2VA_ALIGNMENT_LINE}\n\n` : "";
  return `${head}integrated_multimodal_description: ${PLACEHOLDER.shot1}\n\noverall_soundscape: ${PLACEHOLDER.soundscape}\n\nnon_diegetic_music: ${PLACEHOLDER.music}`;
}

/** Ref2VA 六段（官方 Full-Reference 指南 §1），依鏡頭的參考素材預先填好。 */
export function ref2vaTemplate(references: readonly StudioReference[], library: readonly StudioLibraryItem[]): string {
  const plan = labelPlan(references, library);
  return [
    `subject_definitions:\n${subjectDefinitionLines(plan)}`,
    `summary:\n${PLACEHOLDER.summary}`,
    `retention_analysis:\n${retentionLines(plan)}`,
    `detailed_description:\n${PLACEHOLDER.styleOpening}\n${PLACEHOLDER.refShot1}`,
    `overall_soundscape:\n${PLACEHOLDER.soundscape}`,
    `non_diegetic_music:\n${PLACEHOLDER.music}`,
  ].join("\n\n");
}

/** 平均分配的切點（0.5 秒格，嚴格遞增且小於片長）；做不到 → null。 */
export function cutTimes(seconds: number, shots: number): number[] | null {
  const out: number[] = [];
  for (let index = 1; index < shots; index += 1) {
    const time = Math.round(((seconds * index) / shots) * 2) / 2;
    if (time <= (out[out.length - 1] ?? 0) || time >= seconds) return null;
    out.push(time);
  }
  return out;
}

/** 分鏡骨架：第一鏡不加時間，之後 [Shot n] At mm:ss.sss, the camera cuts to …（官方 Base 指南 §4.2）。 */
export function timelineSkeleton(frames: number, shots: number): string | null {
  const timing = clipTiming(frames);
  if (!timing || shots < 1) return null;
  const cuts = cutTimes(timing.seconds, shots);
  if (!cuts) return null;
  const lines = [t("[Shot 1] [TODO: 開場的構圖與第一個動作]")];
  cuts.forEach((time, index) => {
    lines.push(t("[Shot {index}] At {time}, the camera cuts to [TODO: 這一鏡帶來的新內容：人物、地點、狀態、角度或時間]", { index: index + 2, time: formatCueTime(time) }));
  });
  return lines.join("\n\n");
}

/**
 * 動作戲四鏡骨架（景深站位＋每鏡換視角，避開 2D 格鬥遊戲的左右對站）：
 * 低角度縱深衝向防守方 → 過肩朝防守方出招 → 接觸點特寫＋反轉衝擊格 → 俯角看結果。
 * 動作朝向對手、不朝鏡頭：朝鏡頭的寫法會讓角色更常正面看鏡頭。
 */
export function actionSkeleton(frames: number): string | null {
  const timing = clipTiming(frames);
  if (!timing) return null;
  const cuts = cutTimes(timing.seconds, 4);
  if (!cuts) return null;
  const [two, three, four] = cuts.map((time) => formatCueTime(time));
  return [
    t("[Shot 1] A ground-level low angle looks along the street: [TODO: 防守方] stands in the midground, and far in the deep background [TODO: 進攻方] bursts toward [TODO: 防守方] down the street, growing larger with every stride."),
    t("[Shot 2] At {time}, the camera cuts to an over-the-shoulder shot from behind [TODO: 防守方]: [TODO: 進攻方] fills the foreground and swings [TODO: 武器或拳腳] at [TODO: 防守方]'s guard, foreshortened and smeared.", { time: two }),
    t("[Shot 3] At {time}, the shot cuts to an extreme close-up at the point of contact: [TODO: 接觸的瞬間與防禦方式]; the frame shakes strongly and flashes to a black-and-white inverted impact frame.", { time: three }),
    t("[Shot 4] At {time}, a high angle looks down on both of them: [TODO: 衝擊造成的結果，例如被打向遠景、地面的衝擊波].", { time: four }),
  ].join("\n");
}

export interface PromptTemplate {
  id: string;
  /** 白話名稱：會得到什麼。 */
  title: string;
  /** 一句：內容與什麼時候用。 */
  description: string;
  /** 官方名稱（任務代號、段落名稱、指南章節）：只出現在提示文字與範本預覽；null＝沒有。 */
  official: string | null;
  /** 適用的任務；null＝都可以。 */
  modes: readonly PromptMode[] | null;
  /** 指南範例（未經生成驗證）。 */
  example: boolean;
  /** 不能插入的原因；null＝可以。 */
  unavailable: string | null;
  text: string;
}

/** 範本的提示文字：完整的說明，加上它依據的官方名稱（任務代號、段落名稱、指南章節）。 */
export function templateHint(template: PromptTemplate): string {
  return (template.official != null && template.official !== "") ? t("{description}\n依據：{official}", { description: template.description, official: template.official }) : template.description;
}

const SKELETONS = {
  2: { title: t("兩鏡分鏡骨架"), describe: (seconds: string) => t("依這個鏡頭 {seconds} 秒平均切成兩鏡", { seconds }) },
  3: { title: t("三鏡分鏡骨架"), describe: (seconds: string) => t("依這個鏡頭 {seconds} 秒平均切成三鏡", { seconds }) },
} as const;

export function promptTemplates(input: {
  mode?: PromptMode | null;
  frames: number;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
}): PromptTemplate[] {
  const timing = clipTiming(input.frames);
  const tooShort = t("片長太短，無法平均切成這麼多鏡");
  const unknownLength = t("鏡頭長度未知");
  const markers = timing
    ? t("官方分鏡標記：[Shot 1]，之後 [Shot n] At mm:ss.sss,（官方 Base 指南 §4.2）；切點對齊 0.5 秒，鏡頭實際長 {seconds} 秒", { seconds: formatSeconds(timing.seconds) })
    : t("官方分鏡標記：[Shot 1]，之後 [Shot n] At mm:ss.sss,（官方 Base 指南 §4.2）；切點對齊 0.5 秒");
  const skeleton = (shots: 2 | 3): PromptTemplate => {
    const text = timelineSkeleton(input.frames, shots);
    return {
      id: `timeline-${String(shots)}`,
      title: SKELETONS[shots].title,
      description: timing ? SKELETONS[shots].describe(formatShortSeconds(timing.seconds)) : t("依鏡頭長度平均切鏡；要先知道鏡頭的「時長」"),
      official: markers,
      modes: null,
      example: false,
      unavailable: !timing ? unknownLength : text === null ? tooShort : null,
      text: text ?? "",
    };
  };
  const action = actionSkeleton(input.frames);
  return [
    {
      id: "base",
      title: t("基本格式：畫面＋環境聲＋配樂"),
      description: t("把 prompt 分成畫面描述、環境聲、配樂三段，適合只用文字的鏡頭"),
      official: t("T2VA 三欄：integrated_multimodal_description → overall_soundscape → non_diegetic_music（官方 Base 指南 §2.2）"),
      modes: ["t2va"],
      example: false,
      unavailable: null,
      text: baseTemplate(),
    },
    {
      id: "i2va",
      title: t("首幀格式：對齊句＋三段"),
      description: t("第一行說明影片從首幀（上一鏡的最後一格或選的圖片）開始，接著是畫面描述、環境聲、配樂三段，適合有首幀的鏡頭"),
      official: t("I2VA：官方對齊首行＋三欄（官方 Base 指南 §2.1、§2.2）；首幀在模型裡是 <Picture 1>"),
      modes: ["fl2va"],
      example: false,
      unavailable: null,
      text: baseTemplate({ i2va: true }),
    },
    {
      id: "i2va-line",
      title: t("只加首幀對齊句"),
      description: t("只插入一句對齊句：它必須是 prompt 的第一行，後面空一行"),
      official: t("I2VA 對齊首行（官方 Base 指南 §2.1）"),
      modes: ["fl2va"],
      example: false,
      unavailable: null,
      text: I2VA_ALIGNMENT_LINE,
    },
    {
      id: "ref2va",
      title: t("完整格式：角色參考＋分鏡＋聲音"),
      description: t("把 prompt 分成角色、一句話摘要、要保留的外觀、畫面與分鏡、環境聲、配樂六段，適合用參考圖的鏡頭"),
      official: t("Ref2VA 六段：subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music（官方 Full-Reference 指南 §1）"),
      modes: ["ref2va"],
      example: false,
      unavailable: null,
      text: ref2vaTemplate(input.references, input.library),
    },
    skeleton(2),
    skeleton(3),
    {
      id: "action-depth",
      title: t("動作戲四鏡：衝刺、出招、碰撞、結果"),
      description: t("低角度衝刺、過肩出招、碰撞特寫加衝擊格、俯角看結果；避開格鬥遊戲式的左右對站"),
      official: t("Phasyn Studio 建議的寫法：景深站位、每鏡換視角，分鏡標記同官方 Base 指南 §4.2"),
      modes: null,
      example: false,
      unavailable: !timing ? unknownLength : action === null ? tooShort : null,
      text: action ?? "",
    },
    ...GUIDE_EXAMPLES.map((example) => ({
      id: `example-${example.id}`,
      title: example.title,
      description: example.note,
      official: example.official,
      modes: [example.mode],
      example: true,
      unavailable: null,
      text: example.text,
    })),
  ];
}
