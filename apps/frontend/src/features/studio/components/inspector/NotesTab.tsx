// The shot's notes in a tab of their own, so the Prompt tab has no second field competing for its height: one field as
// tall as the tab (its only scroll area). Notes stay with the project and never reach the model.
import type { StudioShot } from "@/api/generated/contracts";
import { Textarea } from "@/components/ui/controls";
import { t } from "@/i18n";
import { PROMPT_MAX_LENGTH } from "../../prompt";
import { PrevisDialog } from "../../previs/PrevisDialog";
import { useStudio } from "../../studioContext";

/** The contract's limit of StudioShot.note is the prompt's (16,384 characters). */
const NOTE_MAX_LENGTH = PROMPT_MAX_LENGTH;

export function NotesTab({ shot }: { shot: StudioShot }) {
  const { dispatch } = useStudio();
  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div className="mb-2"><PrevisDialog key={shot.shot_id} shot={shot} /></div>
      <Textarea
        compact
        value={shot.note}
        maxLength={NOTE_MAX_LENGTH}
        aria-label={t("備註")}
        placeholder={t("這個鏡頭的筆記：分鏡想法、待辦、素材出處（不會送進 prompt）")}
        onChange={(event) => { dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { note: event.target.value } }); }}
        className="min-h-32 flex-1 resize-none leading-6"
      />
    </div>
  );
}
