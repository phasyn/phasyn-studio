// 換角 prompt 範本（純函式）：六段結構
// subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music。
// 要點：<Video 1> 只當運鏡與動作參考（weak_reference，「its characters are replaced and must not appear」）；
// 每個新角色完整描述並列出「沒有」原角色的哪些東西；參考圖是白底人設圖、只取外觀；畫面沒有字幕、logo、浮水印；
// 把參考影片標成 fully_preserved 會照抄原角色——這裡永遠不用那種寫法。
// 聲音（預設）：參考影片不帶原聲，台詞照備註裡的 <d>…</d> 生成，放在這一段的 [Shot 1]，嘴型與聲線跟新角色一致；沒寫台詞的
// 段落只有環境聲與動作聲。只有使用者選「原影片音軌」時，原聲才以 <Audio 1> 送出並寫進定義與保留行（嘴型與聲線會對不上新角色）。
// 素材用 Studio 的 @ 名稱（@Image1…、@Video1），送出時由 compilePrompt 換成 <Picture n>／<Video 1>。
// 段尾凍結的段落在 @Video1 的定義與保留行加一句「after mm:ss.sss it holds its last frame」（視窗長度，與切鏡時間一樣相對
// 於視窗起點）；不寫「continues to the end of the clip」（試過，模型會提早停下動作）。
import { H3_FPS } from "../model/frames";
import { guessLanguageTag } from "../prompt/advisor/text";

export interface SwapCharacterText {
  /** 取代影片中的誰（英文名詞片語，例如 the person in the red jacket）。 */
  who: string;
  /** 新角色的外觀（英文名詞片語：身份、臉、眼睛、髮型、服裝、配件）。 */
  appearance: string;
  /** 不應出現的特徵（原角色的服裝或配件；逗號分隔）。 */
  mustNot: string;
}

export interface SegmentPromptInput {
  /** 這一段出現的角色，依 @Image1、@Image2… 的順序。 */
  characters: readonly SwapCharacterText[];
  /** 生成幀數。 */
  frames: number;
  fps?: number;
  /** 參考視窗內的切鏡（相對視窗起點的幀）。 */
  windowCuts: readonly number[];
  /** 段尾凍結：參考影片從這一幀（相對視窗起點＝視窗長度）起重複最後一格；null 或省略＝不凍結（不短於 frames 時也不寫）。 */
  holdAt?: number | null;
  /** 這一段的畫面內容與台詞（選填；台詞寫成 <d>…</d>，會移到 [Shot 1]）。 */
  note?: string;
  /** 畫面風格（選填）。 */
  style?: string;
  /** 台詞語言（選填，例如 Japanese）。 */
  dialogueLanguage?: string;
  /** 參考影片的原聲當聲音參考送出（<Audio 1>）：只有選「原影片音軌」且影片有音軌時。 */
  hasAudio: boolean;
}

/** 欄位上限（字元）：四個角色與備註都填滿時，prompt 仍在 16384 字元以內。 */
export const FIELD_LIMITS = { who: 200, appearance: 800, mustNot: 400, note: 1200, style: 600, language: 40 } as const;

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
const DETERMINER = /^(the|a|an|this|that|these|those|his|her|their|its|my|our|your)\s/i;

/** 收成一行、去掉結尾句號、截到上限。 */
function clean(text: string | undefined, limit: number): string {
  return (text ?? "").replace(/\s+/g, " ").trim().replace(/[.。]+$/u, "").slice(0, limit).trim();
}

/** 外觀片語：去掉開頭的冠詞（範本會加 the）。 */
function appearanceOf(character: SwapCharacterText): string {
  const text = clean(character.appearance, FIELD_LIMITS.appearance);
  return CJK.test(text) ? text : text.replace(/^(the|a|an)\s+/i, "");
}

/** 取代對象：英文且沒有限定詞時補 the。 */
function whoOf(character: SwapCharacterText, index: number): string {
  const text = clean(character.who, FIELD_LIMITS.who);
  if (!text) return `the character replaced by <Subject ${index + 1}>`;
  if (CJK.test(text) || !/^[A-Za-z]/.test(text) || DETERMINER.test(text)) return text;
  return `the ${text}`;
}

/** 「no A, no B, and no C」；中文輸入原樣保留。 */
export function noList(text: string): string {
  const raw = clean(text, FIELD_LIMITS.mustNot);
  if (!raw) return "";
  if (CJK.test(raw)) return raw;
  const items = raw
    .split(/\s*[,，、;；]\s*|\s+and\s+(?=no\s)/i)
    .map((item) => item.trim().replace(/^(and|or)\s+/i, "").replace(/^no\s+/i, "").trim())
    .filter(Boolean);
  const parts = items.map((item) => `no ${item}`);
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

const SPOKEN = /<d>([\s\S]*?)<\/d>/g;

/** 備註裡的 <d> 與 </d> 是否成對（不成對時不能建立：剩下的半個標記會被當成畫面描述）。 */
export function dialogueBalanced(note: string): boolean {
  return !/<\/?d>/.test(note.replace(SPOKEN, " "));
}

/**
 * 備註拆成畫面描述與台詞：每個 <d>…</d> 是一句台詞，沒有 [語言] 標籤時補上（台詞語言，沒填時依文字推測），
 * 其餘文字是畫面描述。
 */
export function noteDialogue(note: string, language: string): { text: string; lines: string[] } {
  const lines: string[] = [];
  const text = note.replace(SPOKEN, (_spoken, inner: string) => {
    const line = inner.replace(/\s+/g, " ").trim();
    if (line) lines.push(line.startsWith("[") ? line : `[${language || guessLanguageTag(line)}] ${line}`);
    return " ";
  });
  return { text: text.replace(/\s+/g, " ").trim().replace(/^[,;:，；：]\s*/u, "").replace(/[,;:，；：.。]+$/u, "").trim(), lines };
}

/** 「00:02.500」（分:秒.毫秒）。 */
export function formatCueTime(frames: number, fps = H3_FPS): string {
  const ms = Math.round((Math.max(0, frames) / fps) * 1000);
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

function englishList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** The cuts of the @Video1 definition: `, with 3 shots that cut at 00:01.083 and 00:02.625`; empty without cuts. */
export function definitionCuts(cues: readonly string[]): string {
  return cues.length > 0 ? `, with ${cues.length + 1} shots that cut at ${englishList(cues)}` : "";
}

/** The cuts of the @Video1 retention line: `cut at 00:01.083, ` or `cuts at 00:01.083 and 00:02.625, `; empty without cuts. */
export function retentionCuts(cues: readonly string[]): string {
  if (cues.length === 0) return "";
  return cues.length === 1 ? `cut at ${cues[0]}, ` : `cuts at ${englishList(cues)}, `;
}

/** The held reference in the @Video1 definition (after its cuts or note). */
export function definitionHold(cue: string): string {
  return `; after ${cue} it holds its last frame`;
}

/** The held reference in the @Video1 retention line (after its body motion). */
export function retentionHold(cue: string): string {
  return `; after ${cue} the reference holds its last frame`;
}

/** 一段的 prompt。 */
export function swapPrompt(input: SegmentPromptInput): string {
  const fps = input.fps ?? H3_FPS;
  const characters = input.characters;
  const subjects = characters.map((_, index) => `<Subject ${index + 1}>`);
  const cues = input.windowCuts.map((frames) => formatCueTime(frames, fps));
  const style = clean(input.style, FIELD_LIMITS.style);
  const language = clean(input.dialogueLanguage, FIELD_LIMITS.language);
  const { text: note, lines } = noteDialogue(clean(input.note, FIELD_LIMITS.note), language);
  const seconds = Math.max(1, Math.round(input.frames / fps));
  const hasCharacters = characters.length > 0;
  // Only a window shorter than the clip is held: one as long as the clip has nothing after it
  const holdAt = input.holdAt ?? null;
  const holdCue = holdAt !== null && holdAt > 0 && holdAt < input.frames ? formatCueTime(holdAt, fps) : null;

  const definitions = characters.map(
    (character, index) =>
      `<Subject ${index + 1}> is the ${appearanceOf(character)} in @Image${index + 1}, providing the face, hairstyle, costume, and accessories exactly as drawn. @Image${index + 1} is a character illustration on a plain white background; only the character's appearance is used, not the white background, the crop, or the pose.`,
  );
  const content = (note ? `: ${note}` : definitionCuts(cues)) + (holdCue ? definitionHold(holdCue) : "");
  definitions.push(
    hasCharacters
      ? `@Video1 is a motion and camera reference only${content}. Its characters are replaced and must not appear.`
      : `@Video1 is a motion and camera reference${content}.`,
  );
  if (input.hasAudio) definitions.push(`<Audio 1> is the original soundtrack of @Video1, providing the ${language ? `${language} ` : ""}dialogue, the voices, the ambience, and the mood.`);

  const replacements = characters.map((character, index) => `${subjects[index]} replaces ${whoOf(character, index)}`);
  // 兩個子句之間也用「, and」
  const replaced = replacements.length === 2 ? `${replacements[0]}, and ${replacements[1]}` : englishList(replacements);
  const summary = hasCharacters
    ? `[reference generation] A ${seconds}-second clip that follows only the camera work, shot sizes, cut timing, and body motion of @Video1, while every character is redrawn as the referenced subjects: ${replaced}.`
    : `[reference generation] A ${seconds}-second clip that follows the camera work, shot sizes, cut timing, and motion of @Video1. None of the replaced characters appear in this segment.`;

  const retention = characters.map((character, index) => {
    const not = noList(character.mustNot);
    const absent = not ? (CJK.test(not) ? `; ${subjects[index]} must not have: ${not}` : `; ${subjects[index]} has ${not}`) : "";
    return `${subjects[index]} (appears wherever ${whoOf(character, index)} appears in @Video1): fully_preserved - same ${appearanceOf(character)}${absent}.`;
  });
  const cutText = retentionCuts(cues);
  const heldText = holdCue ? retentionHold(holdCue) : "";
  retention.push(
    hasCharacters
      ? `@Video1 (camera path, shot sizes, ${cutText}body motion${heldText}): weak_reference - use only its framing, camera movement, timing, and poses; do not keep its characters' faces, hairstyles, costumes, accessories, subtitles, or watermark.`
      : `@Video1 (camera path, shot sizes, ${cutText}motion${heldText}): weak_reference - use only its framing, camera movement, timing, and motion; do not keep its subtitles or watermark.`,
  );
  if (input.hasAudio) retention.push(`<Audio 1> (dialogue, voice, ambience): fully_preserved - keep the ${language ? `${language} lines` : "spoken lines"}, their timing, the ambience, and the mood.`);

  const look = style || "The same visual style, lighting, and setting as @Video1";
  // Positive wording only: H3 has no negative prompt and draws what a line negates (a "no wings" line drew wings)
  const presence = hasCharacters ? `; every character on screen is drawn as ${englishList(subjects)}` : "";
  // Spoken lines go into the shot they are heard in (the H3 format); the speaker is named when only one character is there
  const speaker = characters.length === 1 ? "<Subject 1>" : "The character who talks";
  const spoken = lines.length > 0 ? ` ${speaker} says: ${lines.map((line) => `<d>${line}</d>`).join(" ")} The speaker's mouth moves visibly with each line.` : "";
  const shots = [`[Shot 1] The opening shot of @Video1, with the same framing, camera movement, and body motion${presence}.${spoken}`];
  cues.forEach((cue, index) => {
    shots.push(`[Shot ${index + 2}] At ${cue}, the camera cuts to the next shot of @Video1, with the same composition, camera movement, and body motion${hasCharacters ? `; the characters stay drawn as ${englishList(subjects)}` : ""}.`);
  });

  const sections: [string, string[]][] = [
    ["subject_definitions", definitions],
    ["summary", [summary]],
    ["retention_analysis", retention],
    ["detailed_description", [`${look}. The picture contains no subtitles, captions, logos, or watermarks.`, "", shots.join("\n\n")]],
    ["overall_soundscape", [input.hasAudio ? "The ambience and sound effects of <Audio 1>, matching the on-screen motion." : "Natural ambience and sound effects that follow the on-screen motion."]],
    ["non_diegetic_music", [input.hasAudio ? "The background score of <Audio 1>." : "No added music."]],
  ];
  return sections.map(([title, lines]) => `${title}:\n${lines.join("\n")}`).join("\n\n") + "\n";
}
