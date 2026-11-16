import { LoaderCircle, Square } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useActiveRuns } from "@/api/runs";
import type { WireRun } from "@/api/types";
import { PATHS, runPath } from "@/app/paths";
import { CancelRunDialog } from "@/components/common/CancelRunDialog";
import { pageFocusTarget } from "@/components/common/routeFocus";
import { returnFocusOr } from "@/components/ui/focusReturn";
import { cn } from "@/lib/cn";
import { runDisplayName } from "@/lib/runName";
import { t } from "@/i18n";

/**
 * 頂欄右側的進行中 run（只有 state=running 的 run 時出現）：連到 run 詳情的狀態膠囊＋取消鈕（先確認範圍）。
 * 主控同時執行多個 run 時，膠囊顯示最早開始的那個，旁邊的「+N」連到 run 列表。
 * 膠囊底部一條品牌漸層的掃描線只表示「正在執行」，不是進度（沒有比例）。
 * The cancel confirmation sits beside the chip, not inside it: when the run ends the chip leaves, while the dialog
 * stays with the Controller's answer until the user closes it; focus then goes to the page.
 */
export function ActiveRun() {
  const { runs } = useActiveRuns();
  // The earliest started of the running runs (the list is newest first); the others are counted in the +N link
  const running = runs.at(-1) ?? null;
  const others = runs.length - 1;
  // The run being confirmed (as it was when asked) and the button that asked
  const [confirming, setConfirming] = useState<{ run: WireRun; opener: HTMLElement } | null>(null);
  const label = running ? runDisplayName(running) : "";
  return (
    <>
      {running ? (
        <div className="flex min-w-0 items-center gap-1 animate-fade-in">
          <Link
            to={runPath(running.run_id)}
            className={cn(
              "pressable relative inline-flex h-8 min-w-0 items-center gap-1.5 overflow-hidden rounded-full border border-info/35 bg-info/10 pr-3 pl-2.5 text-caption text-info no-underline",
              "hover:border-info/70 hover:bg-info/15",
            )}
            title={t("執行中：{label}（{run_id}）", { label, run_id: running.run_id })}
          >
            <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin" />
            <span className="max-w-56 truncate">{t("執行中：{label}", { label })}</span>
            <span aria-hidden className="absolute inset-x-3 bottom-0 h-px bg-brand-gradient opacity-80 animate-shimmer" />
          </Link>
          {others > 0 ? (
            <Link
              to={PATHS.runs}
              className="pressable inline-flex h-8 shrink-0 items-center rounded-full border border-info/35 bg-info/10 px-2.5 text-caption text-info no-underline hover:border-info/70 hover:bg-info/15"
              title={t("另外還有 {count} 個 run 在執行", { count: others })}
            >
              +{others}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={(event) => setConfirming({ run: running, opener: event.currentTarget })}
            aria-label={t("取消 run {label}", { label })}
            title={t("取消這個 run（會先確認）")}
            className="pressable grid size-8 shrink-0 place-items-center rounded-full border border-line-subtle bg-sunken text-danger hover:border-danger/60 hover:bg-danger/10 active:bg-sunken"
          >
            <Square aria-hidden className="size-3 fill-current" />
          </button>
        </div>
      ) : null}
      {confirming ? (
        <CancelRunDialog
          run={confirming.run}
          open
          onOpenChange={(open) => (open ? undefined : setConfirming(null))}
          onCloseAutoFocus={(event) => returnFocusOr(event, confirming.opener, pageFocusTarget())}
        />
      ) : null}
    </>
  );
}
