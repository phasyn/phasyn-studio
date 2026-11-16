// 參考素材鏡頭的說明段落規則：<Subject n> 有沒有在「角色與參考圖」說明、「要保留的外觀」每個標籤一行與官方的保留程度詞、
// 「一句話摘要」開頭的任務類型。介面用段落的白話名稱，正式名稱只在括號裡。
import { sectionOf, type Section } from "../parse";
import { prefixSummary } from "../transforms";
import type { Finding } from "../types";
import { fieldName, fieldWithKey } from "../words";
import { finding, inSection, labelText, listSome, type RuleContext } from "./context";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

const VISUAL_MARKERS = ["fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"];
const AUDIO_MARKERS = ["fully_copy", "partially_copy", "reference", "weak_reference"];
const TASK_TYPES = ["keyframe completion", "reference generation", "video editing", "video continuation", "audio reuse", "audio reference"];
const LEADING_LABEL = /^[ \t]*(<(?:Subject|Picture|Video|Audio)[ \t]*\d{1,3}>|@(?:Image|Video|Audio)[1-9][0-9]?)/;

/** 一行行首定義的標籤：key 是可比較的形式（@ 名稱換成編譯後的標籤），text 是原文寫法，rest 是同一行後面的文字。 */
export interface LeadingLabel {
  key: string;
  text: string;
  start: number;
  audio: boolean;
  rest: string;
}

/** subject_definitions 行首定義的標籤（<Subject 1>、<Picture 3>、@Audio1…），轉成可比較的形式（@ 名稱換成編譯後的標籤）。 */
export function leadingLabels(ctx: RuleContext, section: Section): LeadingLabel[] {
  const out: LeadingLabel[] = [];
  let offset = section.bodyStart;
  for (const line of ctx.text.slice(section.bodyStart, section.end).split("\n")) {
    const match = LEADING_LABEL.exec(line);
    const token = match?.[1];
    if (match && token) {
      const alias = token.startsWith("@") ? token.slice(1) : null;
      const key = alias ? (ctx.plan.byAlias.get(alias)?.label ?? token) : token.replace(/^<(\w+)[ \t]*(\d+)>$/, "<$1 $2>");
      out.push({ key, text: token, start: offset + match[0].length - token.length, audio: /^(?:<Audio|@Audio)/.test(token), rest: line.slice(match[0].length) });
    }
    offset += line.length + 1;
  }
  return out;
}

export function definitionRules(ctx: RuleContext): Finding[] {
  if (ctx.mode !== "ref2va" && ctx.mode !== null) return [];
  const out: Finding[] = [];
  const definitions = sectionOf(ctx.scan, "subject_definitions");
  const defined = definitions ? leadingLabels(ctx, definitions) : [];
  const definedSubjects = new Set(defined.filter((item) => item.key.startsWith("<Subject")).map((item) => item.key));
  const undefinedSubjects = ctx.scan.labels.filter((label) => label.tag === "Subject" && !inSection(definitions, label.start) && !definedSubjects.has(labelText(label)));
  const firstSubject = undefinedSubjects[0];
  if (firstSubject) {
    out.push(
      finding("ref.subject-undefined", {
        title: t("{labelText} 沒有說明是誰", { labelText: listSome(undefinedSubjects.map(labelText)) }),
        detail: t("在{field}先寫出 {labelText} 是誰或什麼、來自哪個素材，之後各段都用同一個意思。", {
          field: fieldWithKey("subject_definitions"),
          labelText: listSome(undefinedSubjects.map(labelText)),
        }),
        range: firstSubject,
      }),
    );
  }
  if (ctx.mode !== "ref2va") return out;

  const retention = sectionOf(ctx.scan, "retention_analysis");
  if (definitions && retention) {
    const lines = leadingLabels(ctx, retention);
    const covered = new Set(lines.map((line) => line.key));
    const missing = defined.filter((item) => !covered.has(item.key));
    if (missing.length > 0) {
      out.push(
        finding("ref.retention-missing", {
          title: t("{map} 沒有寫要保留什麼", { map: listSome(missing.map((item) => item.text)) }),
          detail: t("在{field}為 {map} 各寫自己的一行：出現在哪幾鏡、保留多少、保留什麼。保留程度用官方的固定詞：畫面用 {visualMarkers}；聲音用 {audioMarkers}。", {
            field: fieldWithKey("retention_analysis"),
            map: listSome(missing.map((item) => item.text)),
            visualMarkers: formatList(VISUAL_MARKERS),
            audioMarkers: formatList(AUDIO_MARKERS),
          }),
          range: { start: retention.nameStart, end: retention.nameEnd },
        }),
      );
    }
    const badMarkers = lines.filter((line) => {
      const marker = /^\s*(?:\([^)\n]*\))?\s*[:：]\s*([A-Za-z_]+)/.exec(line.rest)?.[1];
      return !marker || !(line.audio ? AUDIO_MARKERS : VISUAL_MARKERS).includes(marker);
    });
    const speaker = /\(S\d+(?:\s*,\s*S\d+)*\)/.exec(retention.body);
    const firstBad = badMarkers[0];
    if (firstBad || speaker) {
      const parts: string[] = [];
      if (firstBad) {
        parts.push(
          t("把 {map} 開頭的行改成「<Subject 1> (appears in [Shot 1]): fully_preserved - 要保留的內容」這種寫法，一個標籤一行。保留程度用官方的固定詞：畫面用 {visualMarkers}；聲音用 {audioMarkers}。", {
            map: listSome(badMarkers.map((line) => line.text)),
            visualMarkers: formatList(VISUAL_MARKERS),
            audioMarkers: formatList(AUDIO_MARKERS),
          }),
        );
      }
      if (speaker) parts.push(t("刪掉這一段裡的說話者編號 (Sx)：說話者只在畫面段標示。"));
      out.push(
        finding("ref.retention-format", {
          title: t("{field}的寫法和官方不同", { field: fieldName("retention_analysis") }),
          detail: parts.join(""),
          range: firstBad ? { start: firstBad.start, end: firstBad.start + firstBad.text.length } : { start: retention.bodyStart + (speaker?.index ?? 0), end: retention.bodyStart + (speaker?.index ?? 0) + (speaker?.[0].length ?? 0) },
        }),
      );
    }
  }

  const summary = sectionOf(ctx.scan, "summary");
  if (summary && summary.body !== "") {
    const prefix = /^\[([^\]\n]+)\]/.exec(summary.body);
    const typeList = formatList(TASK_TYPES);
    if (!prefix) {
      out.push(
        finding("ref.summary-prefix", {
          title: t("{field}的開頭少了任務類型", { field: fieldName("summary") }),
          detail: t("在摘要開頭加上方括號的任務類型，最常見的是 [reference generation]；可用的類型：{typeList}，多種用「 + 」連接。", { typeList }),
          range: { start: summary.nameStart, end: summary.nameEnd },
          fix: { label: t("加上 [reference generation]（請依用途修改）"), apply: prefixSummary },
        }),
      );
    } else {
      const unknown = (prefix[1] ?? "")
        .split("+")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => !TASK_TYPES.includes(item));
      if (unknown.length > 0) {
        out.push(
          finding("ref.summary-prefix", {
            title: t("摘要的任務類型「{unknown}」不在官方清單", { unknown: listSome(unknown) }),
            detail: t("改成官方的任務類型：{typeList}；多種用「 + 」連接，不重複。", { typeList }),
            range: { start: summary.bodyStart, end: summary.bodyStart + prefix[0].length },
          }),
        );
      }
    }
  }
  return out;
}
