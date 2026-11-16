// Asked before a shot's shorter new take is applied to the timeline (from the Project panel or a clip's menu). The
// Controller trims the clips that reach beyond the new media, closes the gaps and binds the source to the take; the
// edit history starts over, so this is the one edit that cannot be undone and it is never done on a single click.
import { Scissors } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { formatTimecode } from "../model/frames";
import { useEditor } from "./editorContext";

export function ShorterTakeDialog() {
  const editor = useEditor();
  const asked = editor.shorterAsked;
  const [pending, setPending] = useState(false);
  const source = asked ? editor.sources.find((item) => item.source_id === asked.sourceId) : undefined;
  const name = source?.name ?? asked?.shotId ?? "";
  const clips = asked ? editor.timeline.clips.filter((clip) => clip.source_id === asked.sourceId).length : 0;

  const confirm = () => {
    if (!asked || pending) return;
    setPending(true);
    void editor.applyShorter(asked).then((applied) => {
      setPending(false);
      if (!applied) return;
      editor.notify({ tone: "success", title: t("已改用「{name}」較短的新 take", { name }) });
      editor.requestShorter(null);
    });
  };

  return (
    <Dialog
      open={asked !== null}
      onOpenChange={(open) => {
        // The request cannot be taken back once it is sent: the dialog stays until it has an answer
        if (!open && !pending) editor.requestShorter(null);
      }}
    >
      {asked ? (
        <DialogContent onKeyDown={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t("改用「{name}」較短的新 take？", { name })}</DialogTitle>
            <DialogDescription>
              {t("新 take 長 {duration}。時間軸上用到這個素材的 {count} 個片段，超出新素材的部分會裁短，後面的片段往前接上。這個動作不能復原，剪輯的復原歷程會清空。", {
                duration: formatTimecode(asked.durationFrames, editor.fps),
                count: clips,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={pending}>{t("取消")}</Button>
            </DialogClose>
            <Button variant="danger-confirm" icon={<Scissors aria-hidden />} pending={pending} onClick={confirm}>
              {t("套用並裁短")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
