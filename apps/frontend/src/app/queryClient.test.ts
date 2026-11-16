// The app's QueryClient while the browser reports offline: requests are sent and fail at once, and a write is never
// held back and sent later by itself.
import { MutationObserver, onlineManager, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiJson } from "@/api/http";
import { writeOutcomeUnknown } from "@/lib/errors";
import { createQueryClient } from "./queryClient";

/** What fetch does in a browser without a network. */
const offlineFetch = () => Promise.reject(new TypeError("Failed to fetch"));

let client: QueryClient;

beforeEach(() => {
  client = createQueryClient();
  // Subscribes to the online manager like QueryClientProvider does (that is what resumes paused work on reconnect).
  client.mount();
  onlineManager.setOnline(false);
});

afterEach(() => {
  onlineManager.setOnline(true);
  client.unmount();
  client.clear();
  vi.unstubAllGlobals();
});

describe("createQueryClient while the browser reports offline", () => {
  it("sends a write at once, ends it with a network error of unknown outcome and never resends it on reconnect", async () => {
    const fetchMock = vi.fn(offlineFetch);
    vi.stubGlobal("fetch", fetchMock);
    const observer = new MutationObserver(client, { mutationFn: () => apiJson("/api/runs", { method: "POST", json: { pipeline_id: "p" } }) });

    const settled = observer.mutate().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(observer.getCurrentResult().status).toBe("error"));

    expect(observer.getCurrentResult().isPaused).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const error = await settled;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("NETWORK_ERROR");
    expect(writeOutcomeUnknown(error)).toBe(true);

    onlineManager.setOnline(true);
    await client.resumePausedMutations();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
