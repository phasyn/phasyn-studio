import { describe, expect, it } from "vitest";
import { componentAvailability, componentUsable } from "./catalog";
import { parseRunStep } from "./types";

describe("用到才載入的就緒判斷", () => {
  it("已停止的 on_demand 元件算可用（用到時載入），resident 不算", () => {
    expect(componentAvailability({ state: "stopped", load_policy: "on_demand" })).toBe("on_use");
    expect(componentAvailability({ state: "loading", load_policy: "on_demand" })).toBe("on_use");
    expect(componentAvailability({ state: "stopping", load_policy: "on_demand" })).toBe("on_use");
    expect(componentAvailability({ state: "error", load_policy: "on_demand" })).toBe("unavailable");
    expect(componentAvailability({ state: "stopped", load_policy: "resident" })).toBe("unavailable");
    expect(componentAvailability({ state: "stopped" })).toBe("unavailable");
    expect(componentAvailability({ state: "busy" })).toBe("ready");
    expect(componentUsable({ state: "stopped", load_policy: "on_demand" })).toBe(true);
    expect(componentUsable({ state: "stopped" })).toBe(false);
  });

  it("步驟的 component_load 只在 running／waiting 解析，格式不符 → null", () => {
    const load = { phase: "loading", reason: "loading", message: "正在載入 wan", component_id: "wan", holders: [], since: "2026-11-21T00:00:00Z", estimated_load_ms: 42000 };
    expect(parseRunStep("s", { state: "running", component_load: load }).component_load).toEqual(load);
    expect(parseRunStep("s", { state: "succeeded", component_load: load }).component_load).toBeNull();
    expect(parseRunStep("s", { state: "waiting", component_load: { ...load, reason: "other" } }).component_load).toBeNull();
  });
});
