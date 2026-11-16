// 這個鏡頭的 prompt 對專案插件的檢查結果：不能套用的項目（找不到、停用、不相容、登錄表讀不到）、違反的規則（擋下的寫法
// 會標出命中的原文；缺少的必要寫法說明要補什麼；逐鏡檢查標出是哪一鏡或哪個角色）與不符合的生成設定要求。全部符合時只有
// 一行。有任何一項就不能渲染。
import { Ban, CircleCheck, CircleDashed, SlidersHorizontal, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { findingPlace, type PromptEvaluation, type RuleFinding } from "../model/evaluate";
import { generationFieldLabel, type GenerationFinding } from "../model/generation";
import { useRevealRef } from "../parts/motion";

function Item({ index, icon: Icon, tone, title, children }: { index: number; icon: LucideIcon; tone: "warning" | "danger"; title: string; children: ReactNode }) {
  const enter = useRevealRef(index);
  return (
    <li ref={enter} className="flex min-w-0 items-start gap-2 px-2.5 py-2">
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone === "danger" ? "text-danger" : "text-warning")} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="truncate text-data font-semibold text-fg" title={title}>
          {title}
        </p>
        <div className="text-data text-fg-secondary [overflow-wrap:anywhere]">{children}</div>
      </div>
    </li>
  );
}

function FindingBody({ finding }: { finding: RuleFinding }) {
  const place = findingPlace(finding);
  if (finding.match === null && place === null) return <p>{finding.message}</p>;
  return (
    <>
      <p className="flex min-w-0 flex-wrap items-center gap-1.5">
        {place !== null ? <span className="machine rounded border border-line bg-raised/60 px-1 text-caption text-fg">{place}</span> : null}
        {finding.match !== null ? <mark className="machine rounded bg-danger/15 px-1 text-danger">{finding.match}</mark> : null}
      </p>
      <p>{finding.message}</p>
    </>
  );
}

/** 同一個項目在不同鏡頭（或不同角色）各是一列。 */
function findingKey(finding: RuleFinding): string {
  return `finding:${finding.ref}:${finding.kind}:${finding.itemId}:${finding.shot ?? ""}:${finding.subject ?? ""}`;
}

function GenerationBody({ finding }: { finding: GenerationFinding }) {
  const field = generationFieldLabel(finding.field);
  const allowed = formatList(finding.allowed, { type: "disjunction" });
  return (
    <>
      <p>{finding.message}</p>
      <p className="machine text-caption text-fg-tertiary">
        {finding.actual === null
          ? t("{field}：無法確認目前的值；需要 {allowed}", { field, allowed })
          : t("{field}：目前 {actual}；需要 {allowed}", { field, actual: finding.actual, allowed })}
      </p>
    </>
  );
}

export function ValidationList({
  evaluation,
  generation,
  activeCount,
  className,
}: {
  evaluation: PromptEvaluation;
  /** 不符合的生成設定要求。 */
  generation: readonly GenerationFinding[];
  /** 專案套用中的項目數（0＝沒有東西要檢查，不顯示）。 */
  activeCount: number;
  className?: string;
}) {
  const total = evaluation.problems.length + evaluation.findings.length + generation.length;
  const fade = useChangeFade<HTMLDivElement>(total === 0);
  if (activeCount === 0) return null;
  if (total === 0) {
    return (
      <div ref={fade} role="status" className={cn("flex min-h-10 items-center gap-2 rounded-lg border border-success/30 bg-success/8 px-2.5 text-data text-success", className)}>
        <CircleCheck aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{t("這個鏡頭符合所有插件規則")}</span>
      </div>
    );
  }
  return (
    <div ref={fade} className={cn("grid min-w-0 gap-1.5", className)}>
      <p role="status" className="flex items-center gap-2 text-data font-semibold text-warning">
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        {t("{count} 項不符合，這個鏡頭不能渲染", { count: total })}
      </p>
      <ul aria-label={t("不符合的項目")} className="grid divide-y divide-line-subtle rounded-lg border border-warning/35 bg-warning/5">
        {evaluation.problems.map((problem, index) => (
          <Item key={`problem:${problem.code}:${problem.ref ?? ""}`} index={index} icon={Ban} tone="danger" title={t("不能套用")}>
            <p>{problem.text}</p>
          </Item>
        ))}
        {evaluation.findings.map((finding, index) => (
          <Item
            key={findingKey(finding)}
            index={evaluation.problems.length + index}
            icon={finding.kind === "forbid" ? Ban : CircleDashed}
            tone="warning"
            title={finding.label}
          >
            <FindingBody finding={finding} />
          </Item>
        ))}
        {generation.map((finding, index) => (
          <Item
            key={`generation:${finding.ref}:${finding.requirementId}`}
            index={evaluation.problems.length + evaluation.findings.length + index}
            icon={SlidersHorizontal}
            tone="warning"
            title={finding.label}
          >
            <GenerationBody finding={finding} />
          </Item>
        ))}
      </ul>
    </div>
  );
}
