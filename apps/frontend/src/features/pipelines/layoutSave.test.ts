import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { PipelineLayout } from "@/api/generated/contracts";
import { ApiError } from "@/api/http";
import { qk } from "@/api/keys";
import { LayoutSaveSkipped, layoutSaveCause, layoutSaveEpoch, pipelineLayoutMutationOptions, type PipelineLayoutContent } from "@/api/pipelines";

interface PendingPut {
  body: PipelineLayout;
  resolve: (value: PipelineLayout) => void;
  reject: (error: unknown) => void;
}

/** 假的 PUT：每個請求先掛著，由測試決定何時、以什麼結果回來。 */
function fakeServer() {
  const calls: PendingPut[] = [];
  const put = (body: PipelineLayout) =>
    new Promise<PipelineLayout>((resolve, reject) => {
      calls.push({ body, resolve, reject });
    });
  return { calls, put };
}

const BASE: PipelineLayout = { revision: 4, updated_at: "2026-10-18T00:00:00.000Z", groups: [], ungrouped: ["a", "b", "c"] };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(qk.pipelineLayout(), BASE);
  const server = fakeServer();
  const save = (content: PipelineLayoutContent) => {
    const observer = new MutationObserver(client, pipelineLayoutMutationOptions(client, server.put));
    return observer.mutate({ content, epoch: layoutSaveEpoch(client) }).catch((error: unknown) => error);
  };
  const cached = () => client.getQueryData<PipelineLayout>(qk.pipelineLayout());
  return { client, server, save, cached };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("分類與排序的保存", () => {

  it("409：還原成伺服器確認的版本、重新讀取；排在後面的變更不送出，也不自動重試", async () => {
    const { client, server, save, cached } = setup();
    const first = save({ groups: [], ungrouped: ["b", "a", "c"] });
    await flush();
    const second = save({ groups: [], ungrouped: ["b", "c", "a"] });
    await flush();
    const conflict = new ApiError(409, { code: "REVISION_CONFLICT", message: "已在其他地方更新", details: { stored_revision: 9, expected_revision: 4 } }, "HTTP 409");
    server.calls[0]?.reject(conflict);
    expect(await first).toBe(conflict);
    const skipped = await second;
    expect(skipped).toBeInstanceOf(LayoutSaveSkipped);
    expect(layoutSaveCause(skipped)).toBe(conflict);
    expect(server.calls).toHaveLength(1);
    expect(cached()).toEqual(BASE);
    expect(client.getQueryState(qk.pipelineLayout())?.isInvalidated).toBe(true);

    // 失敗之後的新操作照常送出（新的保存世代）
    const third = save({ groups: [], ungrouped: ["c", "b", "a"] });
    await flush();
    expect(server.calls).toHaveLength(2);
    server.calls[1]?.resolve({ ...BASE, revision: 5, ungrouped: ["c", "b", "a"] });
    await third;
    expect(cached()?.revision).toBe(5);
  });
});
