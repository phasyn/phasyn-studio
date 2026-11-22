import { useState } from "react";
import { buildUrl, contractJson } from "@/api/http";
import { useCreateRun, useRun } from "@/api/runs";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/variants";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";

function savedRun(key: string) {
  try { return sessionStorage.getItem(key) ?? ""; } catch { return ""; }
}

export function OtioExchangeReference({ path, revision, basename, regions }: { path: string; revision: number; basename: string; regions: number | null }) {
  const key = "phasyn:otio-reference:" + basename;
  const [runId, setRunId] = useState(() => savedRun(key));
  const [bakeId, setBakeId] = useState(() => savedRun(key + ":bakes:" + savedRun(key)));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const create = useCreateRun();
  const run = useRun(runId || null);
  const bakes = useRun(bakeId || null);
  const referenceReady = run.data?.state === "succeeded";
  const needsBakes = regions !== null && regions > 0;
  const deliveryReady = referenceReady && (!needsBakes || bakes.data?.state === "succeeded");
  async function render(bake: boolean) {
    setPending(true); setError("");
    try {
      const plan = await contractJson("WireRunRequest", path + "/reference-plan", { method: "POST", json: { revision, ...(bake ? { reference_run: runId } : {}) } });
      const job = await create.mutateAsync(plan);
      if (bake) setBakeId(job.run_id);
      else { setRunId(job.run_id); setBakeId(""); }
      try { sessionStorage.setItem(bake ? key + ":bakes:" + runId : key, job.run_id); } catch { /* The run is still available in this view. */ }
    } catch (cause) { setError(errorText(cause)); } finally { setPending(false); }
  }
  return <div className="grid gap-2 rounded-lg border border-line-subtle p-3">
    <h3 className="text-body font-semibold">{t("含合成參考片的交付包")}</h3>
    <p className="text-caption">{t("使用目前完整時間軸產生 MP4，連同字幕 SRT、媒體、OTIO 與轉換報告交付。")}</p>
    {regions !== null && <p className="text-caption">{t("供 Kdenlive 使用的 delivery.otio 含 {count} 段效果素材，每端最多保留 12 幀供修剪。合成素材已含畫面字幕，音軌可分別編輯。", { count: regions })}</p>}
    {deliveryReady ? <a href={buildUrl(path + ".zip", { revision, reference_run: runId, ...(needsBakes ? { bake_run: bakeId } : {}) })} download={basename + "-delivery.zip"} className={buttonVariants({ variant: "primary", size: "sm" })}>{t("下載完整交付 ZIP")}</a>
      : <Button size="sm" disabled={pending || (runId !== "" && (run.isPending || run.data?.state === "running")) || (bakeId !== "" && (bakes.isPending || bakes.data?.state === "running"))} onClick={() => void render(referenceReady)}>
        {referenceReady ? t("產生可修剪的效果素材") : t("產生合成參考片")}</Button>}
    {runId && <span role="status">{bakeId ? (bakes.data?.state ?? bakeId) : (run.data?.state ?? runId)}</span>}
    {(error.length > 0 || (bakes.error ?? bakes.data?.error ?? run.error ?? run.data?.error) != null) && <p role="alert" className="text-warning">{error || errorText(bakes.error ?? bakes.data?.error ?? run.error ?? run.data?.error)}</p>}
  </div>;
}
