// dock 紀錄表的精簡狀態列：讀取中、空狀態（圖示＋一行）、單一來源讀取失敗（部分資料／過時資料）。
import { LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { cn } from "@/lib/cn";
import { toErrorInfo } from "@/lib/errors";
import type { SourceStatus } from "./status";
import { t, tServer } from "@/i18n";

/** 圖示＋一行說明（＋可選動作），放在表頭下方。 */
export function LogMessage({ icon, children, action, className }: { icon: ReactNode; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-3 text-data text-fg-secondary", className)}>
      <span aria-hidden className="shrink-0 text-fg-tertiary [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0">{children}</span>
      {action}
    </div>
  );
}

export function LogLoading({ label: labelProp }: { label?: string }) {
  const label = labelProp ?? t("讀取中…");
  return (
    <div role="status" className="grid gap-1.5 px-3 py-3">
      <span className="flex items-center gap-2 text-data text-fg-secondary">
        <LoaderCircle aria-hidden className="size-4 shrink-0 text-fg-tertiary animate-spin" />
        {label}
      </span>
      {/* 紀錄列的佔位（與表格列同高）。 */}
      <span aria-hidden className="skeleton block h-[18px] w-11/12 animate-shimmer" />
      <span aria-hidden className="skeleton block h-[18px] w-3/4 animate-shimmer" />
      <span aria-hidden className="skeleton block h-[18px] w-5/6 animate-shimmer" />
    </div>
  );
}

/** 完全讀不到資料時的錯誤（可重試）；放在表格區內，由表格區捲動。 */
export function LogError({ error, title, onRetry, retrying }: { error: unknown; title: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div className="p-2">
      <ErrorCallout error={error} title={title} onRetry={onRetry} {...(retrying === undefined ? {} : { retrying })} />
    </div>
  );
}

/**
 * 單一來源讀取失敗：其他來源照常顯示。
 * 有舊資料＝畫面是過時資料（明講），沒有資料＝這個來源的紀錄缺席。
 */
export function SourceErrorRow({ status, onRetry, retrying = false }: { status: SourceStatus; onRetry: () => void; retrying?: boolean }) {
  if (!(status.error != null)) return null;
  const info = toErrorInfo(status.error);
  // A fixed server message reads in the interface language (other text stays as it is)
  const message = tServer(info.message);
  return (
    <div role="alert" className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line-subtle bg-sunken px-3 py-1 text-caption">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
      <span className="text-fg-secondary">{status.hasData ? t("「{label}」更新失敗，下方是先前讀到的資料", { label: status.label }) : t("「{label}」讀取失敗，下方不含這個來源", { label: status.label })}</span>
      <code className="machine text-warning">{info.code}</code>
      <span className="min-w-0 flex-1 basis-40 truncate text-fg-tertiary" title={message}>
        {message}
      </span>
      <Button size="sm" variant="quiet" icon={<RotateCcw aria-hidden />} pending={retrying} onClick={onRetry} className="min-h-6 px-2 text-caption">
        {t("重試")}
      </Button>
    </div>
  );
}
