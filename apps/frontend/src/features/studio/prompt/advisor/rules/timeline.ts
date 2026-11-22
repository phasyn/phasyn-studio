// 時間軸規則：自訂時間標題 → 官方分鏡標記、第一鏡不加時間戳、連號、切鏡時間嚴格遞增且落在實際片長
// （17n+5 對齊後 ÷ 24）內、文字寫的秒數與片長是否一致、時間軸之後的整體說明。
// 介面說「切鏡時間」「分鏡」；片長的邊界用精確秒數（5.167），一般的秒數用一位小數。
import type { ShotMarker } from "../parse";
import { explainClip, formatSeconds, formatShortSeconds, isCanonicalCueTime } from "../timing";
import { canonicalizeCueTimes, convertTimeHeadings, moveTrailingText, removeFirstShotTime, renumberShots, trailingText } from "../transforms";
import type { Finding } from "../types";
import { excerpt, finding, listSome, type RuleContext } from "./context";
import { t } from "@/i18n";

const EPS = 0.0005;
/** 時段終點允許超出片長的誤差（秒）。 */
const END_TOLERANCE = 0.05;
const CUT_WORDS = /切換|切到|切至|跳切|快切|剪到|剪接到|\bcuts? to\b/i;

function shotLabel(text: string, shot: ShotMarker): string {
  return text.slice(shot.start, shot.bracketEnd);
}

function headingRules(ctx: RuleContext): Finding[] {
  const { scan, timing, text } = ctx;
  const headings = scan.headings;
  const first = headings[0];
  if (!first) return [];
  const out: Finding[] = [];
  const range = { start: first.start, end: first.end };
  if (scan.shots.length > 0) {
    out.push(
      finding("timeline.mixed-markers", {
        title: t("兩種分鏡寫法混在一起"),
        detail: t("全部改成同一種分鏡寫法：[Shot 1]，之後 [Shot 2] At 00:03.000,；同一個鏡頭裡的時段寫成 [Shot 1, 00:00.000-00:02.000]。「0.0–1.5 秒：」這種自訂時間標題對模型只是文字。"),
        range,
      }),
    );
  } else {
    out.push(
      finding("timeline.user-headings", {
        title: t("{headingsCount} 個時間標題要改成分鏡標記", { headingsCount: headings.length }),
        detail: t(
          "把時間標題改成分鏡標記：第一段寫 [Shot 1]，之後每段寫 [Shot n] At 切鏡時間,。「0.0–1.5 秒：」這種自訂標題對模型只是文字。「改成分鏡標記」會把每一段當成一次切鏡；如果其實是同一個連續鏡頭裡的時段，改用「⋯ → 格式化…」的「轉成 [Shot 1, 00:00.000-00:01.500]」。",
        ),
        range,
        fix: { label: t("改成分鏡標記"), apply: convertTimeHeadings },
      }),
    );
  }
  if (timing) {
    const seconds = timing.seconds;
    const beyond = headings.filter((heading) => heading.from >= seconds - EPS || heading.to > seconds + END_TOLERANCE);
    const firstBeyond = beyond[0];
    if (firstBeyond) {
      out.push(
        finding("timeline.heading-beyond-clip", {
          title: t("{beyondCount} 個時段超出片長", { beyondCount: beyond.length }),
          detail: t("把 {map} 改到 {seconds} 秒以內，或把鏡頭的「時長」調長；超出片長的部分不會生成。{clip}", {
            map: listSome(beyond.map((heading) => t("{from}–{to} 秒", { from: heading.from, to: heading.to }))),
            seconds: formatSeconds(seconds),
            clip: explainClip(timing),
          }),
          range: { start: firstBeyond.start, end: firstBeyond.end },
        }),
      );
    }
    const lastEnd = Math.max(...headings.map((heading) => heading.to));
    const lastHeading = headings[headings.length - 1];
    if (lastEnd < seconds - 1 && lastHeading) {
      out.push(
        finding("timeline.ends-early", {
          title: t("時間軸只寫到 {lastEnd} 秒，鏡頭有 {seconds} 秒", { lastEnd: formatShortSeconds(lastEnd), seconds: formatShortSeconds(seconds) }),
          detail: t("把最後約 {gap} 秒也寫進時間軸，或把鏡頭的「時長」縮短；沒寫到的時間由模型自己補。{clip}", { gap: formatShortSeconds(seconds - lastEnd), clip: explainClip(timing) }),
          range: { start: lastHeading.start, end: lastHeading.end },
        }),
      );
    }
  }
  const withCuts = scan.segments.filter((segment) => Boolean(segment.kind === "time" && segment.heading && CUT_WORDS.test(text.slice(segment.heading.end, segment.end))));
  const firstCut = withCuts[0];
  if (firstCut?.heading) {
    out.push(
      finding("timeline.cuts-in-segment", {
        title: t("一個時段裡切了好幾次畫面"),
        detail: t("把每次切換拆成一個新的分鏡（[Shot n] At 切鏡時間,），寫清楚切到什麼新內容：人物、地點、狀態、角度或時間。{map}裡寫了「切換」；只改遠近或角度時，用運鏡就好，不必切鏡。", {
          map: listSome(withCuts.map((segment) => segment.label)),
        }),
        range: { start: firstCut.start, end: firstCut.heading.end },
      }),
    );
  }
  return out;
}

function markerRules(ctx: RuleContext): Finding[] {
  const { scan, timing, text } = ctx;
  const shots = scan.shots;
  const first = shots[0];
  if (!first) return [];
  const out: Finding[] = [];
  if (first.style === "cut" && first.at) {
    out.push(
      finding("timeline.first-shot-time", {
        title: t("第一鏡不要寫切鏡時間"),
        detail: t("刪掉 {shotLabel} 後面的 At 時間：開場只寫 {shotLabel2}，從第二鏡開始才寫 At 切鏡時間。", { shotLabel: shotLabel(text, first), shotLabel2: shotLabel(text, first) }),
        range: first,
        fix: { label: t("刪除第一鏡的時間"), apply: removeFirstShotTime },
      }),
    );
  }
  const cuts = shots.filter((shot) => shot.style !== "range");
  const misnumbered = cuts.find((shot, index) => shot.shot !== index + 1);
  if (misnumbered) {
    out.push(
      finding("timeline.shot-number", {
        title: t("分鏡編號沒有照 1、2、3… 排"),
        detail: t("依出現順序重新編號；目前的順序是 {listSome}。", { listSome: listSome(cuts.map((shot) => `[Shot ${String(shot.shot)}]`), 8) }),
        range: misnumbered,
        fix: { label: t("依出現順序重新編號"), apply: renumberShots },
      }),
    );
  }
  const missing = cuts.filter((shot, index) => index > 0 && shot.style === "plain");
  const firstMissing = missing[0];
  if (firstMissing) {
    out.push(
      finding("timeline.missing-time", {
        title: t("{map} 沒有切鏡時間", { map: listSome(missing.map((shot) => shotLabel(text, shot))) }),
        detail: t("在這幾鏡的標記後面寫上切鏡時間，而且一鏡比一鏡晚。例如 [Shot 2] At 00:03.500, the camera cuts to …；沒寫時間，切點由模型自己決定。"),
        range: firstMissing,
      }),
    );
  }
  const nonCanonical = shots.filter((shot) => (shot.at !== null && !isCanonicalCueTime(shot.at.text)) || (shot.range !== null && (!isCanonicalCueTime(shot.range.startText) || !isCanonicalCueTime(shot.range.endText))));
  const firstOdd = nonCanonical[0];
  if (firstOdd) {
    const fixable = nonCanonical.some((shot) => shot.at?.seconds != null || shot.range?.start != null || shot.range?.end != null);
    out.push(
      finding("timeline.time-format", {
        title: t("時間不是 00:03.500 這種寫法"),
        detail: t("改成兩位分鐘、兩位秒與三位毫秒，例如 00:03.500；看不懂的時間（例如秒數超過 59）要自己改。"),
        range: firstOdd,
        fix: fixable ? { label: t("統一成 00:03.500 寫法"), apply: canonicalizeCueTimes } : null,
      }),
    );
  }

  const disorder: ShotMarker[] = [];
  let previous: number | null = null;
  shots.forEach((shot, index) => {
    if (shot.style === "cut" && shot.at?.seconds != null) {
      const time = shot.at.seconds;
      if (index > 0 && time <= (previous ?? 0) + EPS) disorder.push(shot);
      previous = time;
    } else if (shot.style === "range" && shot.range) {
      const { start, end } = shot.range;
      if ((start !== null && end !== null && end <= start + EPS) || (start !== null && previous !== null && start < previous - EPS)) disorder.push(shot);
      previous = end ?? start ?? previous;
    }
  });
  const firstDisorder = disorder[0];
  if (firstDisorder) {
    out.push(
      finding("timeline.order", {
        title: t("{map} 的時間沒有往後排", { map: listSome(disorder.map((shot) => shotLabel(text, shot))) }),
        detail: t("把切鏡時間改成一鏡比一鏡晚（時段的結束也要晚於開始）；時間倒退或重疊時，描述會互相矛盾。"),
        range: firstDisorder,
      }),
    );
  }

  if (timing) {
    const seconds = timing.seconds;
    const beyond = shots.filter(
      (shot) =>
        (shot.at?.seconds != null && shot.at.seconds >= seconds - EPS) ||
        (shot.range !== null && ((shot.range.start !== null && shot.range.start >= seconds - EPS) || (shot.range.end !== null && shot.range.end > seconds + END_TOLERANCE))),
    );
    const firstBeyond = beyond[0];
    if (firstBeyond) {
      out.push(
        finding("timeline.beyond-clip", {
          title: t("{beyondCount} 個切鏡時間超出片長", { beyondCount: beyond.length }),
          detail: t("把 {map} 改到 {seconds} 秒以前，或把鏡頭的「時長」調長；切鏡時間要落在片長以內。{clip}", {
            map: listSome(beyond.map((shot) => excerpt(text.slice(shot.start, shot.end), 40))),
            seconds: formatSeconds(seconds),
            clip: explainClip(timing),
          }),
          range: firstBeyond,
        }),
      );
    }
    const ends = shots.map((shot) => shot.range?.end ?? null).filter((value): value is number => value !== null);
    const lastRange = [...shots].reverse().find((shot) => shot.range?.end != null);
    if (ends.length > 0 && scan.headings.length === 0 && lastRange) {
      const lastEnd = Math.max(...ends);
      if (lastEnd < seconds - 1) {
        out.push(
          finding("timeline.ends-early", {
            title: t("時間軸只寫到 {lastEnd} 秒，鏡頭有 {seconds} 秒", { lastEnd: formatShortSeconds(lastEnd), seconds: formatShortSeconds(seconds) }),
            detail: t("把最後約 {gap} 秒也寫進時間軸，或把鏡頭的「時長」縮短；沒寫到的時間由模型自己補。{clip}", { gap: formatShortSeconds(seconds - lastEnd), clip: explainClip(timing) }),
            range: lastRange,
          }),
        );
      }
    }
  }
  return out;
}

const EN_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
};
const CLAIM_SOURCES = [
  String.raw`(\d{1,2}(?:\.\d{1,2})?)\s*秒(?:鐘)?(?:的)?\s*(?:影片|短片|片段|動畫|影像|視頻|長片|MV|OP)`,
  String.raw`(?:片長|時長|影片長度)\s*(?:約|為|是|：|:)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*秒`,
  String.raw`\b(\d{1,2}(?:\.\d{1,2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)[- ]second\s+(?:[A-Za-z-]+\s+){0,2}?(?:video|clip|shot|film|animation|sequence|scene|duel|opening|op|mv)\b`,
];

function durationClaimRule(ctx: RuleContext): Finding[] {
  const { timing, text } = ctx;
  if (!timing) return [];
  const claims: { seconds: number; start: number; end: number }[] = [];
  for (const source of CLAIM_SOURCES) {
    for (const match of text.matchAll(new RegExp(source, "gi"))) {
      const raw = (match[1] ?? "").toLowerCase();
      const seconds = EN_NUMBERS[raw] ?? Number(raw);
      if (Number.isFinite(seconds)) claims.push({ seconds, start: match.index, end: match.index + match[0].length });
    }
  }
  const off = claims.filter((claim) => Math.abs(claim.seconds - timing.seconds) > 0.6).sort((a, b) => a.start - b.start);
  const first = off[0];
  if (!first) return [];
  return [
    finding("timeline.duration-claim", {
      title: t("文字寫 {seconds} 秒，鏡頭實際 {seconds2} 秒", { seconds: formatSeconds(first.seconds), seconds2: formatShortSeconds(timing.seconds) }),
      detail: t("把鏡頭的「時長」改成你要的長度，或改 prompt 裡寫的秒數與時間軸，讓兩者一致。{clip}", { clip: explainClip(timing) }),
      range: first,
    }),
  ];
}

function trailingRule(ctx: RuleContext): Finding[] {
  const found = trailingText(ctx.scan);
  const head = found?.trailing[0];
  if (!found || !head) return [];
  return [
    finding("timeline.trailing-text", {
      title: t("時間軸最後還有一段整體說明"),
      detail: t("把「{text}」移到第一個鏡頭之前：放在 {label} 後面，模型會把它當成最後一鏡的內容。整體風格寫在開頭；用參考素材的鏡頭寫在「畫面與分鏡」的 [Shot 1] 之前。", {
        text: excerpt(ctx.text.slice(head.start, head.end)),
        label: found.last.label,
      }),
      range: head,
      fix: { label: t("移到第一個鏡頭之前"), apply: moveTrailingText },
    }),
  ];
}

export function timelineRules(ctx: RuleContext): Finding[] {
  return [...headingRules(ctx), ...markerRules(ctx), ...durationClaimRule(ctx), ...trailingRule(ctx)];
}
