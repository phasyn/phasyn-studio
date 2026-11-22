import { expect, it } from "vitest";
import { studioProject, studioShot, studioTake } from "@/test/fixtures/studio";
import { projectReducer } from "./project";

it("keeps a manual or legacy selection when a later video run and its variants complete", () => {
  const old = studioTake({ take_id: "old" });
  const later = studioTake({ take_id: "later" });
  const candidate = studioTake({ take_id: "new", run_id: "run-B", route: "plugin-b", state: "rendering", output_key: "a", seed: 99 });
  const variant = { ...candidate, take_id: "variant", output_key: "b", seed: 101 };
  for (const selected of [null, "old"]) {
    const shot = studioShot({ takes: [old, later, candidate, variant], active_take_id: selected });
    let doc = studioProject({ shots: [shot] });
    for (const item of [candidate, variant]) {
      doc = projectReducer(doc, { type: "updateTake", runId: item.run_id, outputKey: item.output_key,
        patch: { state: "succeeded" }, activateOnSuccess: true });
    }
    expect(doc.shots[0]).toMatchObject({ active_take_id: selected ?? "later", seed: shot.seed });
  }
  let empty = studioProject({ shots: [studioShot({ takes: [candidate, variant] })] });
  for (const item of [variant, candidate]) {
    empty = projectReducer(empty, { type: "updateTake", runId: item.run_id, outputKey: item.output_key,
      patch: { state: "succeeded" }, activateOnSuccess: true });
  }
  expect(empty.shots[0]).toMatchObject({ active_take_id: "variant", seed: variant.seed });
});
