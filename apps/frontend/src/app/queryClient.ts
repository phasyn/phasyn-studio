import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/http";
import { qk } from "@/api/keys";
import { setRunNamer } from "@/lib/errors";
import { isRecord } from "@/lib/json";
import { runDisplayName, type NamedRun } from "@/lib/runName";

/**
 * The app's QueryClient.
 *
 * Requests go out whatever the browser says about the network (`networkMode: "always"`). TanStack Query's default
 * ("online") pauses queries and mutations while the browser reports offline and sends them by itself once it is back
 * online: a write the user saw stuck (and may have given up on) would then be sent later without them. Here an offline
 * write fails at once with the network error, so the UI reports that its remote outcome is unknown and never resends
 * it, and an offline read shows its connection error.
 *
 * Reads may retry once on a transient error (no response, 502, 504) and are read again when the connection returns;
 * 4xx are not retried. Writes (mutations) are never resent.
 */
export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: "always",
        // "always" turns reconnect refetches off by default; reading again changes nothing, so keep them
        refetchOnReconnect: true,
        staleTime: 2000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) =>
          failureCount < 1 && error instanceof ApiError && (error.status === 0 || error.status === 502 || error.status === 504),
      },
      mutations: { networkMode: "always", retry: false },
    },
  });
  // Failure texts name a run by what the app already read about it (its own query or a run list), never by its id
  setRunNamer((runId) => {
    const own = client.getQueryData(qk.run(runId));
    if (isNamedRun(own)) return runDisplayName(own);
    for (const [, data] of client.getQueriesData({ queryKey: qk.runs() })) {
      const pages = isRecord(data) && Array.isArray(data["pages"]) ? data["pages"] : [];
      for (const page of pages) {
        const items: unknown = isRecord(page) ? page["items"] : null;
        if (!Array.isArray(items)) continue;
        const found: unknown = items.find((item) => isRecord(item) && item["run_id"] === runId);
        if (isNamedRun(found)) return runDisplayName(found);
      }
    }
    return null;
  });
  return client;
}

function isNamedRun(value: unknown): value is NamedRun {
  if (!isRecord(value) || typeof value["run_id"] !== "string" || !isRecord(value["request"])) return false;
  const pipeline = value["request"]["pipeline"];
  return isRecord(pipeline) && typeof pipeline["label"] === "string";
}
