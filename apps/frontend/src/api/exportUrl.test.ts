import { describe, expect, it } from "vitest";
import { exportUrl } from "./http";

describe("exportUrl", () => {
  it("sends only the format by default (no redaction)", () => {
    expect(exportUrl("rec/1", "jsonl")).toBe("/api/recordings/rec%2F1/export?format=jsonl");
    expect(exportUrl("rec-1", "trace", [])).toBe("/api/recordings/rec-1/export?format=trace");
  });

  it("sends the redaction categories comma-separated", () => {
    expect(exportUrl("rec-1", "zip", ["hostname", "paths"])).toBe("/api/recordings/rec-1/export?format=zip&redact=hostname%2Cpaths");
    expect(exportUrl("rec-1", "csv", ["all"])).toBe("/api/recordings/rec-1/export?format=csv&redact=all");
  });
});
