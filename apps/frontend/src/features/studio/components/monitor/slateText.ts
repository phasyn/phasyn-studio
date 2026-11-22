// The description line of a monitor slate: the prompt's summary section when it has one, else the shot's note, else
// the prompt's first two lines (empty when there is no prompt). Pure.
import type { StudioShot } from "@/api/generated/contracts";
import { parsePrompt } from "../../prompt/blocks";

export function slateDescription(shot: Pick<StudioShot, "prompt" | "note">): string {
  const summary = parsePrompt(shot.prompt).blocks.find((block) => block.section === "summary")?.body.trim();
  if (summary != null && summary !== "") return summary;
  const note = shot.note.trim();
  if (note) return note;
  return shot.prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2)
    .join("\n");
}
