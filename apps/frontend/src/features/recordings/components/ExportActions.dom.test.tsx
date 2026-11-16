// Export redaction is opt-in: the links carry the chosen categories; traces cannot be redacted, so the trace download
// is blocked while any category is chosen (nothing is requested).
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeApi } from "@/test/fakeApi";
import { renderWithProviders } from "@/test/render";
import { ExportActions } from "./ExportActions";

describe("紀錄匯出：遮蔽", () => {
  it("預設不遮蔽；勾選後連結帶 redact，trace 不能下載", async () => {
    const { calls } = installFakeApi({});
    const { user } = renderWithProviders(<ExportActions recordingId="rec-1" traceExpected />);
    const jsonl = screen.getByRole("link", { name: /JSONL/ });
    expect(jsonl).toHaveAttribute("href", "/api/recordings/rec-1/export?format=jsonl");
    await user.click(screen.getByRole("checkbox", { name: "檔案路徑（只留檔名）" }));
    await user.click(screen.getByRole("checkbox", { name: "主機名稱" }));
    expect(jsonl).toHaveAttribute("href", "/api/recordings/rec-1/export?format=jsonl&redact=hostname%2Cpaths");
    expect(screen.getByRole("link", { name: /診斷 ZIP/ })).toHaveAttribute("href", "/api/recordings/rec-1/export?format=zip&redact=hostname%2Cpaths");
    const trace = screen.getByRole("button", { name: "trace" });
    expect(trace).toHaveAttribute("aria-disabled", "true");
    expect(trace).toHaveAccessibleDescription("trace 不支援遮蔽：取消勾選遮蔽後才能下載");
    await user.click(trace);
    expect(calls).toEqual([]);
  });
});
