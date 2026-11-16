// 「這次呼叫」：此 instance 最近一次 invoke 的 recording context（effective／observed）。
// 以 operation=invoke 篩選（x-phasyn-extension），取最新一筆。
import { useQuery } from "@tanstack/react-query";
import type { Recording } from "@/api/generated/contracts";
import { qk } from "@/api/keys";
import { fetchRecordingPage } from "@/api/recordings";

export function useLatestInvokeRecording(nodeId: string, componentId: string) {
  return useQuery({
    queryKey: qk.latestInvoke(nodeId, componentId),
    queryFn: async ({ signal }): Promise<Recording | null> => {
      const page = await fetchRecordingPage({ node_id: nodeId, component_id: componentId, operation: "invoke", limit: 1 }, signal);
      return page.items.find((item) => item.context.operation === "invoke") ?? null;
    },
    staleTime: 5000,
    refetchInterval: 15_000,
    retry: false,
  });
}
