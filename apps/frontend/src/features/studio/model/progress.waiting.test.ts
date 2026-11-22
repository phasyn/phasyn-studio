// A fix run whose step waits for the GPU another render holds is queued, not running: its card in the take strip said
// 「執行中 · 剛開始」 for minutes while 畫質修復 waited behind a Wan render.
import { describe, expect, it } from "vitest";
import { waitingForResource } from "./progress";

describe("waitingForResource", () => {
  it("is true while every started step waits", () => {
    expect(waitingForResource([{ state: "waiting" }])).toBe(true);
    expect(waitingForResource([{ state: "succeeded" }, { state: "waiting" }, { state: "pending" }])).toBe(true);
  });

  it("is false once a step runs, or when nothing waits", () => {
    expect(waitingForResource([{ state: "running" }, { state: "waiting" }])).toBe(false);
    expect(waitingForResource([{ state: "pending" }])).toBe(false);
    expect(waitingForResource([])).toBe(false);
  });
});
