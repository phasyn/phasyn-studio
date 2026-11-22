// 參考素材規則：@ 名稱與 H3 標籤是否對得上送出的素材、方式是否接受素材、參考素材的數量限制、每份素材是否說明與使用、
// 參考影片原聲多出的 <Audio n>；角色段、要保留的外觀與一句話摘要的寫法在 definitions.ts。介面說「參考」分頁、「方式」，
// 不說程式名稱。
import { REF2VA_LIMITS } from "@/lib/h3Materials";
import { KIND_LABEL } from "../../../references/materials";
import type { ReferenceLabel } from "../labels";
import { sectionOf, type LabelHit } from "../parse";
import { fixMentionCase } from "../transforms";
import { MODE_LABEL, type Finding } from "../types";
import { fieldName, fieldWithKey } from "../words";
import { finding, inSection, labelText, listSome, type RuleContext } from "./context";
import { definitionRules } from "./definitions";
import { t } from "@/i18n";

function mentionRules(ctx: RuleContext): Finding[] {
  const { scan, plan, mode, references } = ctx;
  const out: Finding[] = [];
  const exact = new Set(plan.entries.map((entry) => entry.ref.alias));
  const wrongCase = scan.mentions.filter((mention) => !exact.has(mention.raw.slice(1)) && !mention.exactCase && exact.has(mention.alias));
  const unknown = scan.mentions.filter((mention) => !exact.has(mention.raw.slice(1)) && !wrongCase.includes(mention));
  const firstWrong = wrongCase[0];
  if (firstWrong) {
    out.push(
      finding("ref.mention-case", {
        title: t("{map} 的大小寫不對", { map: listSome(wrongCase.map((mention) => mention.raw)) }),
        detail: t("改成 {map}。@ 名稱的大小寫要完全一樣才會對到參考素材，不一樣的會被當成一般文字送出。", { map: listSome(wrongCase.map((mention) => `@${mention.alias}`)) }),
        range: firstWrong,
        fix: { label: t("修正 @ 名稱的大小寫"), apply: (text) => fixMentionCase(text, exact) },
      }),
    );
  }
  if (mode === "t2va" || mode === "fl2va") {
    const first = scan.mentions[0];
    if (first) {
      out.push(
        finding("ref.mention-unsupported", {
          title: t("這個鏡頭的方式不能用 @ 參考"),
          detail: t("把「方式」改成「參考素材」，或刪掉 {map}；方式是「{mode}」的鏡頭不送參考素材，渲染會被擋下。{value}", {
            map: listSome(scan.mentions.map((mention) => mention.raw)),
            mode: MODE_LABEL[mode],
            value: mode === "fl2va" ? t("首幀已經會送出，不需要 @ 名稱。") : "",
          }),
          range: first,
        }),
      );
    }
    return out;
  }
  const seen = new Set<string>();
  for (const mention of unknown) {
    if (seen.has(mention.raw)) continue;
    seen.add(mention.raw);
    out.push(
      finding("ref.unknown-mention", {
        title: t("{raw} 沒有對應的參考素材", { raw: mention.raw }),
        detail:
          references.length > 0
            ? t("在「參考」分頁加入 {raw}，或改用這個鏡頭已有的名稱：{listSome}。找不到的 @ 名稱會擋下渲染。", { raw: mention.raw, listSome: listSome(plan.entries.map((entry) => `@${entry.ref.alias}`), 12) })
            : t("先在「參考」分頁加入檔案，{raw} 才會對到參考素材。找不到的 @ 名稱會擋下渲染。", { raw: mention.raw }),
        range: mention,
      }),
    );
  }
  return out;
}

function labelRules(ctx: RuleContext): Finding[] {
  const { scan, mode, plan, firstFrame } = ctx;
  if (mode === "t2va" || mode === "fl2va") {
    const pictures = mode === "fl2va" && firstFrame ? 1 : 0;
    const bad = scan.labels.filter((label) => !(label.tag === "Picture" && label.ordinal >= 1 && label.ordinal <= pictures));
    const first = bad[0];
    if (!first) return [];
    return [
      finding("ref.labels-in-base", {
        title: t("{labelText} 在這個鏡頭沒有對應的素材", { labelText: listSome(bad.map(labelText)) }),
        detail:
          mode === "t2va"
            ? t("刪掉這些標籤，直接描述畫面中的人物與場景；只用文字的鏡頭不送任何素材，基本格式也不用參考標籤。")
            : t("刪掉這些標籤；有首幀的鏡頭只送一張首幀（<Picture 1>），其他標籤沒有對應的內容。"),
        range: first,
      }),
    ];
  }
  if (mode !== "ref2va") return [];
  const out: Finding[] = [];
  const limit: Record<Exclude<LabelHit["tag"], "Subject">, number> = { Picture: plan.counts.image, Video: plan.counts.video, Audio: plan.audioLabels.max };
  const outOfRange = scan.labels.filter((label) => label.tag !== "Subject" && (label.ordinal < 1 || label.ordinal > limit[label.tag]));
  const firstOut = outOfRange[0];
  if (firstOut) {
    const audio = plan.audioLabels.min === plan.audioLabels.max ? String(plan.audioLabels.min) : `${String(plan.audioLabels.min)}–${String(plan.audioLabels.max)}`;
    out.push(
      finding("ref.label-range", {
        title: t("{labelText} 超過送出的素材數", { labelText: listSome(outOfRange.map(labelText)) }),
        detail: t("改用 @Image1 這類 @ 名稱，Studio 會換成正確的編號；或把標籤改到範圍內。這個鏡頭送出 {image} 張圖片、{video} 段影片與 {audio} 個聲音標籤，同類素材依送出順序編號。", {
          image: plan.counts.image,
          video: plan.counts.video,
          audio,
        }),
        range: firstOut,
      }),
    );
  }
  const uncertain = scan.labels.filter((label) => label.tag === "Audio" && label.ordinal > plan.audioLabels.min && label.ordinal <= plan.audioLabels.max);
  const firstUncertain = uncertain[0];
  if (firstUncertain) {
    out.push(
      finding("ref.soundtrack-uncertain", {
        title: t("{labelText} 的編號要到渲染時才確定", { labelText: listSome(uncertain.map(labelText)) }),
        detail: t("到「參考」分頁確認參考影片有沒有聲音，或關閉它的「使用原片聲音當參考」。有原聲的影片會多佔一個 <Audio n>，後面的編號會跟著改變。"),
        range: firstUncertain,
      }),
    );
  }
  return out;
}

function routeRules(ctx: RuleContext): Finding[] {
  const { mode, references } = ctx;
  if ((mode !== "t2va" && mode !== "fl2va") || references.length === 0) return [];
  return [
    finding("ref.route-mismatch", {
      title: t("{referencesCount} 個參考素材不會送出", { referencesCount: references.length }),
      detail: t("要用參考素材，把「方式」改成「參考素材」。現在的方式是「{mode}」：參考素材會留在鏡頭裡，但不會送出；參考素材和首幀不能同時用。", { mode: MODE_LABEL[mode] }),
    }),
  ];
}

function limitRules(ctx: RuleContext): Finding[] {
  if (ctx.mode !== "ref2va") return [];
  const { counts } = ctx.plan;
  const total = ctx.references.length;
  const out: Finding[] = [];
  const policy = t("上限是圖片 {image} 張、影片 {video} 段、聲音 {audio} 段，合計 {max} 個；上限不是要填滿的目標，先用最能說清楚的幾個就好。", {
    image: REF2VA_LIMITS.image,
    video: REF2VA_LIMITS.video,
    audio: REF2VA_LIMITS.audio,
    max: REF2VA_LIMITS.maxTotal,
  });
  if (total === 0) out.push(finding("ref.limits", { title: t("還沒有參考素材"), detail: t("在「參考」分頁加入圖片或影片；用參考素材的鏡頭至少要 1 個。{policy}", { policy }) }));
  if (total > 12) out.push(finding("ref.limits", { title: t("參考素材 {total} 個，超過 12 個", { total }), detail: t("從「參考」分頁移除一些參考素材。{policy}", { policy }) }));
  const over = (["image", "video", "audio"] as const).filter((kind) => counts[kind] > (kind === "image" ? 9 : 3));
  for (const kind of over) {
    out.push(finding("ref.limits", { title: t("參考{kind} {counts} 個，超過上限", { kind: KIND_LABEL[kind], counts: counts[kind] }), detail: t("從「參考」分頁移除一些參考{kind}。{policy}", { kind: KIND_LABEL[kind], policy }) }));
  }
  if (total > 0 && counts.image + counts.video === 0) {
    out.push(finding("ref.limits", { title: t("不能只有聲音參考"), detail: t("再加入至少一張圖片或一段影片；只有聲音的參考素材不會被接受。") }));
  }
  return out;
}

function firstUse(ctx: RuleContext, entry: ReferenceLabel): { start: number; end: number } | null {
  const mention = ctx.scan.mentions.find((item) => item.raw.slice(1) === entry.ref.alias);
  if (mention) return mention;
  return ctx.scan.labels.find((item) => labelText(item) === entry.label) ?? null;
}

function usageRules(ctx: RuleContext): Finding[] {
  if (ctx.mode !== "ref2va") return [];
  const out: Finding[] = [];
  const definitions = sectionOf(ctx.scan, "subject_definitions");
  const undefinedEntries: ReferenceLabel[] = [];
  for (const entry of ctx.plan.entries) {
    const uses = [
      ...ctx.scan.mentions.filter((item) => item.raw.slice(1) === entry.ref.alias),
      ...ctx.scan.labels.filter((item) => labelText(item) === entry.label),
    ];
    if (uses.length === 0) {
      out.push(
        finding("ref.unused", {
          title: t("@{alias} 會送出，但 prompt 沒提到", { alias: entry.ref.alias }),
          detail: t("在 prompt 裡寫出 @{alias} 是誰或負責什麼，或從「參考」分頁移除它。{kind}「{value}」不管有沒有提到都會送給模型；官方寫法是先在{field}說明每份素材，再在對應的鏡頭引用。", {
            alias: entry.ref.alias,
            kind: KIND_LABEL[entry.ref.kind],
            value: entry.item?.name ?? t("素材庫找不到這個檔案"),
            field: fieldName("subject_definitions"),
          }),
        }),
      );
      continue;
    }
    if (definitions && !uses.some((use) => inSection(definitions, use.start))) undefinedEntries.push(entry);
  }
  const firstUndefined = undefinedEntries[0];
  if (firstUndefined) {
    out.push(
      finding("ref.undefined", {
        title: t("{map} 沒有在角色段說明", { map: listSome(undefinedEntries.map((entry) => `@${entry.ref.alias}`)) }),
        detail: t("在{field}為每份素材寫一行，說明它是誰或什麼、負責什麼。用來定人物、場景、服裝或風格的圖片，寫在對應的 <Subject N> 那一行，例如 <Subject 1> is the young woman in @Image1, …。", {
          field: fieldWithKey("subject_definitions"),
        }),
        range: firstUse(ctx, firstUndefined),
      }),
    );
  }
  return out;
}

function soundtrackRules(ctx: RuleContext): Finding[] {
  if (ctx.mode !== "ref2va") return [];
  const out: Finding[] = [];
  for (const entry of ctx.plan.entries) {
    const soundtrack = entry.soundtrack;
    if (!soundtrack || (soundtrack.state !== "used" && soundtrack.state !== "unknown")) continue;
    const alias = `@${entry.ref.alias}`;
    out.push(
      soundtrack.state === "used"
        ? finding("ref.soundtrack", {
            title: t("{alias} 的原聲也會送給模型", { alias }),
            detail: t("原片的台詞是原角色的聲音：嘴型與聲線會對不上新角色。只要畫面或動作時，到「參考」分頁關閉這段影片的「使用原片聲音當參考」，台詞寫成 <d>[語言] 原文</d>。開著時它的聲音會以 {value} 送出（排在 {label} 前面），要引用影片原聲就用這個標籤。", {
              label: entry.label,
              value: soundtrack.label ?? t("<Audio n>（編號要到渲染時才確定）"),
            }),
            range: firstUse(ctx, entry),
          })
        : finding("ref.soundtrack", {
            title: t("{alias} 有沒有原聲，要到渲染時才知道", { alias }),
            detail: t("不需要原聲時，到「參考」分頁關閉它的「使用原片聲音當參考」。瀏覽器看不出這段影片有沒有音軌；有的話會多送一個 <Audio n>，後面的聲音標籤編號也會改變。"),
            range: firstUse(ctx, entry),
          }),
    );
  }
  return out;
}

export function referenceRules(ctx: RuleContext): Finding[] {
  return [...mentionRules(ctx), ...labelRules(ctx), ...routeRules(ctx), ...limitRules(ctx), ...usageRules(ctx), ...definitionRules(ctx), ...soundtrackRules(ctx)];
}
