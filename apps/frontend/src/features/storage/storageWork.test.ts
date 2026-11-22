import { describe, expect, it } from "vitest";
import { workCleanupText } from "./storageModel";

const WORK = { count: 4, size_bytes: 3 * 1024 ** 3, enabled: true, ttl_hours: 24, last_sweep: null };

describe("work directory cleanup text", () => {
  it("says the rule, and that nothing ran yet", () => {
    const text = workCleanupText(WORK);
    expect(text).toContain("24 小時");
    expect(text).toContain("執行中的不會動");
    expect(text).toContain("還沒清理過");
  });

  it("reports the last sweep", () => {
    const text = workCleanupText({ ...WORK, last_sweep: { at: "2026-11-21T12:00:00Z", removed: 3, freed_bytes: 24 * 1024 ** 3, failed: 0 } });
    expect(text).toContain("刪除 3 個");
    expect(text).toContain("釋放 ");
  });

  it("says when the cleanup is off", () => {
    expect(workCleanupText({ ...WORK, enabled: false })).toContain("自動清理已關閉");
  });
});
