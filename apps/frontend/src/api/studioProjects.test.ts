// Save / read ordering of the Studio project API (fetch is faked; no network): page-exit saves use keepalive only
// when the body is small enough, and a read waits for this tab's in-flight saves of the same project.
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioProject } from "@/test/fixtures";
import { KEEPALIVE_BODY_LIMIT, keepaliveAllowed, saveProject } from "./studioProjects";

interface Call {
  url: string;
  method: string;
  keepalive: boolean | undefined;
  resolve: (body: unknown) => void;
  reject: (error: unknown) => void;
}

/** A fetch that records each request and answers when the test says so. */
function deferredFetch() {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    return new Promise<Response>((resolve, reject) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        keepalive: init.keepalive,
        resolve: (body) => { resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })); },
        reject,
      });
    });
  });
  return calls;
}
const project = (id: string) => studioProject({ project_id: id, revision: 3 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("keepalive body limit", () => {
  it("uses keepalive only within the UTF-8 byte limit (a CJK character is 3 bytes)", () => {
    expect(keepaliveAllowed("a".repeat(KEEPALIVE_BODY_LIMIT))).toBe(true);
    expect(keepaliveAllowed("a".repeat(KEEPALIVE_BODY_LIMIT + 1))).toBe(false);
    expect(keepaliveAllowed("鏡".repeat(Math.floor(KEEPALIVE_BODY_LIMIT / 3)))).toBe(true);
    expect(keepaliveAllowed("鏡".repeat(Math.floor(KEEPALIVE_BODY_LIMIT / 3) + 1))).toBe(false);
  });

  it("page-exit saves: small projects use keepalive, large ones a normal request", () => {
    const calls = deferredFetch();
    void saveProject(project("small"), { keepalive: true });
    void saveProject({ ...project("big"), title: "x".repeat(KEEPALIVE_BODY_LIMIT) }, { keepalive: true });
    void saveProject(project("normal"));
    expect(calls.map((call) => [call.url, call.method, call.keepalive])).toEqual([
      ["/api/studio/projects/small", "PUT", true],
      ["/api/studio/projects/big", "PUT", false],
      ["/api/studio/projects/normal", "PUT", false],
    ]);
  });
});
