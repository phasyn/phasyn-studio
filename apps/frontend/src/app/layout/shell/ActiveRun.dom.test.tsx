import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeApi } from "@/test/fakeApi";
import { pipeline, run } from "@/test/fixtures";
import { uid } from "@/test/ids";
import { renderWithProviders } from "@/test/render";
import { ActiveRun } from "./ActiveRun";

const RUN_ID = uid(1001);

describe("ActiveRun", () => {
  it("shows the running run and sends one cancel request after confirmation", async () => {
    const active = run(pipeline("t2va-local", []), { run_id: RUN_ID, state: "running", label: "夜景" });
    const api = installFakeApi({
      "GET /api/runs": () => ({ items: [active], next_cursor: null }),
      [`POST /api/runs/${RUN_ID}/cancel`]: () => ({ run_id: RUN_ID, accepted: true, message: "已送出取消" }),
    });
    const { user } = renderWithProviders(<ActiveRun />);

    expect(await screen.findByRole("link", { name: /夜景/ })).toHaveAttribute("href", `/records/runs/${RUN_ID}`);
    await user.click(screen.getByRole("button", { name: "取消 run 夜景" }));
    await user.click(await screen.findByRole("button", { name: "取消 run" }));

    expect(await screen.findByText("已受理取消")).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([expect.objectContaining({ path: `/api/runs/${RUN_ID}/cancel` })]);
  });
});
