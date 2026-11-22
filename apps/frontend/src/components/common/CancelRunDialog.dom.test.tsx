import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeHandler } from "@/test/fakeApi";
import { pipeline, run } from "@/test/fixtures";
import { uid } from "@/test/ids";
import { renderWithProviders } from "@/test/render";
import { CancelRunDialog } from "./CancelRunDialog";

const RUN_ID = uid(1001);
const CANCEL = `POST /api/runs/${RUN_ID}/cancel`;
const RUNNING = run(pipeline("t2va-local", []), { run_id: RUN_ID, state: "running", label: "夜景" });

function setup(cancel: FakeHandler, scope?: string) {
  const api = installFakeApi({ [CANCEL]: cancel });
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const view = renderWithProviders(<CancelRunDialog run={RUNNING} open onOpenChange={onOpenChange} scope={scope} />);
  const posts = () => api.calls.filter((call) => call.method === "POST");
  return { ...view, onOpenChange, posts };
}

describe("CancelRunDialog", () => {
  it("names the run, shows the scope and sends one cancel request however fast it is clicked", async () => {
    const { user, posts } = setup(() => ({ call_id: null, process_exited: null, accepted: true, message: "已送出取消" }), "批次的 3 個鏡頭都會停止");
    expect(screen.getByRole("dialog", { name: "取消 run「夜景」？" })).toBeInTheDocument();
    expect(screen.getByText("批次的 3 個鏡頭都會停止")).toBeInTheDocument();
    expect(screen.getByText(RUN_ID)).toBeInTheDocument();

    await user.dblClick(screen.getByRole("button", { name: "取消 run" }));
    expect(await screen.findByText("已受理取消")).toBeInTheDocument();
    expect(screen.getByText("已送出取消")).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "取消 run" })).toBeNull();
    // The footer's text button replaces "不要取消" (the dialog's own × button is also named 關閉)
    expect(screen.getByText("關閉", { selector: "button" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "不要取消" })).toBeNull();
  });

  it("closes without sending anything when the user keeps the run", async () => {
    const { user, onOpenChange, posts } = setup(() => ({ call_id: null, process_exited: null, accepted: true, message: "已送出取消" }));
    await user.click(screen.getByRole("button", { name: "不要取消" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(posts()).toHaveLength(0);
  });
});
