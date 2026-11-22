import type { ReactNode } from "react";
import { Download, RefreshCw } from "lucide-react";
import { useRunRecipe } from "@/api/runRecipe";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { JsonView } from "@/components/common/JsonView";
import { CopyButton } from "@/components/common/values";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { downloadText } from "@/lib/download";
import { formatBytes } from "@/lib/format";

export function RunRecipePanel({ runId, running, renderPreset }: { runId: string; running: boolean; renderPreset?: (provider: string) => ReactNode }) {
  const query = useRunRecipe(runId, running);
  const data = query.data;
  if (query.isError && !data) {
    return <ErrorCallout error={query.error} title={t("無法讀取推論配方")} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  }
  if (!data) return <p role="status" className="text-data text-fg-secondary">{t("讀取推論配方…")}</p>;
  const native = data.steps.find((step) => step.provider === "h3.dit" || step.provider === "qimg.dit");
  const unknown = t("未記錄");
  return (
    <section aria-label={t("推論配方")} className="grid min-w-0 content-start gap-3 animate-fade-in">
      <header className="panel flex min-w-0 flex-wrap items-center gap-3 p-3">
        <div className="min-w-0 flex-1 basis-56">
          <h3 className="text-section font-semibold text-fg">{t("配方 SHA-256")}</h3>
          <div className="mt-1 flex items-center gap-1.5">
            <code className="min-w-0 break-all font-mono text-caption text-fg-secondary">{data.digest}</code>
            <CopyButton value={data.digest} label={t("複製配方 SHA-256")} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="quiet" pending={query.isFetching} icon={<RefreshCw aria-hidden />} onClick={() => void query.refetch()}>
            {t("重新讀取")}
          </Button>
          <Button size="sm" variant="secondary" icon={<Download aria-hidden />} onClick={() => { downloadText(`inference-recipe-${runId}.json`, data.rawJson, "application/json"); }}>
            {t("下載配方 JSON")}
          </Button>
        </div>
      </header>
      {data.succeeded && (native?.provider != null && native.provider !== "") ? renderPreset?.(native.provider) : null}
      {query.isError ? <ErrorCallout error={query.error} title={t("無法更新推論配方")} /> : null}
      {data.steps.map((step) => {
        const fields = [
          [t("取樣步數"), step.steps ?? unknown],
          [t("隨機種子"), step.seed ?? unknown],
          [t("觀測到的權重型別"), step.weightTypes.join(", ") || unknown],
          [t("實際 attention backend"), step.backend ?? unknown],
          [t("已記錄的回退次數"), step.fallbackCalls ?? unknown],
          ...(typeof step.requiredBytes === "number" ? [[t("此步驟估算需求"), formatBytes(step.requiredBytes)]] : []),
        ];
        return (
          <article key={step.id} className="panel grid min-w-0 gap-3 p-3">
            <header className="flex flex-wrap items-baseline gap-x-2">
              <h4 className="break-all font-mono text-data font-semibold text-fg">{step.id}</h4>
              <span className="break-all text-caption text-fg-secondary">{step.component}{(step.provider != null && step.provider !== "") ? ` · ${step.provider}` : ""}</span>
            </header>
            <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-x-4 gap-y-2.5">
              {fields.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-caption text-fg-tertiary">{label}</dt>
                  <dd className="break-words font-mono text-data text-fg-secondary">{value}</dd>
                </div>
              ))}
            </dl>
            <details className="min-w-0 border-t border-line-subtle pt-2">
              <summary className="cursor-pointer rounded-sm text-data text-fg-secondary focus-visible:outline-focus">{t("設定與執行證據")}</summary>
              <JsonView value={step.details} label={t("此步驟的配方與紀錄")} className="mt-2" />
            </details>
          </article>
        );
      })}
    </section>
  );
}
