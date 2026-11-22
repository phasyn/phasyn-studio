// Boundary: the no-gaze layout reference only ever uses a clip that passed its checks (every frame free of camera gaze,
// site-safe, own staging), turning it on and off leaves the rest of the shot's references and prompt exactly as they
// were, and the copy check tells an identical frame from an unrelated one. Synthetic data.
import { describe, expect, it } from "vitest";
import { testItem, testRef } from "../../prompt/advisor/testSamples";
import { copyVerdict, scorePair, type GrayFrame } from "./copyCheck";
import { layoutCandidates, parseLayoutClip, parseLayoutLibrary, BUILTIN_LAYOUT_CLIPS } from "./library";
import { activeLayout, layoutLine, rankCandidates, readShot, turnOff, turnOn } from "./plan";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function clip(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wide-faceoff",
    sha256: SHA_A,
    title: { "zh-Hant": "遠景對峙", en: "Wide face-off" },
    shot_size: "wide",
    action: "faceoff",
    cast: 2,
    provenance: { kind: "previs" },
    gaze_check: { verdict: "no-camera-gaze", frames: "all", by: "synthetic", at: "2026-11-21" },
    site_safe: true,
    ...overrides,
  };
}

function video(itemId: string, sha256: string) {
  const item = testItem(itemId, "video", { duration: 4.5, hasAudio: true });
  return { ...item, file: { ...item.file, sha256 } };
}

describe("layout clip library", () => {
  it("ships no clip until one is curated", () => {
    expect(BUILTIN_LAYOUT_CLIPS).toEqual([]);
  });

  it("refuses a clip without a full gaze check, site safety or own staging", () => {
    expect(parseLayoutClip(clip())).not.toBeNull();
    expect(parseLayoutClip(clip({ gaze_check: { verdict: "no-camera-gaze", frames: "sampled", by: "x" } }))).toBeNull();
    expect(parseLayoutClip(clip({ gaze_check: { verdict: "unchecked", frames: "all", by: "x" } }))).toBeNull();
    expect(parseLayoutClip(clip({ site_safe: false }))).toBeNull();
    expect(parseLayoutClip(clip({ provenance: { kind: "film_footage" } }))).toBeNull();
    expect(parseLayoutClip(clip({ sha256: "not-a-hash" }))).toBeNull();
    expect(parseLayoutClip(clip({ span_seconds: 1 }))).toBeNull();
  });

  it("matches project videos by file hash only, once per clip", () => {
    const clips = parseLayoutLibrary({ version: 1, clips: [clip(), clip({ id: "dup" })] });
    expect(clips).toHaveLength(1);
    const library = [video("other", SHA_B), video("v1", SHA_A), video("v2", SHA_A)];
    expect(layoutCandidates(library, clips).map((entry) => entry.item.item_id)).toEqual(["v1"]);
  });
});

describe("turning the layout reference on and off", () => {
  const clips = parseLayoutLibrary({ version: 1, clips: [clip(), clip({ id: "close-clash", sha256: SHA_B, shot_size: "close", action: "clash" })] });
  const library = [testItem("i1", "image"), video("v1", SHA_A), video("v2", SHA_B)];
  const candidates = layoutCandidates(library, clips);
  const prompt = "subject_definitions:\n<Subject 1> is @Image1.\n\ndetailed_description:\n[Shot 1] An extreme close-up as the two blades clash.";
  const references = [testRef("Image1", "image", "i1")];

  it("suggests the clip that matches the opening shot", () => {
    expect(readShot(prompt)).toMatchObject({ shotSize: "close", action: "clash", cast: 1 });
    expect(rankCandidates(prompt, candidates).suggested?.clip.id).toBe("close-clash");
  });

  it("adds a trimmed, silent, unheld video reference and one line, and removes exactly those", () => {
    const suggested = rankCandidates(prompt, candidates).suggested;
    if (!suggested) throw new Error("no suggestion");
    const on = turnOn(prompt, references, suggested, "ref-layout");
    if (!on) throw new Error("not added");
    const added = on.references.find((ref) => ref.ref_id === "ref-layout");
    expect(added).toMatchObject({ kind: "video", alias: "Video1", item_id: "v2", start_seconds: 0, end_seconds: 3, use_embedded_audio: false, hold_last_frame: false });
    expect(on.prompt).toBe(prompt.replace("detailed_description:", `detailed_description:\n${layoutLine("Video1")}`));
    const active = activeLayout(on.prompt, on.references, library, candidates);
    expect(active?.reference.ref_id).toBe("ref-layout");
    if (!active) throw new Error("not active");
    expect(turnOff(on.prompt, on.references, active.reference)).toEqual({ prompt, references });
  });

  it("is off when the line was deleted by hand", () => {
    const suggested = candidates[0];
    if (!suggested) throw new Error("no candidate");
    const on = turnOn(prompt, references, suggested, "ref-layout");
    if (!on) throw new Error("not added");
    expect(activeLayout(prompt, on.references, library, candidates)).toBeNull();
  });
});

describe("copy check", () => {
  function frame(fill: (x: number, y: number) => number): GrayFrame {
    const width = 96;
    const height = 54;
    const data = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[y * width + x] = fill(x, y);
    return { width, height, data };
  }
  const figure = frame((x, y) => ((x - 30) ** 2 + (y - 27) ** 2 < 120 ? 0.9 : 0.1));
  const elsewhere = frame((x, y) => (x > 70 && y < 20 ? 0.8 : 0.2));

  it("calls an identical layout copied and an unrelated one loose", () => {
    expect(copyVerdict([scorePair(0.4, figure, figure)])?.verdict).toBe("copied");
    expect(copyVerdict([scorePair(0.4, figure, elsewhere)])?.verdict).toBe("loose");
    expect(copyVerdict([])).toBeNull();
  });
});
