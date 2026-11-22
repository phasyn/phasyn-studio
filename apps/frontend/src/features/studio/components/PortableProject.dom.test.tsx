// Boundary test of the 專案可攜包 download (data integrity): a package the Controller refuses because media is missing
// is reported in the dialog by name and nothing is saved; a complete package is handed to the browser once.
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeError, installFakeApi } from "@/test/fakeApi";
import { fileRef } from "@/test/fixtures/pipeline";
import { studioProject } from "@/test/fixtures/studio";
import { renderWithProviders } from "@/test/render";
import { PortableDownload } from "./PortableProject";

const MISSING = "c".repeat(64);
const project = studioProject({
  revision: 7,
  library: [{ item_id: "lib-1", kind: "image", name: "miss.png", file: fileRef("f-lib", { sha256: MISSING, size_bytes: 1, media_type: "image/png" }), created_at: "2026-11-21T00:00:00Z", duration_seconds: null, width: 128, height: 72, has_audio: false }],
});
const projectPath = `/api/studio/projects/${project.project_id}`;

afterEach(() => { vi.restoreAllMocks(); });

describe("PortableDownload", () => {
  it("names the missing media of a refused package and saves nothing", async () => {
    const save = vi.spyOn(URL, "createObjectURL");
    const { calls } = installFakeApi({
      [`GET ${projectPath}`]: () => project,
      [`GET ${projectPath}/portable`]: () => fakeError(409, "STATE_CONFLICT", "專案可攜包仍有缺件", { missing: [{ sha256: MISSING, reason: "FILE_NOT_FOUND" }, { sha256: "d".repeat(64), reason: "FILE_NOT_FOUND" }] }),
    });
    const { user } = renderWithProviders(<PortableDownload project={project} flush={() => Promise.resolve()} />);
    await user.click(screen.getByRole("button", { name: "下載 .zip" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("沒有打包：有 2 個檔案找不到");
    expect(alert).toHaveTextContent("miss.png");
    expect(alert).toHaveTextContent("另外還有 1 個生成中間檔");
    expect(alert).not.toHaveTextContent(MISSING);
    expect(alert).not.toHaveTextContent("STATE_CONFLICT");
    expect(save).not.toHaveBeenCalled();
    expect(calls.find((call) => call.path.endsWith("/portable"))?.query.get("revision")).toBe("7");
  });

  it("hands a complete package to the browser under the Controller's file name", async () => {
    const save = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:package");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    installFakeApi({
      [`GET ${projectPath}`]: () => project,
      [`GET ${projectPath}/portable`]: () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="project-${project.project_id}-r7.zip"` } }),
    });
    const { user } = renderWithProviders(<PortableDownload project={project} flush={() => Promise.resolve()} />);
    await user.click(screen.getByRole("button", { name: "下載 .zip" }));
    expect(await screen.findByText("已打包完成，檔案交給瀏覽器下載。")).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0]).toHaveProperty("download", `project-${project.project_id}-r7.zip`);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
