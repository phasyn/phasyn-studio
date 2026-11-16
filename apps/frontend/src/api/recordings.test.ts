import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeApi } from "@/test/fakeApi";
import { fetchNodeRecordingPage } from "./recordings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchNodeRecordingPage", () => {

  it("encodes the node id as one path segment", async () => {
    const api = installFakeApi({});
    await expect(fetchNodeRecordingPage("node a/b")).rejects.toMatchObject({ status: 404 });
    expect(api.calls[0]?.path).toBe("/api/nodes/node%20a%2Fb/recordings");
  });
});
