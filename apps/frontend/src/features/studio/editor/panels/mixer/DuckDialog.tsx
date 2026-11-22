// Auto-duck dialog of a mixer channel strip: lowers this audio track wherever the chosen trigger track has clips, by
// writing volume keyframes onto this track's clips (editable afterwards; one undo step takes them back).
import { AudioWaveform } from "lucide-react";
import { useId, useState } from "react";
import type { TimelineTrack } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { t } from "@/i18n";
import { DUCK_AMOUNT_RANGE, DUCK_DEFAULTS, secondsToFrames } from "../../autoDuck";
import { useEditor } from "../../editorContext";
import { trackLabel } from "../../timelineGeometry";

export function DuckDialog({ track }: { track: TimelineTrack }) {
  const editor = useEditor();
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggers = editor.timeline.tracks.filter((candidate) => candidate.track_id !== track.track_id);
  const [triggerId, setTriggerId] = useState("");
  const [amount, setAmount] = useState<number>(DUCK_DEFAULTS.amountDb);
  const [attack, setAttack] = useState<number>(DUCK_DEFAULTS.attackSeconds);
  const [release, setRelease] = useState<number>(DUCK_DEFAULTS.releaseSeconds);
  const trigger = triggers.find((candidate) => candidate.track_id === triggerId) ?? triggers[0];

  const apply = () => {
    if (!trigger) return;
    const done = editor.command({
      type: "duck",
      trackId: track.track_id,
      triggerTrackId: trigger.track_id,
      amountDb: amount,
      attackFrames: secondsToFrames(attack, editor.fps),
      releaseFrames: secondsToFrames(release, editor.fps),
    });
    if (done) setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={t("自動壓低 {name}", { name: track.name })}
          title={t("自動壓低 {name}：在另一條軌有聲音的地方降低這條軌的音量", { name: track.name })}
          className="pressable grid h-6 w-6 place-items-center rounded-md text-fg-secondary hover:bg-raised hover:text-fg"
        >
          <AudioWaveform aria-hidden className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("自動壓低「{name}」", { name: track.name })}</DialogTitle>
          <DialogDescription>
            {t("在觸發軌有片段的地方，把這條軌的音量降低。結果會寫成這條軌上片段的音量關鍵影格，之後可以手動調整；原本的音量關鍵影格會被取代，可以用「復原」還原。")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          {triggers.length === 0 ? (
            <p className="text-body text-fg-secondary">{t("需要另一條軌當觸發軌")}</p>
          ) : (
            <>
              <Field id={`${id}-trigger`} label={t("觸發軌")}>
                {(describedBy) => (
                  <Select id={`${id}-trigger`} aria-describedby={describedBy} value={trigger?.track_id ?? ""} onChange={(event) => { setTriggerId(event.target.value); }}>
                  {triggers.map((candidate) => (
                    <option key={candidate.track_id} value={candidate.track_id}>
                      {`${trackLabel(candidate, editor.timeline.tracks)} ${candidate.name}`}
                    </option>
                  ))}
                  </Select>
                )}
              </Field>
              <Field id={`${id}-amount`} label={t("壓低量")} units="dB">
                {(describedBy) => <Input id={`${id}-amount`} aria-describedby={describedBy} type="number" min={DUCK_AMOUNT_RANGE.min} max={DUCK_AMOUNT_RANGE.max} step={1} value={amount} onChange={(event) => { setAmount(Number(event.target.value)); }} />}
              </Field>
              <Field id={`${id}-attack`} label={t("降低所需時間")} units={t("秒")}>
                {(describedBy) => <Input id={`${id}-attack`} aria-describedby={describedBy} type="number" min={0.05} max={5} step={0.05} value={attack} onChange={(event) => { setAttack(Number(event.target.value)); }} />}
              </Field>
              <Field id={`${id}-release`} label={t("恢復所需時間")} units={t("秒")}>
                {(describedBy) => <Input id={`${id}-release`} aria-describedby={describedBy} type="number" min={0.05} max={10} step={0.05} value={release} onChange={(event) => { setRelease(Number(event.target.value)); }} />}
              </Field>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button>{t("取消")}</Button>
          </DialogClose>
          <Button variant="primary" disabled={!trigger} onClick={apply}>
            {t("套用")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
