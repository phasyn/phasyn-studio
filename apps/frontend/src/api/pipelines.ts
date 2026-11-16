import { useMutation, useQuery, useQueryClient, type MutationOptions, type QueryClient } from "@tanstack/react-query";
import type { PipelineLayout } from "./generated/contracts";
import { ApiError, apiJson } from "./http";
import { qk } from "./keys";
import type { WirePipeline } from "./types";
import { t } from "@/i18n";

export interface PipelineList {
  items: WirePipeline[];
}

/**
 * 已保存的元件組合。左欄在整個元件修改區都掛著這個查詢（不會重新掛載），
 * 所以切回這個視窗時重新讀取：在其他視窗或分頁刪除的元件組合不會一直留在清單上。
 */
export function usePipelines() {
  return useQuery({
    queryKey: qk.pipelines(),
    queryFn: ({ signal }) => apiJson<PipelineList>("/api/pipelines", { signal }),
    staleTime: 5000,
    refetchOnWindowFocus: true,
  });
}

export function usePipeline(pipelineId: string | null) {
  return useQuery({
    queryKey: qk.pipeline(pipelineId ?? ""),
    queryFn: ({ signal }) => apiJson<WirePipeline>(`/api/pipelines/${encodeURIComponent(pipelineId ?? "")}`, { signal }),
    enabled: pipelineId !== null && pipelineId.length > 0,
    staleTime: 5000,
  });
}

/** pipeline_id 排序（與伺服器 Python sorted() 相同：本地 ID 只有 ASCII）。 */
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 新建的元件組合在分類與排序中的位置（與伺服器 normalize_layout 相同）：從未保存（revision 0）時全部依 ID 排序；
 * 已保存過時，沒有列到的元件組合接在未分類最後。已經列在某處就不變。
 */
export function layoutWithNewPipeline(layout: PipelineLayout, pipelineId: string): PipelineLayout {
  if (layout.groups.some((group) => group.pipeline_ids.includes(pipelineId)) || layout.ungrouped.includes(pipelineId)) return layout;
  const ungrouped = [...layout.ungrouped, pipelineId];
  return { ...layout, ungrouped: layout.revision === 0 ? ungrouped.sort(byId) : ungrouped };
}

/** 依分類與排序的顯示順序排列清單（GET /api/pipelines 的順序）；分類沒有列到的接在最後並依 ID 排序。 */
export function orderPipelines<T extends { pipeline_id: string }>(items: readonly T[], layout: PipelineLayout): T[] {
  const order = [...layout.groups.flatMap((group) => group.pipeline_ids), ...layout.ungrouped];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(a.pipeline_id) ?? order.length) - (rank.get(b.pipeline_id) ?? order.length) || byId(a.pipeline_id, b.pipeline_id));
}

/**
 * 保存成功後的快取：單筆、清單（新建的放在伺服器會排的位置，不是一律最後）與分類排序；之後重新讀取確認。
 * 分類與排序正在保存時不改它的快取（交給那一串保存與之後的重新讀取）。
 */
export function applySavedPipeline(client: QueryClient, saved: WirePipeline): void {
  client.setQueryData(qk.pipeline(saved.pipeline_id), saved);
  const layoutSaving = client.isMutating({ mutationKey: qk.pipelineLayoutSave() }) > 0;
  const current = client.getQueryData<PipelineLayout>(qk.pipelineLayout());
  const layout = current && !layoutSaving ? layoutWithNewPipeline(current, saved.pipeline_id) : current;
  if (layout && layout !== current) client.setQueryData(qk.pipelineLayout(), layout);
  client.setQueryData<PipelineList>(qk.pipelines(), (list) => {
    if (!list) return list;
    const exists = list.items.some((item) => item.pipeline_id === saved.pipeline_id);
    if (exists) return { items: list.items.map((item) => (item.pipeline_id === saved.pipeline_id ? saved : item)) };
    return { items: layout ? orderPipelines([...list.items, saved], layout) : [...list.items, saved] };
  });
  void client.invalidateQueries({ queryKey: qk.pipelines() });
  if (!layoutSaving) void client.invalidateQueries({ queryKey: qk.pipelineLayout() });
}

/** PUT 只保存，不執行。 */
export function useSavePipeline() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pipeline: WirePipeline) =>
      apiJson<WirePipeline>(`/api/pipelines/${encodeURIComponent(pipeline.pipeline_id)}`, { method: "PUT", json: pipeline }),
    onSuccess: (saved) => applySavedPipeline(client, saved),
  });
}

/** 伺服器上已經沒有這個元件組合：丟掉單筆快取、立即從清單快取移除，再重新讀取清單。 */
export function forgetPipeline(client: QueryClient, pipelineId: string): void {
  client.removeQueries({ queryKey: qk.pipeline(pipelineId), exact: true });
  client.setQueryData<PipelineList>(qk.pipelines(), (list) => (list ? { items: list.items.filter((item) => item.pipeline_id !== pipelineId) } : list));
  void client.invalidateQueries({ queryKey: qk.pipelines() });
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "NOT_FOUND" || error.status === 404);
}

/**
 * 刪除已保存的元件組合（x-phasyn-extension）；已建立的 run 保有自己凍結的副本，不受影響。
 * 伺服器回 NOT_FOUND＝已經被刪除（例如在另一個視窗）：同樣從快取移除（開著的編輯器隨後會卸載），
 * 所以呼叫端在 mutate 的 onError 直接回到清單並在清單上說明（features/pipelines/listNotice）。
 */
export function useDeletePipeline() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pipelineId: string) =>
      apiJson<{ pipeline_id: string; deleted: boolean }>(`/api/pipelines/${encodeURIComponent(pipelineId)}`, { method: "DELETE" }),
    retry: false,
    onSuccess: (_result, pipelineId) => forgetPipeline(client, pipelineId),
    onError: (error, pipelineId) => {
      if (isNotFound(error)) forgetPipeline(client, pipelineId);
    },
  });
}

// ---------------------------------------------------------------- 分類與排序（x-phasyn-extension）

const LAYOUT_PATH = "/api/pipeline-layout";

/**
 * 元件組合的分類與排序。從未保存＝revision 0、沒有分類、全部在 ungrouped；伺服器讀取時已依目前的元件組合正規化。
 * 與清單一樣切回視窗時重新讀取（其他視窗可能改過）。
 */
export function usePipelineLayout() {
  return useQuery({
    queryKey: qk.pipelineLayout(),
    queryFn: ({ signal }) => apiJson<PipelineLayout>(LAYOUT_PATH, { signal }),
    staleTime: 5000,
    refetchOnWindowFocus: true,
  });
}

/** 分類與排序的內容；revision／updated_at 在送出時以最後一次伺服器確認的版本補上。 */
export type PipelineLayoutContent = Pick<PipelineLayout, "groups" | "ungrouped">;

export interface LayoutSaveVariables {
  content: PipelineLayoutContent;
  /** 呼叫 mutate 當下的 layoutSaveEpoch：之後若有排在前面的保存失敗，這個變更就不送出。 */
  epoch: number;
}

/** 同一串連續保存中，排在前面的保存失敗了：這個變更沒有送出（快取已還原成伺服器確認的版本）。 */
export class LayoutSaveSkipped extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super(t("前一個變更沒有保存成功，這個變更沒有送出"));
    this.name = "LayoutSaveSkipped";
    this.reason = reason;
  }
}

interface LayoutSaveChain {
  /** 最後一次伺服器確認的文件（送出時的 revision、失敗時還原的對象）。 */
  confirmed: PipelineLayout | null;
  epoch: number;
  lastError: unknown;
}

const chains = new WeakMap<QueryClient, LayoutSaveChain>();

function chainOf(client: QueryClient): LayoutSaveChain {
  let chain = chains.get(client);
  if (!chain) {
    chain = { confirmed: null, epoch: 0, lastError: null };
    chains.set(client, chain);
  }
  return chain;
}

/** 目前的保存世代（呼叫 mutate 前讀取，放進 LayoutSaveVariables.epoch）。 */
export function layoutSaveEpoch(client: QueryClient): number {
  return chainOf(client).epoch;
}

export function putPipelineLayout(layout: PipelineLayout): Promise<PipelineLayout> {
  return apiJson<PipelineLayout>(LAYOUT_PATH, { method: "PUT", json: layout });
}

/**
 * 保存分類與排序（PUT 整份）的 mutation 設定；與 hook 分開，方便在沒有 React 的單元測試中驗證。
 *
 * - 樂觀更新：立即改快取；失敗時還原成最後一次伺服器確認的版本，並重新讀取分類與清單（409、已刪除的元件組合、
 *   遠端結果未知都以伺服器為準）。
 * - 連續操作（例如連按 Alt+↓）以 mutation scope 依序送出：輪到時才以最後確認的 revision 送出那一刻的完整內容，
 *   不會因為前一個請求還沒回來而自己撞上 409。前一個失敗時，後面排隊的變更不送出（LayoutSaveSkipped）。
 * - 不自動重送：失敗就停下，由使用者重新操作。
 */
export function pipelineLayoutMutationOptions(
  client: QueryClient,
  put: (layout: PipelineLayout) => Promise<PipelineLayout> = putPipelineLayout,
): MutationOptions<PipelineLayout, unknown, LayoutSaveVariables> {
  const mutationKey = qk.pipelineLayoutSave();
  const pending = () => client.isMutating({ mutationKey });
  return {
    mutationKey,
    scope: { id: mutationKey.join(":") },
    retry: false,
    onMutate: async ({ content }) => {
      await client.cancelQueries({ queryKey: qk.pipelineLayout(), exact: true });
      const current = client.getQueryData<PipelineLayout>(qk.pipelineLayout());
      const chain = chainOf(client);
      // 這是一串保存的第一個：快取就是伺服器確認的版本
      if (pending() <= 1) chain.confirmed = current ?? null;
      if (current) client.setQueryData<PipelineLayout>(qk.pipelineLayout(), { ...current, groups: content.groups, ungrouped: content.ungrouped });
    },
    mutationFn: async ({ content, epoch }) => {
      const chain = chainOf(client);
      if (epoch !== chain.epoch) throw new LayoutSaveSkipped(chain.lastError);
      if (!chain.confirmed) throw new Error(t("分類與排序尚未讀取，無法保存"));
      return put({ revision: chain.confirmed.revision, updated_at: chain.confirmed.updated_at, groups: content.groups, ungrouped: content.ungrouped });
    },
    onSuccess: (saved) => {
      chainOf(client).confirmed = saved;
      if (pending() > 1) {
        // 後面還有排隊的變更：畫面維持樂觀內容，只換成新的 revision
        client.setQueryData<PipelineLayout>(qk.pipelineLayout(), (old) => (old ? { ...old, revision: saved.revision, updated_at: saved.updated_at } : saved));
        return;
      }
      client.setQueryData(qk.pipelineLayout(), saved);
      // 清單（Studio 運算路由、推理頁）依新的順序重新讀取
      void client.invalidateQueries({ queryKey: qk.pipelines() });
    },
    onError: (error) => {
      if (error instanceof LayoutSaveSkipped) return;
      const chain = chainOf(client);
      chain.epoch += 1;
      chain.lastError = error;
      if (chain.confirmed) client.setQueryData(qk.pipelineLayout(), chain.confirmed);
      void client.invalidateQueries({ queryKey: qk.pipelineLayout() });
      void client.invalidateQueries({ queryKey: qk.pipelines() });
    },
  };
}

/** 保存分類與排序：見 pipelineLayoutMutationOptions。呼叫端以 mutate({ content, epoch: layoutSaveEpoch(client) }) 送出。 */
export function useSavePipelineLayout() {
  const client = useQueryClient();
  return useMutation(pipelineLayoutMutationOptions(client));
}

/** 保存失敗的原因（排隊而沒有送出的變更，回報讓它停下的那個錯誤）。 */
export function layoutSaveCause(error: unknown): unknown {
  return error instanceof LayoutSaveSkipped ? error.reason : error;
}

/** 422 回報的不存在（已刪除）的 pipeline_id。 */
export function unknownPipelineIds(error: unknown): string[] {
  const cause = layoutSaveCause(error);
  if (!(cause instanceof ApiError) || cause.code !== "INVALID_ARGUMENT") return [];
  const ids = cause.details.unknown_pipeline_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}
