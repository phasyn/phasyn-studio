import { ExternalLink } from "lucide-react";
import { Link } from "react-router";
import type { WireRun } from "@/api/types";
import { runSteps } from "@/api/types";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { StatusBadge } from "@/components/common/StatusBadge";
import { runPath } from "@/app/paths";
import { Elapsed } from "./Elapsed";
import { runErrorTitle, stepErrorTitle } from "./runModel";
import { t } from "@/i18n";

/** 嵌入式 run 狀態：狀態、耗時、失敗步驟的完整錯誤與明細連結（輪詢由 useRun 負責）。 */
export function RunStatusLine({ run, label }: { run: WireRun; label: string }) {
  const running = run.state === "running";
  const failed = runSteps(run).find((step) => step.error !== null || step.remote_outcome_unknown);
  return (
    <div className="grid gap-2">
      <p className="flex flex-wrap items-center gap-2 text-data text-fg-secondary">
        <span>{label}</span>
        <StatusBadge kind="run" value={run.state} />
        <span className="machine text-caption">
          <Elapsed start={run.created_at} end={run.finished_at} running={running} />
        </span>
        <Link to={runPath(run.run_id)} className="inline-flex items-center gap-1 text-data">
          run {run.run_id.slice(0, 8)}
          <ExternalLink aria-hidden className="size-3.5" />
        </Link>
        {running ? <span className="text-caption text-fg-tertiary">{t("執行中，自動更新")}</span> : null}
      </p>
      {run.state === "interrupted" ? <p className="text-caption text-warning">{t("run 已中斷（Controller 曾重新啟動）；沒有恢復，請重新執行。")}</p> : null}
      {failed?.error ? (
        <ErrorCallout
          error={{ ...failed.error, remote_outcome_unknown: failed.error.remote_outcome_unknown === true || failed.remote_outcome_unknown }}
          title={stepErrorTitle(failed)}
        />
      ) : run.error ? (
        <ErrorCallout error={run.error} title={runErrorTitle(run)} />
      ) : null}
    </div>
  );
}
