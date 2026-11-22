import { useQuery } from "@tanstack/react-query";
import { contractJson } from "./http";
import { qk } from "./keys";

/** 主控所在主機（不固定為某種 OS／機器）。 */
export function useController() {
  return useQuery({
    queryKey: qk.controller(),
    queryFn: ({ signal }) => contractJson("ControllerInfo", "/api/controller", { signal }),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
