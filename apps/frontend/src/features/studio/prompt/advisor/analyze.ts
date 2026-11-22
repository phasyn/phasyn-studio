// 「Prompt 修正與建議」的分析入口（純函式）：analyzePrompt(input) → Finding[]。
// 只產生發現與可預覽的修正，不改字、不擋渲染（擋渲染的只有 compilePrompt 的 problems）、不連網。
import { labelPlan } from "./labels";
import { scanPrompt } from "./parse";
import { finding, type RuleContext } from "./rules/context";
import { measuredRules } from "./rules/measured";
import { referenceRules } from "./rules/references";
import { shotRules } from "./rules/shots";
import { soundAndTextRules } from "./rules/sound";
import { structureRules } from "./rules/structure";
import { timelineRules } from "./rules/timeline";
import { wordingRules } from "./rules/wording";
import { clipTiming, formatSeconds, H3_MAX_SECONDS, H3_MIN_SECONDS } from "./timing";
import { SEVERITY_ORDER, type AnalyzeInput, type Finding, type Severity } from "./types";
import { t } from "@/i18n";
import { DEFAULT_PROMPT_RULES, H3_RULES, type PromptRules } from "../../model/providerTraits";

/** Checks that hold for any model: an empty prompt, Studio's own length limit and the route's frame range. */
function genericFindings(input: AnalyzeInput, rules: PromptRules): Finding[] {
  const out: Finding[] = [];
  const frames = input.frames;
  if (rules.frames && frames > 0 && (frames < rules.frames.min || frames > rules.frames.max)) {
    const seconds = (value: number) => formatSeconds(value / rules.fps);
    out.push(
      finding("mode.duration-range", {
        title: frames < rules.frames.min ? t("鏡頭太短：這條路線至少要 {seconds} 秒", { seconds: seconds(rules.frames.min) }) : t("鏡頭太長：這條路線最多 {seconds} 秒", { seconds: seconds(rules.frames.max) }),
        detail: t("把鏡頭的「時長」調到 {min}–{max} 秒之間（現在是 {requestedSeconds} 秒）；超出這個範圍的鏡頭送出後會被拒絕。", { min: seconds(rules.frames.min), max: seconds(rules.frames.max), requestedSeconds: seconds(frames) }),
      }),
    );
  }
  if (input.text.trim() === "") out.push(finding("format.empty", { title: t("prompt 是空的"), detail: t("寫下畫面、動作與聲音；空的 prompt 不能渲染。") }));
  if (input.text.length > 16384) {
    out.push(
      finding("length.studio-limit", {
        title: t("{textCount} 字元，超過 16,384 字元上限", { textCount: input.text.length.toLocaleString("en-US") }),
        detail: t("刪減到 16,384 字元以內；超過的部分無法儲存。"),
      }),
    );
  }
  return out;
}

export function analyzePrompt(input: AnalyzeInput): Finding[] {
  const rules = input.rules ?? DEFAULT_PROMPT_RULES;
  // The H3 advisor (sections, tags, timeline, wording, 4–15 s) only applies where an H3 DiT renders
  if (!rules.h3) return sortFindings(genericFindings(input, rules));
  const text = input.text;
  const mode = input.mode ?? null;
  const timing = clipTiming(input.frames);
  const out: Finding[] = [];
  if (mode === null) {
    out.push(
      finding("mode.unknown", {
        title: t("不知道這個鏡頭用哪種方式生成"),
        detail: t("在 prompt 下方的「方式」選一種方式，就會再檢查分段格式、首幀與參考素材。目前只做和方式無關的檢查。"),
      }),
    );
  }
  if (!timing) {
    out.push(finding("mode.duration-unknown", { title: t("不知道鏡頭長度"), detail: t("設定鏡頭的「時長」後，才會檢查切鏡時間與片長。") }));
  } else if (timing.requestedSeconds < H3_MIN_SECONDS - 1e-9 || timing.requestedSeconds > H3_MAX_SECONDS + 1e-9) {
    out.push(
      finding("mode.duration-range", {
        title: timing.requestedSeconds < H3_MIN_SECONDS ? t("鏡頭太短：H3 至少要 {seconds} 秒", { seconds: H3_RULES.minSeconds }) : t("鏡頭太長：H3 最多 {seconds} 秒", { seconds: H3_RULES.maxSeconds }),
        detail: t("把鏡頭的「時長」調到 {min}–{max} 秒之間（現在是 {requestedSeconds} 秒）；超出這個範圍的鏡頭送出後會被拒絕。", { min: H3_RULES.minSeconds, max: H3_RULES.maxSeconds, requestedSeconds: formatSeconds(timing.requestedSeconds) }),
      }),
    );
  }
  if (text.trim() === "") {
    out.push(finding("format.empty", { title: t("prompt 是空的"), detail: t("寫下畫面、動作與聲音，或從「範本」開始；空的 prompt 不能渲染。") }));
    return sortFindings(out);
  }
  const scan = scanPrompt(text);
  const ctx: RuleContext = {
    text,
    scan,
    mode,
    firstFrame: input.firstFrame ?? mode === "fl2va",
    timing,
    plan: labelPlan(input.references, input.library),
    references: input.references,
    library: input.library,
    rules,
  };
  out.push(...structureRules(ctx), ...timelineRules(ctx), ...referenceRules(ctx), ...shotRules(ctx), ...soundAndTextRules(ctx), ...wordingRules(ctx), ...measuredRules(ctx));
  return sortFindings(out);
}

/** 嚴重度 → 位置（沒有位置的排在同級最前面）→ 規則 id。 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || (a.range?.start ?? -1) - (b.range?.start ?? -1) || a.id.localeCompare(b.id),
  );
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, suggestion: 0, info: 0 };
  for (const item of findings) counts[item.severity] += 1;
  return counts;
}

/** React key／比對用：同一條規則的不同發現以位置與標題區分。 */
export function findingKey(item: Finding): string {
  return `${item.id}|${String(item.range?.start ?? "")}|${item.title}`;
}

export interface KeyedFinding {
  key: string;
  item: Finding;
}

/** 清單的 key：規則 id＋同一規則內的序號。文字改動讓位置移動時 key 不變，展開的預覽不會跳掉、列也不會重新進場。 */
export function keyFindings(findings: readonly Finding[]): KeyedFinding[] {
  const seen = new Map<string, number>();
  return findings.map((item) => {
    const index = seen.get(item.id) ?? 0;
    seen.set(item.id, index + 1);
    return { key: `${item.id}#${String(index)}`, item };
  });
}
