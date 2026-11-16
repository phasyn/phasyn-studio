// 「Prompt 修正與建議」的分析入口（純函式）：analyzePrompt(input) → Finding[]。
// 只產生發現與可預覽的修正，不改字、不擋渲染（擋渲染的只有 compilePrompt 的 problems）、不連網。
import { labelPlan } from "./labels";
import { scanPrompt } from "./parse";
import { finding, type RuleContext } from "./rules/context";
import { referenceRules } from "./rules/references";
import { shotRules } from "./rules/shots";
import { soundAndTextRules } from "./rules/sound";
import { structureRules } from "./rules/structure";
import { timelineRules } from "./rules/timeline";
import { wordingRules } from "./rules/wording";
import { clipTiming, formatSeconds, H3_MAX_SECONDS, H3_MIN_SECONDS } from "./timing";
import { SEVERITY_ORDER, type AnalyzeInput, type Finding, type Severity } from "./types";
import { t } from "@/i18n";

export function analyzePrompt(input: AnalyzeInput): Finding[] {
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
        title: timing.requestedSeconds < H3_MIN_SECONDS ? t("鏡頭太短：H3 至少要 4 秒") : t("鏡頭太長：H3 最多 15 秒"),
        detail: t("把鏡頭的「時長」調到 4–15 秒之間（現在是 {requestedSeconds} 秒）；超出這個範圍的鏡頭送出後會被拒絕。", { requestedSeconds: formatSeconds(timing.requestedSeconds) }),
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
  };
  out.push(...structureRules(ctx), ...timelineRules(ctx), ...referenceRules(ctx), ...shotRules(ctx), ...soundAndTextRules(ctx), ...wordingRules(ctx));
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
  return `${item.id}|${item.range?.start ?? ""}|${item.title}`;
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
    return { key: `${item.id}#${index}`, item };
  });
}
