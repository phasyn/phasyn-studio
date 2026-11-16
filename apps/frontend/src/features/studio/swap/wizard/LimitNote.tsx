// The route DiT's swap limit note (shared by the characters and plan steps). While the DiT has no measured limits the
// note offers the trial: the user chooses to go past the conservative default (more characters, longer segments)
// knowing it is untested, and a finished trial is recorded as the DiT's limits from the swap panel.
import { MemoryStick } from "lucide-react";
import { useId } from "react";
import { Switch } from "@/components/ui/controls";
import { NoteList } from "../fields";
import { MAX_SWAP_CHARACTERS } from "../limitSpec";
import { limitNoteItems } from "../limits";
import type { SwapDraftApi } from "../useSwapDraft";
import type { WizardDerived } from "../wizardModel";
import { t } from "@/i18n";

/** The route DiT's swap limit: declared values with the deployment's note, or why the default (or a trial) applies. */
export function LimitNote({ derived, api }: { derived: WizardDerived; api: SwapDraftApi }) {
  const id = useId();
  const limit = derived.limit;
  const items = limitNoteItems(limit, { characters: derived.characters, frameLimit: derived.frameLimit, outputPixels: derived.outputPixels });
  // A trial needs a DiT to try on; measured limits replace it
  const canTry = limit.source !== "measured" && limit.ditId !== null;
  return (
    <div className="grid gap-1.5">
      <NoteList tone={limit.fallback ? "warning" : "info"} icon={<MemoryStick aria-hidden />} title={t("換角上限（依運算路由的 DiT）")} items={items} />
      {canTry ? (
        <Switch
          id={id}
          label={t("超過預設上限試跑")}
          description={t("還沒量測：可以加到 {max} 個角色、選更長的段落；顯存不夠的段落會失敗", { max: MAX_SWAP_CHARACTERS })}
          checked={api.draft.trial}
          onChange={(event) => api.update({ trial: event.target.checked })}
          className="justify-self-start"
        />
      ) : null}
    </div>
  );
}
