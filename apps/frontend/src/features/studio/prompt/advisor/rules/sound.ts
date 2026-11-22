// 聲音、台詞與畫面文字規則（官方 Base 指南 §4.4–§4.7；Full-Reference 指南 §5.4、§6）。介面說「環境聲」「配樂」「台詞」，
// 段落的正式名稱只在括號裡。
import { sectionOf, type Section } from "../parse";
import { mostlyEnglish, sentenceCount } from "../text";
import { addDialogueLanguageTags, ONSCREEN_SOURCE, quoteOnscreenText } from "../transforms";
import type { Finding } from "../types";
import { fieldName } from "../words";
import { excerpt, finding, listSome, type RuleContext } from "./context";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

const SOUND_HINT = /聲|音|響|靜|sound|noise|audio|music|voice|silen|footstep|footfall|clang|crack|rumble|whoosh|thud|boom|ambien|<d>|BGM/i;
const SILENCE_REQUEST = /全片靜音|完全靜音|靜音|無聲|沒有聲音|不要有聲音|completely silent|complete silence|total silence|silent (?:film|video|clip)|no sound|without (?:any )?sound|muted/i;
const BACKGROUND_MUSIC = /背景音樂|背景配樂|配樂|BGM|background music|non-diegetic music|\bscore\b|soundtrack music/i;
const MUSIC_IN_SOUNDSCAPE = /音樂|配樂|BGM|旋律|鼓聲|吉他|鋼琴|\bmusic\b|\bscore\b|\bmelod(?:y|ies)\b|\bdrums?\b|\bguitars?\b|\bpiano\b|\bstrings\b|\borchestra(?:l)?\b|\bsynth/i;
const MOOD = /\b(?:epic|emotional|uplifting|heroic|dramatic|intense|inspiring|majestic|powerful|exciting|melancholic|hopeful|triumphant|sad)\b|史詩|感人|熱血|激昂|震撼|氣勢|悲傷|浪漫|溫馨|緊張感/i;
const INSTRUMENT =
  /\b(?:piano|guitars?|drums?|percussion|taiko|strings?|cello|violins?|viola|bass|synth(?:esizer)?s?|orchestra(?:l)?|brass|horns?|trumpets?|flutes?|choir|organ|harp|electronic|beats?|pulses?|riffs?|tempo|bpm)\b|鋼琴|吉他|鼓|打擊|弦樂|大提琴|小提琴|貝斯|合成器|管弦|銅管|長笛|合唱|電子|節拍|節奏/i;
const SPEECH_QUOTE = /(?:說道?|喊道?|大喊|低語|唸道?|念道|問道?|回答|唱道?|\bsays?\b|\bsaid\b|\bshouts?\b|\bwhispers?\b|\basks?\b|\byells?\b|\bsings?\b)\s*[:：,，]?\s*[「『“"]/i;
const SPEAKER_ID = /\(S\d+(?:\s*,\s*S\d+)*\)/;

function isNA(body: string): boolean {
  return /^N\/?A\.?$/i.test(body.trim());
}

function sectionRange(section: Section) {
  return { start: section.nameStart, end: section.nameEnd };
}

/** 去掉某個欄位後的文字（位置不變，其他欄位與正文保留）。 */
function outside(text: string, section: Section): string {
  return text.slice(0, section.lineStart) + " ".repeat(section.end - section.lineStart) + text.slice(section.end);
}

function soundRules(ctx: RuleContext): Finding[] {
  const { scan, text } = ctx;
  const out: Finding[] = [];
  const soundscape = sectionOf(scan, "overall_soundscape");
  const music = sectionOf(scan, "non_diegetic_music");

  if (!soundscape && !music && !SOUND_HINT.test(text)) {
    out.push(
      finding("sound.none", {
        title: t("沒有描述聲音"),
        detail: t(
          "寫下要聽到的聲音：和動作同步的聲音與台詞寫在鏡頭描述裡，全片的環境聲與動作聲寫在{soundscape}段，配樂寫在{music}段（不要配樂就寫 N/A）。H3 會一起生成聲音，沒寫的由模型自己決定，可能冒出不想要的配樂或人聲。",
          { soundscape: fieldName("overall_soundscape"), music: fieldName("non_diegetic_music") },
        ),
      }),
    );
  }

  if (soundscape && isNA(soundscape.body) && !SILENCE_REQUEST.test(text.replace(soundscape.body, ""))) {
    out.push(
      finding("sound.soundscape-na", {
        title: t("環境聲寫 N/A，會變成全片無聲"),
        detail: t("把 N/A 換成全片聽得到的環境聲、動作聲與人聲（1–4 句）；只有要全片完全無聲時才寫 N/A。{value}", {
          value: scan.dialogues.length > 0 ? t("這份 prompt 還有台詞，兩者互相矛盾。") : "",
        }),
        range: sectionRange(soundscape),
      }),
    );
  }

  if (music && isNA(music.body)) {
    const rest = outside(text, music);
    const hit = BACKGROUND_MUSIC.exec(rest);
    if (hit) {
      out.push(
        finding("sound.music-na-conflict", {
          title: t("配樂寫 N/A，正文卻提到背景音樂"),
          detail: t("要配樂就把它寫進{music}段；不要配樂就刪掉正文的「{rest}」。配樂寫 N/A 代表沒有配樂。", {
            music: fieldName("non_diegetic_music"),
            rest: excerpt(rest.slice(hit.index, hit.index + 24)),
          }),
          range: { start: hit.index, end: hit.index + hit[0].length },
        }),
      );
    }
  }

  if (soundscape && !isNA(soundscape.body)) {
    const hit = MUSIC_IN_SOUNDSCAPE.exec(soundscape.body);
    if (hit) {
      const start = soundscape.bodyStart + hit.index;
      out.push(
        finding("sound.music-in-soundscape", {
          title: t("環境聲裡寫了音樂"),
          detail: t("把觀眾才聽得到的配樂移到{music}段；角色聽得到的音樂（唱歌、彈奏、收音機）寫進鏡頭描述。環境聲只放環境聲、動作聲與人聲。", { music: fieldName("non_diegetic_music") }),
          range: { start, end: start + hit[0].length },
        }),
      );
    }
  }

  const inSound = scan.dialogues.filter((dialogue) => [soundscape, music].some((section) => Boolean(section && dialogue.start >= section.bodyStart && dialogue.start < section.end)));
  const firstInSound = inSound[0];
  if (firstInSound) {
    out.push(
      finding("sound.dialogue-in-sound", {
        title: t("聲音段裡有台詞"),
        detail: t("把 <d> 台詞移到鏡頭描述裡；台詞與歌詞只寫在畫面段的 <d> 中，環境聲與配樂不重複。"),
        range: firstInSound,
      }),
    );
  }

  if (music && !isNA(music.body) && MOOD.test(music.body) && !INSTRUMENT.test(music.body)) {
    out.push(
      finding("sound.music-mood", {
        title: t("配樂只寫了氣氛，沒寫樂器與節奏"),
        detail: t("改寫成樂器、速度、節奏與強弱的變化，不用「史詩、感人」這類情緒詞，也不解釋配樂要帶出什麼情緒。例如：Fast live drums and short distorted-guitar riffs maintain a steady driving pulse."),
        range: sectionRange(music),
      }),
    );
  }

  const tooLong: string[] = [];
  let tooLongRange: { start: number; end: number } | null = null;
  for (const [section, max] of [
    [soundscape, 4],
    [music, 3],
  ] as const) {
    if (!section || isNA(section.body) || !mostlyEnglish(section.body)) continue;
    const count = sentenceCount(section.body);
    if (count > max) {
      tooLong.push(t("{field}{count} 句（建議 1–{max} 句）", { field: fieldName(section.name), count, max }));
      tooLongRange ??= sectionRange(section);
    }
  }
  if (tooLong.length > 0) {
    out.push(
      finding("sound.sentences", {
        title: t("聲音段寫得比官方建議長"),
        detail: t("把 {tooLong} 縮短：環境聲 1–4 句、配樂 1–3 句，只概述全片；和特定鏡頭同步的聲音寫進那一鏡。", { tooLong: formatList(tooLong) }),
        range: tooLongRange,
      }),
    );
  }
  return out;
}

function dialogueRules(ctx: RuleContext): Finding[] {
  const { scan, text } = ctx;
  const out: Finding[] = [];
  const unclosed = scan.dialogues.filter((dialogue) => !dialogue.closed);
  const firstUnclosed = unclosed[0];
  if (firstUnclosed) {
    out.push(
      finding("dialogue.unclosed", {
        title: t("{unclosedCount} 個台詞標記沒有成對", { unclosedCount: unclosed.length }),
        detail: t("每句台詞都寫成 <d>[語言] 原文</d>，開頭與結尾都要有；少了一個，模型分不出哪些是台詞、哪些是描述。"),
        range: firstUnclosed,
      }),
    );
  }
  const closed = scan.dialogues.filter((dialogue) => dialogue.closed);
  const untagged = closed.filter((dialogue) => dialogue.tag === null);
  const firstUntagged = untagged[0];
  if (firstUntagged) {
    out.push(
      finding("dialogue.language-tag", {
        title: t("{untaggedCount} 句台詞沒有語言標籤", { untaggedCount: untagged.length }),
        detail: t("在 <d> 後面加上語言標籤，例如 [Chinese]，台詞原文照抄、不要翻譯。寫好的樣子：<d>[Chinese] 換我了。</d>"),
        range: firstUntagged,
        fix: { label: t("加上語言標籤（依內容推測，請確認）"), apply: addDialogueLanguageTags },
      }),
    );
  }
  const firstClosed = closed[0];
  if (firstClosed && !SPEAKER_ID.test(text) && !/reaches the phrase/i.test(text)) {
    out.push(
      finding("dialogue.speaker-id", {
        title: t("有台詞，但沒有說話者編號"),
        detail: t("在說話的人後面加上編號 (S1)、(S2)，跨鏡頭沿用同一個編號。第一次出現時描述聽得出是誰的聲音特徵，例如 a red-jacketed swordswoman with a clear, brisk voice (S1) says: <d>[Chinese] 換我了。</d>"),
        range: firstClosed,
      }),
    );
  }
  const quoted = SPEECH_QUOTE.exec(text);
  if (quoted) {
    out.push(
      finding("dialogue.unmarked", {
        title: t("台詞寫在引號裡"),
        detail: t("把角色說的話改成 <d>[語言] 原文</d>；英文雙引號 \"…\" 留給畫面上看得到的文字（招牌、字幕）。畫面上寫著「決戰」和角色說出「決戰」是兩回事。"),
        range: { start: quoted.index, end: quoted.index + quoted[0].length },
      }),
    );
  }
  return out;
}

function onscreenRule(ctx: RuleContext): Finding[] {
  const hits = [...ctx.text.matchAll(new RegExp(ONSCREEN_SOURCE, "gi"))];
  const first = hits[0];
  if (!first) return [];
  return [
    finding("text.onscreen-quotes", {
      title: t("畫面上的文字要用英文雙引號"),
      detail: t("把招牌、字幕、標語上的字放進英文雙引號，原文與標點照抄、不翻譯，例如 A red neon sign reading \"营业中\" glows above the doorway.；找到 {map}。", {
        map: listSome(hits.map((hit) => excerpt(hit[0], 16))),
      }),
      range: { start: first.index, end: first.index + first[0].length },
      fix: { label: t("改用英文雙引號"), apply: quoteOnscreenText },
    }),
  ];
}

export function soundAndTextRules(ctx: RuleContext): Finding[] {
  return [...soundRules(ctx), ...dialogueRules(ctx), ...onscreenRule(ctx)];
}
