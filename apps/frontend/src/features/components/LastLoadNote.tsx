// 停止常駐元件的確認框用：這個元件最近一次 load 的實測耗時（效能紀錄的 host_wall_ms），讓使用者知道重新載入大約要多久。
// 只讀（GET /api/recordings?operation=load&limit=1）；沒有紀錄就照實說沒有，不估計。
// The exclusive-group replacement shows it for the component about to load (action "load"), which may never have loaded.
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/api/keys";
import { fetchRecordingPage } from "@/api/recordings";
import { formatMetric, formatTimestamp } from "@/lib/format";
import { t } from "@/i18n";

export function LastLoadNote({
  nodeId,
  componentId,
  action = "reload",
}: {
  nodeId: string;
  componentId: string;
  /** What the time is for: reloading a component that is about to stop (the default), or loading one now. */
  action?: "reload" | "load";
}) {
  const query = useQuery({
    queryKey: qk.lastLoad(nodeId, componentId),
    queryFn: ({ signal }) => fetchRecordingPage({ node_id: nodeId, component_id: componentId, operation: "load", limit: 1 }, signal),
    staleTime: 60_000,
    retry: false,
  });
  const last = query.data?.items[0];
  let text: string;
  if (query.isPending) text = t("讀取最近一次載入的紀錄…");
  else if (query.isError) text = action === "load" ? t("讀不到載入紀錄：無法得知載入要多久") : t("讀不到載入紀錄：無法得知重新載入要多久");
  else if (!last) text = action === "load" ? t("沒有這個元件的載入紀錄：無法得知載入要多久") : t("沒有這個元件的載入紀錄：無法得知重新載入要多久");
  else if (last.summary.state !== "succeeded") text = t("最近一次載入（{created_at}）狀態 {state}，沒有可參考的耗時", { created_at: formatTimestamp(last.context.created_at), state: last.summary.state });
  else text = t("最近一次載入實測 {host_wall_ms}（host_wall_ms，{created_at}；受 page cache 影響）", { host_wall_ms: formatMetric(last.summary.metrics.host_wall_ms), created_at: formatTimestamp(last.context.created_at) });
  return (
    <p role="status" className="text-caption text-fg-secondary">
      {text}
    </p>
  );
}
