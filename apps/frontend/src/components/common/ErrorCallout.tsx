import { CircleHelp, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { tServer, t } from "@/i18n";
import { cn } from "@/lib/cn";
import { REMOTE_UNKNOWN_TEXT, toErrorInfo, writeOutcomeUnknown } from "@/lib/errors";
import { displayText, isRecord, previewValue } from "@/lib/json";
import { Disclosure } from "./Disclosure";
import { JsonView } from "./JsonView";
import { formatList } from "@/i18n/format";

/** 遠端結果未知：寫入或呼叫可能仍在 Node 上進行；不自動重送。 */
export function RemoteUnknownNotice({ className }: { className?: string }) {
  return (
    <Callout tone="warning" icon={<CircleHelp />} title={t("遠端結果未知")} className={cn("animate-fade-in", className)}>
      <p>{t("{remoteUnknownText}。系統不會自動重送；請重新讀取狀態後再決定。", { remoteUnknownText: REMOTE_UNKNOWN_TEXT })}</p>
    </Callout>
  );
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function DetailValue({ value }: { value: unknown }) {
  if (isPrimitive(value)) return <span className="machine">{displayText(value)}</span>;
  if (Array.isArray(value) && value.every(isPrimitive)) {
    return <span className="machine">{value.length === 0 ? t("（空）") : formatList(value.map((item) => displayText(item)))}</span>;
  }
  if (Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.message === "string")) {
    return (
      <ul className="grid gap-1">
        {value.map((item, index) => {
          const record = item as Record<string, unknown>;
          const path = typeof record.path === "string" ? record.path : typeof record.field === "string" ? record.field : null;
          return (
            <li key={index} className="text-caption">
              {path ? <span className="machine text-fg">{path || t("（根）")}</span> : null}
              {path ? t("：") : null}
              {displayText(record.message)}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <Disclosure summary={<span className="machine">{previewValue(value, 80)}</span>}>
      <JsonView value={value} label={t("細節")} maxHeightClass="max-h-48" />
    </Disclosure>
  );
}

/** 錯誤細節（details.errors／part／rejected_fields／selector…）逐項列出，不吞掉伺服器提供的資訊。 */
export function ErrorDetails({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;
  return (
    <dl className="mt-1 grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="machine text-fg-tertiary">{key}</dt>
          <dd className="m-0 min-w-0 text-fg-secondary [overflow-wrap:anywhere]">
            <DetailValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 錯誤顯示：標題（呼叫端的 title，否則依錯誤碼的在地化標題，再否則訊息本身）、訊息、錯誤碼、HTTP 狀態、下一步提示、完整 details；
 * 伺服器的固定訊息有譯文時顯示譯文並附上原文（原文不改寫）；動態訊息照原文顯示。
 * remote_outcome_unknown（或寫入時連線中斷）另外顯示「遠端結果未知」。出現時淡入（不位移、不延後 alert）。
 */
export function ErrorCallout({
  error,
  title,
  write = false,
  onRetry,
  retryLabel = t("重新讀取"),
  retrying = false,
  children,
  className,
}: {
  error: unknown;
  title?: string;
  /** 這是寫入／呼叫請求的錯誤：連線中斷代表遠端結果未知。 */
  write?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const info = toErrorInfo(error);
  const unknownOutcome = info.remoteOutcomeUnknown || (write && writeOutcomeUnknown(error));
  const message = tServer(info.message);
  const heading = title ?? info.headline ?? message;
  return (
    <div className={cn("animate-fade-in", className)} role="alert">
      <Callout tone="danger" title={heading}>
        {heading !== message ? <p className="text-fg-secondary">{message}</p> : null}
        {message !== info.message ? (
          <p lang="zh-Hant" className="text-caption text-fg-tertiary [overflow-wrap:anywhere]">
            {t("原文：{message}", { message: info.message })}
          </p>
        ) : null}
        <p className="machine text-caption text-fg-tertiary">
          {info.code}
          {info.status ? ` · HTTP ${info.status}` : ""}
        </p>
        {info.hint ? <p className="text-caption text-fg-secondary">{info.hint}</p> : null}
        <ErrorDetails details={info.details} />
        {children}
        {onRetry ? (
          <div className="pt-1">
            <Button size="sm" icon={<RotateCcw aria-hidden />} onClick={onRetry} pending={retrying}>
              {retryLabel}
            </Button>
          </div>
        ) : null}
      </Callout>
      {unknownOutcome ? <RemoteUnknownNotice className="mt-2" /> : null}
    </div>
  );
}
