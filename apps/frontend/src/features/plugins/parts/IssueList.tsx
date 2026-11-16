// 插件包的問題清單（安裝被拒絕的原因、不相容或損壞的原因、登錄表層級的問題）：每項一句說明＋包內的位置。
// 逐項進場；主控只列出前面的問題時，在最後說明還有其他問題。
import { CircleAlert, TriangleAlert } from "lucide-react";
import type { StudioPluginIssue } from "@/api/generated/contracts";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { issueText, readIssues } from "../model/issues";

const TONE = {
  warning: { icon: TriangleAlert, text: "text-warning", frame: "border-warning/35 bg-warning/5" },
  danger: { icon: CircleAlert, text: "text-danger", frame: "border-danger/35 bg-danger/5" },
} as const;

/** 一個問題底下的原因（例如開發目錄讀不到時，主控列出的每一項：details.errors）。 */
function NestedIssues({ issue }: { issue: StudioPluginIssue }) {
  const reasons = readIssues(issue.details.errors);
  if (reasons.length === 0) return null;
  return (
    <ul className="mt-1 grid gap-0.5 border-l border-line-subtle pl-2">
      {reasons.map((reason, index) => (
        <li key={`${index}:${reason.code}:${reason.path ?? ""}`} title={reason.code} className="text-caption text-fg-secondary [overflow-wrap:anywhere]">
          {issueText(reason)}
          {reason.path ? <span className="machine text-fg-tertiary"> · {reason.path}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function IssueList({
  issues,
  truncated = false,
  tone = "warning",
  label,
  className,
}: {
  issues: readonly StudioPluginIssue[];
  /** 主控只列出了前面的問題，還有沒列出的。 */
  truncated?: boolean;
  tone?: keyof typeof TONE;
  label: string;
  className?: string;
}) {
  if (issues.length === 0) return null;
  const { icon: Icon, text, frame } = TONE[tone];
  return (
    <ul aria-label={label} className={cn("grid divide-y divide-line-subtle rounded-lg border", frame, className)}>
      {issues.map((issue, index) => (
        <li key={`${index}:${issue.code}:${issue.path ?? ""}`} ref={reveal(index)} className="flex min-w-0 items-start gap-2 px-3 py-2" title={issue.code}>
          <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", text)} />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="text-data text-fg [overflow-wrap:anywhere]">{issueText(issue)}</p>
            {issue.path ? <p className="machine truncate text-caption text-fg-tertiary">{issue.path}</p> : null}
            <NestedIssues issue={issue} />
          </div>
        </li>
      ))}
      {truncated ? <li className="px-3 py-2 text-caption text-fg-tertiary">{t("只列出前 {count} 個問題，還有其他問題", { count: issues.length })}</li> : null}
    </ul>
  );
}
