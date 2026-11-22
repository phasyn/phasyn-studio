// Data-integrity boundary: "overwrite with this version" from a stale tab must not undo what another tab saved.
import { describe, expect, it } from "vitest";
import { resolveConflicts, threeWayMerge } from "./threeWayMerge";

const track = (id: string, muted: boolean) => ({ track_id: id, kind: id.startsWith("a") ? "audio" : "video", name: id, muted, locked: false });
const project = (revision: number, a1Muted: boolean, title: string, shots: { shot_id: string; prompt: string }[]) => ({
  project_id: "p1",
  revision,
  title,
  shots,
  timeline: { version: 2, tracks: [track("video-1", false), track("audio-1", a1Muted)], clips: [] },
});

describe("threeWayMerge", () => {
  it("keeps A1 muted when a stale tab overwrites (tab A muted A1, tab B edits a prompt from the old draft)", () => {
    const base = project(711, false, "film", [{ shot_id: "s1", prompt: "old" }]);
    const latest = project(712, true, "film", [{ shot_id: "s1", prompt: "old" }]); // tab A: mute A1
    const mine = project(711, false, "film", [{ shot_id: "s1", prompt: "new" }]); // tab B: stale draft, edits a prompt
    const result = threeWayMerge(base, latest, mine);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toMatchObject({
      timeline: { tracks: [{ track_id: "video-1" }, { track_id: "audio-1", muted: true }] },
      shots: [{ prompt: "new" }], revision: 712,
    });
    expect(result.latestKept).toContain("timeline.tracks[audio-1].muted");
    expect(result.mineApplied).toContain("shots[s1].prompt");
  });

  it("reports a field both sides changed and applies the person's choice", () => {
    const base = project(1, false, "a", []);
    const latest = project(2, false, "b", []);
    const mine = project(1, false, "c", []);
    const result = threeWayMerge(base, latest, mine);
    expect(result.conflicts.map((c) => c.path)).toEqual(["title"]);
    expect(result.merged).toMatchObject({ title: "b" });
    expect(resolveConflicts(base, latest, mine, new Map([["title", "mine"]]))).toMatchObject({ title: "c" });
    expect(resolveConflicts(base, latest, mine, new Map())).toMatchObject({ title: "b" });
  });

  it("keeps a shot another tab added and drops a shot this tab removed", () => {
    const base = project(1, false, "f", [{ shot_id: "s1", prompt: "x" }, { shot_id: "s2", prompt: "y" }]);
    const latest = project(2, false, "f", [{ shot_id: "s1", prompt: "x" }, { shot_id: "s2", prompt: "y" }, { shot_id: "s3", prompt: "z" }]);
    const mine = project(1, false, "f", [{ shot_id: "s1", prompt: "x" }]);
    const merged = threeWayMerge(base, latest, mine).merged;
    expect(merged).toMatchObject({ shots: [{ shot_id: "s1" }, { shot_id: "s3" }] });
  });
});
