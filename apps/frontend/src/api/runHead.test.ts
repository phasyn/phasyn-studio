// The running chip notices runs started outside this tab: the newest run is news when the list does not have it or has
// it in another state; otherwise nothing is read again.
import { describe, expect, it } from "vitest";
import { runHeadIsNews } from "./runs";

describe("runHeadIsNews", () => {
  const listed = [{ run_id: "a", state: "succeeded" as const }, { run_id: "b", state: "running" as const }];

  it("is news for a run the list does not know", () => {
    expect(runHeadIsNews({ run_id: "new", state: "running" }, listed)).toBe(true);
  });

  it("is news when the run changed state since the list was read", () => {
    expect(runHeadIsNews({ run_id: "b", state: "succeeded" }, listed)).toBe(true);
  });

  it("is not news for a run the list already shows as it is, or before either is read", () => {
    expect(runHeadIsNews({ run_id: "a", state: "succeeded" }, listed)).toBe(false);
    expect(runHeadIsNews(undefined, listed)).toBe(false);
    expect(runHeadIsNews({ run_id: "a", state: "running" }, undefined)).toBe(false);
  });
});
