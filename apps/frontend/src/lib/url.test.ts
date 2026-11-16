import { describe, expect, it } from "vitest";
import { hasDotSegment, httpUrl, pathSegment } from "./url";

describe("server-supplied links and path segments", () => {
  it("renders only http(s) addresses as links", () => {
    expect(httpUrl("https://huggingface.co/Qwen/Qwen-Image-2.1/tree/abc")).toBe("https://huggingface.co/Qwen/Qwen-Image-2.1/tree/abc");
    expect(httpUrl("http://mirror.test:8080/x")).toBe("http://mirror.test:8080/x");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "//host/x", "/relative", "", null, 7]) {
      expect(httpUrl(bad)).toBeNull();
    }
  });

  it("never lets an id retarget a request to the level above", () => {
    expect(pathSegment("00000000-0000-4000-8000-000000000001")).toBe("00000000-0000-4000-8000-000000000001");
    expect(pathSegment("a/b c")).toBe("a%2Fb%20c");
    expect([pathSegment("."), pathSegment("..")]).toEqual(["_", "_"]);
    expect(hasDotSegment("/api/media/../catalog")).toBe(true);
    expect(hasDotSegment("/api/runs/./x?y=../z")).toBe(true);
    expect(hasDotSegment("/api/runs/a..b/v1.2?path=../x")).toBe(false);
  });
});
