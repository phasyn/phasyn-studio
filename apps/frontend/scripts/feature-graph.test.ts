import { describe, it } from "vitest";
import { inspectBoundaries } from "./check-boundaries.mjs";

/** Optional test entry delegates to the same static gate that always runs under pnpm lint. */
describe("source architecture boundaries", () => {
  it("keeps feature entries, shared layers and editor domain dependencies valid", () => {
    const result = inspectBoundaries();
    if (result.problems.length > 0) throw new Error(`\n${result.problems.join("\n")}\n`);
  });
});
