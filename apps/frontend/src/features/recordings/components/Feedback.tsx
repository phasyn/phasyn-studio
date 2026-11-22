import { isNonzeroNumber } from "@/lib/json";
// 狀態回饋：錯誤（文字＋圖示＋代碼）、過時、載入中、合成示例、載入更多、複製。
import { ArrowDownToLine, Check, ChevronDown, Copy, FlaskConical, LoaderCircle, RotateCcw, Unplug } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { buttonVariants } from "@/components/ui/variants";
import { cn } from "@/lib/cn";
import { writeClipboard } from "../model/clipboard";
import { describeError } from "../model/errors";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export function QueryErrorCallout({
  error,
  title,
  onRetry,
  retrying = false,
  className,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const info = describeError(error);
  return (
    <Callout tone="danger" title={title ?? info.headline} className={className} role="alert">
      {(title != null && title !== "") ? <p>{info.headline}</p> : null}
      {(info.serverMessage != null && info.serverMessage !== "") ? <p className="text-fg-secondary">{info.serverMessage}</p> : null}
      <p className="machine text-caption text-fg-tertiary">
        {info.code}
        {isNonzeroNumber(info.status) ? ` · HTTP ${String(info.status)}` : ""}
      </p>
      {info.remoteUnknown ? <p className="text-warning">{t("遠端結果未知：請重新讀取狀態後再決定是否重試，不會自動重送。")}</p> : null}
      {onRetry ? (
        <div className="pt-1">
          <Button size="sm" icon={<RotateCcw aria-hidden />} onClick={onRetry} pending={retrying}>
            {t("重新讀取")}
          </Button>
        </div>
      ) : null}
    </Callout>
  );
}

/** 已有資料但最近一次更新失敗：保留舊資料並明示可能過時。 */
export function StaleNotice({ error, onRetry, retrying = false }: { error: unknown; onRetry: () => void; retrying?: boolean }) {
  const info = describeError(error);
  return (
    <Callout tone="warning" title={t("顯示的是先前讀取的資料，可能已過時")} role="status">
      <p>
        <T source={"最近一次重新讀取失敗：{headline}<0>（{code}）</0>"} values={{ headline: info.headline, code: info.code }} slots={[<span key="slot-0" className="machine ml-1 text-caption text-fg-tertiary" />]} />
      </p>
      <div className="pt-1">
        <Button size="sm" icon={<RotateCcw aria-hidden />} onClick={onRetry} pending={retrying}>
          {t("重新讀取")}
        </Button>
      </div>
    </Callout>
  );
}

/**
 * 整區沒有資料時的讀取失敗。連不上主控（NETWORK_ERROR）用「離線」插圖的空狀態（仍是 role=alert、保留代碼與重新讀取）；
 * 其他錯誤照常用錯誤說明框。只換呈現，不自動重試。
 */
export function QueryErrorState({
  error,
  title,
  onRetry,
  retrying = false,
  className,
}: {
  error: unknown;
  title: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const info = describeError(error);
  if (info.code !== "NETWORK_ERROR") {
    return (
      <div className={cn("p-4", className)}>
        <QueryErrorCallout error={error} title={title} {...(onRetry === undefined ? {} : { onRetry })} retrying={retrying} />
      </div>
    );
  }
  return (
    <div role="alert" className={className}>
      <EmptyState
        illustration="offline"
        icon={<Unplug />}
        title={title}
        description={
          <>
            <p>{info.headline}</p>
            <p className="machine text-caption text-fg-tertiary">{info.code}</p>
          </>
        }
        action={
          onRetry ? (
            <Button size="sm" icon={<RotateCcw aria-hidden />} onClick={onRetry} pending={retrying}>
              {t("重新讀取")}
            </Button>
          ) : null
        }
      />
    </div>
  );
}

/**
 * 讀取中：旋轉圖示＋文字（role=status）。rows＞0 時下方加幾列 shimmer 佔位（第一次讀取清單或表格時，
 * 形狀接近即將出現的內容）。佔位只是裝飾（aria-hidden），狀態由文字告知。
 */
export function LoadingBlock({ label, rows = 0, className }: { label: string; rows?: number; className?: string }) {
  return (
    <div role="status" className={cn("grid content-start gap-3 px-1 py-6", className)}>
      <span className="flex items-center gap-2 text-data text-fg-secondary">
        <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />
        {label}
      </span>
      {rows > 0 ? (
        <span aria-hidden className="grid gap-1.5">
          {Array.from({ length: rows }, (_, index) => (
            <span key={index} className="skeleton block h-7 animate-shimmer" style={{ opacity: 1 - index * 0.12 }} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** 合成資料整區標示（context.synthetic=true 或 quality=synthetic）。 */
export function SyntheticBanner({ children }: { children?: ReactNode }) {
  return (
    <Callout tone="warning" icon={<FlaskConical />} title={t("合成示例")} role="note">
      <p>{children ?? t("此區所有數值都是合成示例（synthetic），不是線上設備的實際量測，也不代表任何 GPU 效能。")}</p>
    </Callout>
  );
}

/**
 * 「載入更多」：無更多或進行中時改用 aria-disabled 而非 disabled，焦點留在原按鈕、不跳走；
 * 新列插在按鈕之前，捲動位置不變。
 */
export function LoadMoreButton({
  onLoad,
  pending,
  hasMore,
  label: labelProp,
  doneLabel: doneLabelProp,
  className,
  describedBy,
}: {
  onLoad: () => void;
  pending: boolean;
  hasMore: boolean;
  label?: string;
  doneLabel?: string;
  className?: string;
  describedBy?: string;
}) {
  const label = labelProp ?? t("載入更多");
  const doneLabel = doneLabelProp ?? t("已無更多");
  const inactive = pending || !hasMore;
  return (
    <button
      type="button"
      aria-disabled={inactive || undefined}
      aria-busy={pending || undefined}
      aria-describedby={describedBy}
      onClick={() => {
        if (!inactive) onLoad();
      }}
      className={cn(
        buttonVariants({ variant: "secondary", size: "sm" }),
        "pressable pointer-coarse:min-h-11 aria-disabled:cursor-not-allowed aria-disabled:border-line-subtle aria-disabled:bg-raised aria-disabled:text-fg-disabled",
        className,
      )}
    >
      {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : hasMore ? <ChevronDown aria-hidden /> : <ArrowDownToLine aria-hidden />}
      {pending ? t("載入中…") : hasMore ? label : doneLabel}
    </button>
  );
}

/** 複製完整值；結果以 aria-live 告知，不搶焦點。 */
export function CopyButton({ text, label: labelProp, className }: { text: string; label?: string; className?: string }) {
  const label = labelProp ?? t("複製");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => { setState("idle"); }, 2000);
    return () => { window.clearTimeout(timer); };
  }, [state]);
  return (
    <button
      type="button"
      onClick={() => {
        void writeClipboard(text).then((ok) => { setState(ok ? "copied" : "failed"); });
      }}
      className={cn(
        "pressable inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-tertiary hover:bg-raised hover:text-fg active:bg-sunken pointer-coarse:size-11",
        className,
      )}
      aria-label={label}
      title={label}
    >
      {state === "copied" ? <Check aria-hidden className="size-3.5 text-success" /> : <Copy aria-hidden className="size-3.5" />}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? t("已複製") : state === "failed" ? t("複製失敗，請手動選取") : ""}
      </span>
    </button>
  );
}

/** 長 ID：縮寫顯示，完整值保留在 title 與複製按鈕。 */
export function IdText({ value, length = 8, className }: { value: string | null | undefined; length?: number; className?: string }) {
  if (!(value != null && value !== "")) return <span className="text-fg-tertiary">—</span>;
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center align-middle", className)}>
      <code className="machine truncate text-fg-secondary" title={value}>
        {value.length > length + 1 ? `${value.slice(0, length)}…` : value}
      </code>
      <CopyButton text={value} label={t("複製完整值 {value}", { value })} />
    </span>
  );
}
