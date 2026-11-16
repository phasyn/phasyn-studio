import { describe, expect, it } from "vitest";
import { asRunStepPreview } from "@/api/types";

const preview = { seq: 3, step: 12, total: 40, width: 384, height: 256, media_type: "image/jpeg", size_bytes: 20480, note: "vae_thumbnail", at: "2026-10-18T00:00:00.000Z", url: "/api/runs/r/steps/dit/preview?seq=3" };

describe("asRunStepPreview", () => {
  it("parses a valid preview and rejects malformed ones", () => {
    expect(asRunStepPreview(preview)).toEqual(preview);
    expect(asRunStepPreview({ ...preview, note: null })?.note).toBeNull();
    expect(asRunStepPreview({ ...preview, media_type: "image/gif" })).toBeNull();
    expect(asRunStepPreview({ ...preview, url: "http://evil/x" })).toBeNull();
    expect(asRunStepPreview({ ...preview, step: 1.5 })).toBeNull();
    expect(asRunStepPreview(null)).toBeNull();
  });
});
