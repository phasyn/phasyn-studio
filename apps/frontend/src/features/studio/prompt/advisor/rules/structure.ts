// 結構規則：官方分段格式（基本格式三段／參考素材鏡頭的完整格式六段）、段落順序、Markdown 殘留、標題行、範本的空段、
// Negative prompt 行、指南範例；首幀對齊句在 alignment.ts。會加上要使用者填的空段的改寫（改成完整格式、補上缺少的段落）是 action，
// 不是 fix：套用後還有功課，不能叫修正。
import { EXAMPLE_NOTE, GUIDE_EXAMPLES } from "../examples";
import { BASE_FIELDS, isRefOnlyField, REF_FIELDS, type FieldName, type MarkdownHit, type Section } from "../parse";
import {
  addMissingSections,
  firstContentLine,
  isTitleLine,
  lowercaseFieldNames,
  negativePromptLines,
  removeMetaTitle,
  removeNegativePromptLines,
  renameMainField,
  reorderSections,
  sectionRank,
  stripMarkdown,
  wrapBaseFields,
  wrapRefSections,
} from "../transforms";
import type { Finding } from "../types";
import { FIELD_LABEL, fieldName, fieldWithKey } from "../words";
import { alignmentRules } from "./alignment";
import { excerpt, finding, listSome, type RuleContext } from "./context";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

const MARKDOWN_KIND: Record<MarkdownHit["kind"], string> = {
  bold: t("** 粗體符號"),
  heading: t("行首的 #"),
  fence: t("``` 程式碼框"),
  code: t("` 反引號"),
  italic: t("* 斜體符號"),
};

function nameRange(section: Section) {
  return { start: section.nameStart, end: section.nameEnd };
}

/** 段落的官方順序，用白話名稱：「角色與參考圖」 → 「一句話摘要」 → … */
function orderText(fields: readonly FieldName[]): string {
  return fields.map((name) => fieldName(name)).join(" → ");
}

/** 段落清單（白話名稱，不加引號）：角色與參考圖、一句話摘要、… */
function fieldList(fields: readonly FieldName[]): string {
  return formatList(fields.map((name) => FIELD_LABEL[name]));
}

export function markdownRule(ctx: RuleContext): Finding[] {
  const hits = ctx.scan.markdown;
  const first = hits[0];
  if (!first) return [];
  return [
    finding("format.markdown", {
      title: t("有 {hitsCount} 個 Markdown 符號", { hitsCount: hits.length }),
      detail: t("刪掉這些符號、保留文字；要分段時用段落名稱或 [Shot n] 分鏡標記。{map}不會變成粗體或標題，而是當成文字原樣送給模型。", {
        map: listSome(hits.map((hit) => MARKDOWN_KIND[hit.kind])),
      }),
      range: first,
      fix: { label: t("移除 Markdown 符號（保留文字）"), apply: stripMarkdown },
    }),
  ];
}

export function metaTitleRule(ctx: RuleContext): Finding[] {
  const line = firstContentLine(ctx.text);
  if (!line) return [];
  const content = ctx.text.slice(line.start, line.end);
  if (!isTitleLine(content) || removeMetaTitle(ctx.text).trim() === "") return [];
  return [
    finding("format.meta-title", {
      title: t("開頭的標題行也會送給模型"),
      detail: t("刪掉「{content}」這一行。它是寫給人看的標題，不描述畫面，卻會被當成畫面內容；片長由鏡頭的「時長」決定，不需要寫在標題。", {
        content: excerpt(stripMarkdown(content)),
      }),
      range: line,
      fix: { label: t("刪除開頭的標題行"), apply: removeMetaTitle },
    }),
  ];
}

export function placeholderRule(ctx: RuleContext): Finding[] {
  const hits = [...ctx.text.matchAll(/\[TODO\b[^\]\n]*\]/g)];
  const first = hits[0];
  if (!first) return [];
  return [
    finding("format.placeholder", {
      title: t("還有 {hitsCount} 個空段沒填", { hitsCount: hits.length }),
      detail: t("把每個 [TODO: …] 換成你的內容，括號裡寫著該填什麼；不要配樂就把配樂段寫成 N/A。沒換掉的提示文字會原樣送給模型。"),
      range: { start: first.index, end: first.index + first[0].length },
    }),
  ];
}

export function negativePromptRule(ctx: RuleContext): Finding[] {
  const lines = negativePromptLines(ctx.text);
  if (lines.length === 0) return [];
  return [
    finding("format.negative-prompt", {
      title: t("Negative prompt 那一行會被當成要畫的內容"),
      detail: t("刪掉這一行，改成直接描述你想要的畫面。H3 沒有「不要出現」的欄位，這一行列出的東西（例如 blurry、low quality）反而會被當成要出現的內容。"),
      ...(lines[0] === undefined ? {} : { range: lines[0] }),
      fix: { label: t("刪除 Negative prompt 那一行"), apply: removeNegativePromptLines },
    }),
  ];
}

function emptyDetail(name: FieldName): string {
  if (name === "non_diegetic_music") return t("寫下配樂的樂器、速度與節奏；不要配樂就寫 N/A。");
  if (name === "overall_soundscape") return t("寫下全片聽得到的環境聲、動作聲與人聲（台詞不算）；只有要全片完全無聲時才寫 N/A。");
  return t("補上內容，或刪掉這一段。");
}

function caseRule(ctx: RuleContext, sections: readonly Section[]): Finding[] {
  const wrongCase = sections.filter((section) => !section.exactName);
  const firstWrong = wrongCase[0];
  if (!firstWrong) return [];
  return [
    finding("format.field-name", {
      title: t("段落名稱的大小寫和官方不同"),
      detail: t("把 {map} 改成小寫的 {map2}。段落名稱也會送給模型，照官方寫法比較穩當。", {
        map: listSome(wrongCase.map((section) => ctx.text.slice(section.nameStart, section.nameEnd))),
        map2: listSome(wrongCase.map((section) => section.name)),
      }),
      range: nameRange(firstWrong),
      fix: { label: t("段落名稱改成小寫"), apply: lowercaseFieldNames },
    }),
  ];
}

function duplicateAndEmptyRules(sections: readonly Section[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<FieldName, number>();
  for (const section of sections) {
    const count = (seen.get(section.name) ?? 0) + 1;
    seen.set(section.name, count);
    if (count === 2) {
      out.push(
        finding("format.section-duplicate", {
          title: t("{field}段出現了兩次", { field: fieldName(section.name) }),
          detail: t("把兩段的內容合併成一段，免得模型讀到兩段互相矛盾的描述。"),
          range: nameRange(section),
        }),
      );
    }
  }
  for (const section of sections) {
    if (section.body === "") out.push(finding("format.section-empty", { title: t("{field}段是空的", { field: fieldName(section.name) }), detail: emptyDetail(section.name), range: nameRange(section) }));
  }
  return out;
}

function refFormatRules(ctx: RuleContext, sections: readonly Section[], present: ReadonlySet<FieldName>): Finding[] {
  const { plan } = ctx;
  const anyRef = REF_FIELDS.some((name) => present.has(name)) || present.has("integrated_multimodal_description");
  if (!anyRef) {
    return [
      finding("format.structure", {
        title: t("還沒有用完整格式分段"),
        detail: t(
          "建議改成完整格式的六段：{fields}。分段後模型比較清楚哪張參考圖是誰、要保留什麼。「改成完整格式」會把現在的文字放進{main}，依這個鏡頭的參考素材寫好角色與要保留的外觀，剩下的空段寫著該填什麼。不改也能渲染：文字會原樣送給模型，不會自動整理。",
          { fields: fieldList(REF_FIELDS), main: fieldName("detailed_description") },
        ),
        action: { label: t("改成完整格式（會加上要你填的空段）"), apply: (value) => wrapRefSections(value, plan) },
      }),
    ];
  }
  const out: Finding[] = [];
  const imd = sections.find((section) => section.name === "integrated_multimodal_description");
  if (imd) {
    out.push(
      finding("format.ref-main-field", {
        title: t("畫面段要改名為 detailed_description"),
        detail: t("把 integrated_multimodal_description 改成 detailed_description，並在 [Shot 1] 前用一兩句寫整體風格。用參考素材的鏡頭，官方的畫面段叫 detailed_description。"),
        range: nameRange(imd),
        fix: present.has("detailed_description") ? null : { label: t("改名為 detailed_description"), apply: renameMainField },
      }),
    );
  }
  const missing = REF_FIELDS.filter((name) => !present.has(name) && !(name === "detailed_description" && imd));
  if (missing.length > 0) {
    out.push(
      finding("format.missing-section", {
        title: t("完整格式少了{missing}", { missing: listSome(missing.map((name) => fieldName(name))) }),
        detail: t("補上這幾段：完整格式的六段要依序都有，順序是{order}。「補上 {missingCount} 段」會把它們加在正確的位置，空段裡寫著該填什麼。", {
          order: orderText(REF_FIELDS),
          missingCount: missing.length,
        }),
        action: { label: t("補上 {missingCount} 段（會加上要你填的空段）", { missingCount: missing.length }), apply: (value) => addMissingSections(value, "ref", plan) },
      }),
    );
  }
  return out;
}

function baseFormatRules(ctx: RuleContext, sections: readonly Section[], present: ReadonlySet<FieldName>): Finding[] {
  const { plan } = ctx;
  const out: Finding[] = [];
  const refOnly = sections.filter((section) => isRefOnlyField(section.name));
  const firstRef = refOnly[0];
  if (firstRef) {
    out.push(
      finding("format.ref-sections-in-base", {
        title: t("{map}只給參考素材鏡頭用", { map: listSome(refOnly.map((section) => fieldName(section.name))) }),
        detail: t("刪掉這幾段，或把「方式」改成「參考素材」。沒有參考素材的鏡頭，官方格式只有三段：{order}。", { order: orderText(BASE_FIELDS) }),
        range: nameRange(firstRef),
      }),
    );
  }
  const basePresent = BASE_FIELDS.filter((name) => present.has(name));
  if (basePresent.length === 0 && !firstRef) {
    out.push(
      finding("format.structure", {
        title: t("還沒有用基本格式分段"),
        detail: t(
          "建議分成基本格式的三段：{fields}。{main}依播放順序寫畫面、動作、鏡頭、說話的人與同時的聲音。「改成基本格式」會把現在的文字放進{main2}，再加上兩段要你填的聲音段。不改也能渲染：文字會原樣送給模型，不會自動整理。",
          { fields: fieldList(BASE_FIELDS), main: fieldName("integrated_multimodal_description"), main2: fieldName("integrated_multimodal_description") },
        ),
        action: { label: t("改成基本格式（會加上要你填的空段）"), apply: (value) => wrapBaseFields(value, plan) },
      }),
    );
  } else if (basePresent.length > 0) {
    const missing = BASE_FIELDS.filter((name) => !present.has(name));
    if (missing.length > 0) {
      out.push(
        finding("format.missing-section", {
          title: t("基本格式少了{missing}", { missing: listSome(missing.map((name) => fieldName(name))) }),
          detail: t("補上這幾段：基本格式的三段要依序都有，順序是{order}。「補上 {missingCount} 段」會把它們加在正確的位置，空段裡寫著該填什麼。", {
            order: orderText(BASE_FIELDS),
            missingCount: missing.length,
          }),
          action: { label: t("補上 {missingCount} 段（會加上要你填的空段）", { missingCount: missing.length }), apply: (value) => addMissingSections(value, "base", plan) },
        }),
      );
    }
  }
  return out;
}

function orderRule(ctx: RuleContext, sections: readonly Section[]): Finding[] {
  const firsts: Section[] = [];
  for (const section of sections) if (!firsts.some((item) => item.name === section.name)) firsts.push(section);
  const index = firsts.findIndex((section, position) => {
    const previous = firsts[position - 1];
    return previous !== undefined && sectionRank(section.name) < sectionRank(previous.name);
  });
  const misplaced = firsts[index];
  const before = firsts[index - 1];
  if (!misplaced || !before) return [];
  const order =
    ctx.mode === "ref2va"
      ? orderText(REF_FIELDS)
      : ctx.mode === null
        ? t("{base}（參考素材鏡頭：{ref}）", { base: orderText(BASE_FIELDS), ref: orderText(REF_FIELDS) })
        : orderText(BASE_FIELDS);
  return [
    finding("format.section-order", {
      title: t("段落順序和官方不同"),
      detail: t("把{name}移到{name2}前面；官方順序是{order}。", { name: fieldWithKey(misplaced.name), name2: fieldName(before.name), order }),
      range: nameRange(misplaced),
      fix: { label: t("依官方順序重排段落"), apply: reorderSections },
    }),
  ];
}

export function sectionRules(ctx: RuleContext): Finding[] {
  const sections = ctx.scan.sections;
  const present = new Set(sections.map((section) => section.name));
  const format = ctx.mode === "ref2va" ? refFormatRules(ctx, sections, present) : ctx.mode === "t2va" || ctx.mode === "fl2va" ? baseFormatRules(ctx, sections, present) : [];
  return [...caseRule(ctx, sections), ...duplicateAndEmptyRules(sections), ...format, ...orderRule(ctx, sections)];
}

export function exampleRule(ctx: RuleContext): Finding[] {
  const example = GUIDE_EXAMPLES.find((item) => ctx.text.includes(item.signature));
  if (!example) return [];
  return [
    finding("format.example", {
      title: t("內容還是範例"),
      detail: t("把「{title}」裡的人物、場景、素材與秒數換成你的內容，渲染後再逐項檢查。{note}", { title: example.title, note: EXAMPLE_NOTE }),
    }),
  ];
}

export function structureRules(ctx: RuleContext): Finding[] {
  return [
    ...markdownRule(ctx),
    ...metaTitleRule(ctx),
    ...placeholderRule(ctx),
    ...negativePromptRule(ctx),
    ...sectionRules(ctx),
    ...alignmentRules(ctx),
    ...exampleRule(ctx),
  ];
}
