// The weights dialog: it lists what the component needs and what the Node already has,
// downloads only after the license box is ticked (one POST with accept_licenses), shows the Node's byte progress while
// the job runs and can cancel it; a failed job shows its error and offers to continue. The network is the in-memory
// Controller (installFakeApi); the data is synthetic.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NodeView } from "@/api/catalog";
import type { WeightsDownloadJob, WeightsView } from "@/api/generated/contracts";
import { installFakeApi, type FakeRequest } from "@/test/fakeApi";
import { catalog, descriptor } from "@/test/fixtures";
import { NODE_A_ID, NODE_A_LABEL } from "@/test/ids";
import { renderWithProviders } from "@/test/render";
import { WeightsDialog } from "./WeightsDialog";

const target = descriptor(NODE_A_ID, "qimg-te", "qimg.conditioning", { state: "stopped", resourceGroup: "gpu-0" });
const node: NodeView = { node_id: NODE_A_ID, label: NODE_A_LABEL, snapshot: null, directory: null, liveness: "online", stale: false };
const entry = { descriptor: target, node, key: `${NODE_A_ID}::qimg-te` };
const BASE = `/api/nodes/${NODE_A_ID}/components/qimg-te/weights`;
const GIB = 1024 ** 3;

function job(patch: Partial<WeightsDownloadJob> = {}): WeightsDownloadJob {
  return {
    job_id: "00000000-0000-4000-8000-000000000009",
    component_id: "qimg-te",
    state: "running",
    started_at: "2026-11-04T00:00:00.000Z",
    finished_at: null,
    sets: ["qwen-image-2.1"],
    files_total: 2,
    files_done: 0,
    files_linked: 0,
    bytes_total: 4 * GIB,
    bytes_done: GIB,
    current: { path: "qwen-image-2.1/transformer/model-00001.safetensors", phase: "download", bytes_done: GIB, bytes_total: 4 * GIB },
    error: null,
    ...patch,
  };
}

function weightsView(jobValue: WeightsDownloadJob | null = null): WeightsView {
  return {
    component_id: "qimg-te",
    root: "/models",
    root_exists: true,
    sets: [
      {
        set_id: "qwen-image-2.1",
        label: "Qwen-Image 2.1",
        repo: "Qwen/Qwen-Image-2.1",
        revision: "d26bb61231c349cf6b7896fa83353113880e1ba3",
        license: { name: "Qwen Research License Agreement", url: "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/x/LICENSE", note: "研究用途：Qwen-Image 2.1 權重採 Qwen Research License（僅限非商業研究），不隨本專案散布" },
        dest: "qwen-image-2.1",
        files_total: 3,
        bytes_total: 5 * GIB + 100,
        files_present: 1,
        bytes_present: 100,
        files_missing: 2,
        bytes_missing: 5 * GIB,
        files_mismatch: 0,
        bytes_mismatch: 0,
        files_linkable: 0,
        bytes_linkable: 0,
        bytes_partial: GIB,
        files: [
          { path: "model_index.json", size: 100, status: "present", partial_bytes: null, link_from: null },
          { path: "transformer/model-00001.safetensors", size: 4 * GIB, status: "partial", partial_bytes: GIB, link_from: null },
          { path: "vae/diffusion_pytorch_model.safetensors", size: GIB, status: "missing", partial_bytes: null, link_from: null },
        ],
      },
    ],
    notes: [],
    free_bytes: 100 * GIB,
    source: { endpoint: "https://huggingface.co", token: false },
    job: jobValue,
  };
}

const posts = (calls: readonly FakeRequest[]) => calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body]);

describe("WeightsDialog", () => {
  it("downloads only after the license is accepted, then shows the progress and can cancel", async () => {
    let current: WeightsView = weightsView();
    const { calls } = installFakeApi({
      "GET /api/catalog": () => catalog([target]),
      [`GET ${BASE}`]: () => current,
      [`POST ${BASE}/download`]: () => {
        current = weightsView(job());
        return job();
      },
      [`POST ${BASE}/cancel`]: () => {
        current = weightsView(job({ state: "cancelled", current: null, finished_at: "2026-11-04T00:00:05.000Z" }));
        return current.job;
      },
    });
    const { user } = renderWithProviders(<WeightsDialog entry={entry} open onOpenChange={() => undefined} />);
    const dialog = await screen.findByRole("dialog", { name: "模型權重：qimg-te" });
    expect(await within(dialog).findByText("Qwen-Image 2.1")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Qwen Research License Agreement" })).toHaveAttribute("href", expect.stringContaining("LICENSE"));
    expect(within(dialog).getByText(/僅限非商業研究/)).toBeInTheDocument();
    expect(within(dialog).getByText(/暫存檔已有 1\.00 GiB，會接著下載/)).toBeInTheDocument();

    // 4 GiB left: 3 GiB of the partial DiT shard plus the 1 GiB VAE
    const download = within(dialog).getByRole("button", { name: /^下載（4\.00 GiB）/ });
    expect(download).toHaveAttribute("aria-disabled", "true");
    await user.click(download);
    expect(posts(calls)).toEqual([]);

    await user.click(within(dialog).getByRole("checkbox", { name: /我已閱讀並同意上面列出的授權條款/ }));
    await user.click(within(dialog).getByRole("button", { name: /^下載（4\.00 GiB）/ }));
    await waitFor(() => { expect(posts(calls)).toEqual([[`${BASE}/download`, { accept_licenses: true, replace_mismatched: false }]]); });

    expect(await within(dialog).findByRole("progressbar", { name: "權重下載進度" })).toBeInTheDocument();
    expect(within(dialog).getByText(/正在下載：/)).toHaveTextContent("qwen-image-2.1/transformer/model-00001.safetensors");
    await user.click(within(dialog).getByRole("button", { name: "取消下載" }));
    await waitFor(() => { expect(posts(calls).at(-1)).toEqual([`${BASE}/cancel`, undefined]); });
    expect(await within(dialog).findByText("下載已取消")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^繼續下載（4\.00 GiB）/ })).toBeInTheDocument();
  });
});
