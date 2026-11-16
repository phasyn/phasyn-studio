import { describe, expect, it } from "vitest";
import type { Metric } from "@/api/generated/contracts";
import { csvCell, metricRows, toCsv } from "./csv";

const metric = (value: number | null, extra: Partial<Metric> = {}): Metric => ({
  value,
  unit: "ms",
  quality: "instrumented",
  scope: "call",
  method: "host_monotonic",
  reason: null,
  ...extra,
});

describe("null 不是 0", () => {

  it("CSV：null 留空並寫原因；字串公式字首加單引號；數字不跳脫", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("-1+2")).toBe("'-1+2");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    const rows = metricRows("rec", { a: metric(null), b: metric(null, { quality: "not_applicable" }), c: metric(0) });
    expect(rows).toEqual([
      ["rec", "a", null, "ms", "instrumented", "host_monotonic", "call", "未量測", null],
      ["rec", "b", null, "ms", "not_applicable", "host_monotonic", "call", "不適用", null],
      ["rec", "c", 0, "ms", "instrumented", "host_monotonic", "call", null, null],
    ]);
    expect(toCsv(["v"], [[null], [0]])).toBe("v\r\n\r\n0");
  });
});
