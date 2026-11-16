// Paste Attributes (Ctrl/⌘+Alt+V, or a clip's menu), as in Premiere: which attributes of the copied clip go onto the
// selected clips. Every attribute the copied clip and the selection both have is offered and checked; one that cannot
// be pasted stays in the list with its reason. Pasting is one step of the history; a clip that cannot take what was
// chosen refuses the paste, and the reason shows here, with the choices kept.
import { ClipboardPaste } from "lucide-react";
import { useId, useState } from "react";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { useEditor } from "./editorContext";
import { selectClips } from "./model";
import type { PasteAttribute } from "./pasteAttributes";

function AttributesForm({ onClose }: { onClose: () => void }) {
  const editor = useEditor();
  const id = useId();
  const choices = editor.pasteAttributeChoices();
  const [chosen, setChosen] = useState<ReadonlySet<PasteAttribute>>(() => new Set(choices.filter((choice) => choice.reason === null).map((choice) => choice.id)));
  const [error, setError] = useState<string | null>(null);
  const copied = [...(editor.clipboard?.clips ?? [])].sort((a, b) => a.start_frame - b.start_frame)[0];
  const count = selectClips(editor.timeline, editor.selected, editor.linked).length;
  const toggle = (attribute: PasteAttribute, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(attribute);
    else next.delete(attribute);
    setChosen(next);
    setError(null);
  };
  const paste = () => {
    const refused = editor.pasteAttributes(chosen);
    if (refused === null) onClose();
    else setError(refused);
  };
  return (
    <DialogContent onKeyDown={(event) => event.stopPropagation()}>
      <DialogHeader>
        <DialogTitle>{t("貼上屬性")}</DialogTitle>
        <DialogDescription>{t("把「{clip}」的屬性貼到選取的 {count} 個片段。", { clip: copied?.name ?? "", count })}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div role="group" aria-label={t("要貼上的屬性")} className="grid gap-x-6 sm:grid-cols-2">
          {choices.map((choice, index) => (
            <div key={choice.id} ref={reveal(index)}>
              <Checkbox
                id={`${id}-${choice.id}`}
                label={choice.label}
                description={choice.reason ?? choice.detail}
                checked={chosen.has(choice.id)}
                disabled={choice.reason !== null}
                onChange={(event) => toggle(choice.id, event.target.checked)}
              />
            </div>
          ))}
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-data text-danger [overflow-wrap:anywhere]">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button>{t("取消")}</Button>
        </DialogClose>
        <ActionButton variant="primary" icon={<ClipboardPaste aria-hidden />} disabledReason={chosen.size === 0 ? t("請至少選一項屬性") : null} onClick={paste}>
          {t("貼上")}
        </ActionButton>
      </DialogFooter>
    </DialogContent>
  );
}

export function PasteAttributesDialog() {
  const editor = useEditor();
  const open = editor.ui.pastingAttributes;
  const close = () => editor.ui.setPastingAttributes(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {open ? <AttributesForm onClose={close} /> : null}
    </Dialog>
  );
}
