// A refused 專案可攜包 names what is missing in the project's words (library item names, 「鏡頭 take n」), never by hash.
import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/http";
import { mediaAsset, studioProject, studioShot, studioTake } from "@/test/fixtures/studio";
import { fileRef } from "@/test/fixtures/pipeline";
import { importTitle, missingDigests, portableMissing } from "./portableMissing";

const sha = (char: string) => char.repeat(64);
const refused = (missing: unknown) => new ApiError(409, { code: "STATE_CONFLICT", message: "專案可攜包仍有缺件", details: { missing } }, "HTTP 409", "GET");

describe("missingDigests", () => {
  it("reads the digests of a refused package", () => {
    expect(missingDigests(refused([{ sha256: sha("b"), reason: "FILE_NOT_FOUND" }]))).toEqual([sha("b")]);
  });

  it("is null for any other failure", () => {
    expect(missingDigests(new ApiError(500, { code: "RUNTIME_ERROR", message: "x" }, "HTTP 500", "GET"))).toBeNull();
    expect(missingDigests(refused([]))).toBeNull();
    expect(missingDigests(new Error("offline"))).toBeNull();
  });
});

describe("portableMissing", () => {
  const take = (id: string, char: string) => studioTake({ take_id: id, asset: mediaAsset({ file: fileRef(`f-${id}`, { sha256: sha(char), size_bytes: 1, media_type: "video/mp4" }) }) });
  const project = studioProject({
    library: [{ item_id: "lib-1", kind: "image", name: "miss.png", file: fileRef("f-lib", { sha256: sha("c"), size_bytes: 1, media_type: "image/png" }), created_at: "2026-11-21T00:00:00Z", duration_seconds: null, width: 128, height: 72, has_audio: false }],
    shots: [studioShot({ title: "鏡頭二", takes: [take("t1", "d"), take("t2", "e")] })],
  });
  const takeName = (shot: string, number: number) => `${shot} take ${String(number)}`;

  it("names library items and takes, and counts the files the project does not name", () => {
    expect(portableMissing(project, [sha("c"), sha("e"), sha("f"), sha("0")], takeName)).toEqual({ names: ["miss.png", "鏡頭二 take 2"], others: 2 });
  });

  it("names a file used twice once", () => {
    expect(portableMissing(project, [sha("c"), sha("c")], takeName)).toEqual({ names: ["miss.png"], others: 0 });
  });
});

describe("importTitle", () => {
  it("marks the copy as imported and numbers it when that name is taken", () => {
    expect(importTitle("夜景", ["夜景"])).toBe("夜景（匯入）");
    expect(importTitle("夜景", ["夜景", "夜景（匯入）"])).toBe("夜景（匯入 2）");
    expect(importTitle("夜景", ["夜景（匯入）", "夜景（匯入 2）"])).toBe("夜景（匯入 3）");
  });

  it("names an untitled package and keeps the title within 200 characters", () => {
    expect(importTitle("  ", [])).toBe("未命名專案（匯入）");
    expect(importTitle("長".repeat(300), []).length).toBeLessThanOrEqual(200);
  });
});
