// Ctrl+Enter in the shot properties panel: renders when the shot can render, waits while a render is being sent, and
// otherwise explains why (the disabled 「渲染鏡頭」 button's reason) instead of doing nothing.
import { describe, expect, it } from "vitest";
import { shortcutRender } from "./useRenderBlock";

describe("shortcutRender", () => {
  it("renders a shot that can render", () => {
    expect(shortcutRender({ problem: null, preflight: null }, null)).toEqual({ action: "render" });
  });

  it("waits while a render request is being sent", () => {
    expect(shortcutRender({ problem: null, preflight: null }, "render")).toEqual({ action: "wait" });
  });

  it("explains a blocked shot with the same reason as the button", () => {
    expect(shortcutRender({ problem: null, preflight: { kind: "engine", text: "DiT 已停止", items: [] } }, null)).toEqual({ action: "explain", reason: "DiT 已停止" });
    expect(shortcutRender({ problem: "先在「Prompt」分頁輸入 prompt", preflight: null }, null)).toEqual({ action: "explain", reason: "先在「Prompt」分頁輸入 prompt" });
    expect(shortcutRender({ problem: null, preflight: null }, "export")).toMatchObject({ action: "explain" });
  });
});
