// The permanent-delete confirmation says what the runs made: images for image runs, videos for video runs, and output
// files in general otherwise. The network is the shared in-memory Controller (installFakeApi).
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeApi } from "@/test/fakeApi";
import { uid } from "@/test/ids";
import { renderWithProviders } from "@/test/render";
import { RunDeleteDialog } from "./RunDeleteDialog";

const RUN_ID = uid(2001);

describe("RunDeleteDialog", () => {
  it.each([
    { runs: "image runs", outputKind: "image", description: "會刪除 run 產生的圖片與中間檔（在各 Node 上）、主控上的效能紀錄，以及 Studio 專案中對它的引用。無法復原；只想先收起來請用「封存」。" },
    { runs: "video runs", outputKind: "video", description: "會刪除 run 產生的影片與中間檔（在各 Node 上）、主控上的效能紀錄，以及 Studio 專案中對它的引用。無法復原；只想先收起來請用「封存」。" },
    { runs: "other runs", outputKind: undefined, description: "會刪除 run 產生的輸出檔與中間檔（在各 Node 上）、主控上的效能紀錄，以及 Studio 專案中對它的引用。無法復原；只想先收起來請用「封存」。" },
  ] as const)("names what $runs made", async ({ outputKind, description }) => {
    installFakeApi({ [`DELETE /api/runs/${RUN_ID}`]: () => ({ run_id: RUN_ID, dry_run: true, deleted: false, files: [], recordings: { planned: 0, deleted: 0 }, projects: [] }) });
    renderWithProviders(<RunDeleteDialog runIds={[RUN_ID]} open onOpenChange={() => undefined} outputKind={outputKind} />);
    expect(await screen.findByRole("dialog")).toHaveAccessibleDescription(description);
  });
});
