// Removing a reference the prompt still uses asks first, and the question leaves with its buttons: Cancel puts focus
// back on the row's 「…」 button (where the removal was chosen) instead of dropping it on the page, and nothing is removed.
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StudioReference } from "@/api/generated/contracts";
import { renderWithProviders } from "@/test/render";
import { ReferenceRow } from "./ReferenceRow";

const reference: StudioReference = { ref_id: "r-1", kind: "image", alias: "Image1", item_id: "i-1", start_seconds: null, end_seconds: null };

describe("ReferenceRow", () => {
  it("returns focus to the row's menu button after Cancel", async () => {
    const onRemove = vi.fn<() => void>();
    const { user } = renderWithProviders(
      <ul>
        <ReferenceRow reference={reference} item={undefined} label={undefined} mentions={1} disabled={false} onChange={() => undefined} onRemove={onRemove} />
      </ul>,
    );
    const menu = screen.getByRole("button", { name: "@Image1 的動作" });
    await user.click(menu);
    await user.click(screen.getByRole("menuitem", { name: "從這個鏡頭移除…" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(menu).toHaveFocus();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
