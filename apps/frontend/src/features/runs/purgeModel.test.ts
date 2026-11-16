import { describe, expect, it } from "vitest";
import type { PurgeResult } from "@/api/runs";
import { summarizePlans } from "./purgeModel";

const plan = (runId: string, files: PurgeResult["files"], projects: PurgeResult["projects"] = [], recordings = 0): PurgeResult => ({
  run_id: runId,
  dry_run: true,
  deleted: false,
  files,
  recordings: { planned: recordings, deleted: 0 },
  projects,
});

describe("purge summary", () => {
  it("merges files once, keeps unknown sizes out of the byte total and merges projects", () => {
    const a = plan(
      "r1",
      [
        { node_id: "node-a", file_id: "f1", size_bytes: 1000, status: "planned" },
        { node_id: "node-a", file_id: "f2", size_bytes: null, status: "planned" },
      ],
      [{ project_id: "p1", title: "合成專案", takes_removed: ["t1"], exports_removed: [], revision: null }],
      3,
    );
    const b = plan(
      "r2",
      [
        { node_id: "node-a", file_id: "f1", size_bytes: 1000, status: "planned" },
        { node_id: "node-b", file_id: "f3", size_bytes: 500, status: "planned" },
      ],
      [{ project_id: "p1", title: "合成專案", takes_removed: ["t2"], exports_removed: ["x1"], revision: null }],
      2,
    );
    const summary = summarizePlans([a, b]);
    expect(summary).toMatchObject({ runs: 2, files: 3, knownBytes: 1500, unknownSizes: 1, recordings: 5 });
    expect(summary.nodes.sort()).toEqual(["node-a", "node-b"]);
    expect(summary.projects).toEqual([{ project_id: "p1", title: "合成專案", takes: 2, exports: 1 }]);
  });
});
