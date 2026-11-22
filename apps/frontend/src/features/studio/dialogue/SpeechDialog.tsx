// 「為字幕產生配音」: the captions to voice (the selected one, or all of them; Shift selects a range), the voice and
// language, and the audio track the lines land on. Only a track that is empty under every chosen caption can take them;
// each line becomes one speech run, and when it finishes it is placed at its caption's start (useDialogueJobs).
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TimelineCaption } from "@/api/generated/contracts";
import { qk } from "@/api/keys";
import { createRun } from "@/api/runs";
import type { RunRequestBody } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { formatTimecode } from "../model/frames";
import { useEditor } from "../editor/editorContext";
import { clipEnd } from "../editor/model";
import { trackLabel } from "../editor/timelineGeometry";
import { captionLine, sortedCaptions } from "../editor/panels/captions/captionEdits";
import { dialogueJobs, type SpeechJob } from "./dialogueJobs";
import { readinessNote, type Readiness, type SpeechRoute } from "./dialogueRoutes";

/** Lines per request: each is one speech run. */
export const MAX_SPEECH_LINES = 24;

/** Friendlier names for the language values the speech component takes. */
const LANGUAGE_NAMES: Record<string, string> = {
  Auto: t("自動判斷"), Chinese: t("中文"), English: t("英文"), Japanese: t("日文"), Korean: t("韓文"), German: t("德文"),
  French: t("法文"), Russian: t("俄文"), Portuguese: t("葡萄牙文"), Spanish: t("西班牙文"), Italian: t("義大利文"),
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  route: SpeechRoute;
  state: Readiness;
}

function Lines({ captions, chosen, setChosen, fps }: { captions: readonly TimelineCaption[]; chosen: ReadonlySet<string>; setChosen: (next: Set<string>) => void; fps: number }) {
  const [anchor, setAnchor] = useState<number | null>(null);
  const id = useId();
  const toggle = (index: number, range: boolean) => {
    const caption = captions[index];
    if (!caption) return;
    const next = new Set(chosen);
    const on = !chosen.has(caption.caption_id);
    const [from, to] = range && anchor !== null ? [Math.min(anchor, index), Math.max(anchor, index)] : [index, index];
    for (const item of captions.slice(from, to + 1)) {
      if (on) next.add(item.caption_id);
      else next.delete(item.caption_id);
    }
    setAnchor(index);
    setChosen(next);
  };
  return (
    <fieldset className="grid min-h-0 gap-1">
      <legend className="sr-only">{t("要配音的字幕")}</legend>
      <div className="flex items-center gap-2 text-data">
        <span className="text-fg">{t("要配音的字幕")}</span>
        <span className="text-fg-secondary">{t("已選 {count} / {total} 句", { count: chosen.size, total: captions.length })}</span>
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="quiet" onClick={() => { setChosen(new Set(captions.map((caption) => caption.caption_id))); }}>{t("全選")}</Button>
          <Button size="sm" variant="quiet" disabled={chosen.size === 0} onClick={() => { setChosen(new Set()); }}>{t("清除")}</Button>
        </span>
      </div>
      <ul className="max-h-64 min-h-0 overflow-y-auto rounded-md border border-line-subtle py-1">
        {captions.map((caption, index) => {
          const box = `${id}-${String(index)}`;
          return (
            <li key={caption.caption_id}>
              <label htmlFor={box} className="flex min-h-9 cursor-pointer items-center gap-3 px-3 text-data hover:bg-raised">
                <input id={box} type="checkbox" className="size-4 shrink-0 cursor-pointer accent-action" checked={chosen.has(caption.caption_id)}
                  onChange={() => undefined}
                  onClick={(event) => { toggle(index, event.shiftKey); }} />
                <span className="machine w-24 shrink-0 text-caption text-fg-tertiary">{formatTimecode(caption.start_frame, fps)}</span>
                <span className="min-w-0 flex-1 truncate text-fg" title={caption.text}>{captionLine(caption.text)}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

function Form({ route, state, onDone }: { route: SpeechRoute; state: Readiness; onDone: () => void }) {
  const editor = useEditor();
  const client = useQueryClient();
  const { timeline, fps, project } = editor;
  const id = useId();
  const captions = sortedCaptions(timeline.captions);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(editor.selectedCaption !== null && captions.some((caption) => caption.caption_id === editor.selectedCaption) ? [editor.selectedCaption] : captions.map((caption) => caption.caption_id)));
  const [voice, setVoice] = useState(route.voice?.fallback ?? "");
  const [language, setLanguage] = useState(route.language?.fallback ?? "");
  const [trackId, setTrackId] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const lines = captions.filter((caption) => chosen.has(caption.caption_id));
  const audioTracks = timeline.tracks.filter((track) => track.kind === "audio");
  const occupied = (trackIdToCheck: string) => timeline.clips.some((clip) => clip.track_id === trackIdToCheck &&
    lines.some((line) => clip.start_frame < line.end_frame && clipEnd(clip) > line.start_frame));
  const usable = audioTracks.filter((track) => !track.locked && !occupied(track.track_id));
  const track = usable.find((item) => item.track_id === trackId) ?? usable[0];
  const note = readinessNote(state);
  const blocked =
    (lines.length === 0 ? t("請至少選一句字幕") : null) ??
    (lines.length > MAX_SPEECH_LINES ? t("一次最多 {count} 句，請分批產生", { count: MAX_SPEECH_LINES }) : null) ??
    (!track ? t("沒有在這些字幕位置都空白的音訊軌；請新增一條音訊軌") : null) ??
    (state.kind === "blocked" ? state.reason : null);

  const submit = async () => {
    if (blocked !== null || sending || !track) return;
    setSending(true);
    setProblem(null);
    const step = route.pipeline.steps.find((item) => item.step_id === route.stepId);
    const parameters = {
      ...step?.parameters,
      ...(route.voice && voice !== "" ? { [route.voice.parameter]: voice } : {}),
      ...(route.language && language !== "" ? { [route.language.parameter]: language } : {}),
    };
    const pipeline = { ...route.pipeline, steps: route.pipeline.steps.map((item) => (item.step_id === route.stepId ? { ...item, parameters } : item)) };
    const started: SpeechJob[] = [];
    try {
      for (const line of lines) {
        const body: RunRequestBody = {
          pipeline,
          inputs: { [route.textInput]: { type_id: "text.prompt.v1", value: line.text } },
          label: t("{project}・台詞配音・{line}", { project: project.title, line: captionLine(line.text) }),
          origin: { note: JSON.stringify({ type: "studio.dialogue.v1", project_id: project.project_id, kind: "speech", caption_id: line.caption_id, start_frame: line.start_frame }) },
        };
        const run = await createRun(body);
        started.push({ kind: "speech", runId: run.run_id, label: captionLine(line.text), startedAt: Date.parse(run.created_at), captionId: line.caption_id, trackId: track.track_id, at: line.start_frame, outputKey: route.audioKey });
      }
    } catch (cause) {
      setProblem(started.length > 0 ? t("已送出 {count} 句，其餘失敗：{error}", { count: started.length, error: errorText(cause) }) : errorText(cause));
    } finally {
      if (started.length > 0) dialogueJobs.add(project.project_id, started);
      void client.invalidateQueries({ queryKey: qk.runs() });
      setSending(false);
    }
    if (started.length === lines.length) onDone();
  };

  return (
    <>
      <DialogBody className="grid min-h-0 gap-4">
        {captions.length === 0 ? <p className="text-data text-fg-secondary">{t("還沒有字幕。先新增字幕或從片段辨識台詞。")}</p> : <Lines captions={captions} chosen={chosen} setChosen={setChosen} fps={fps} />}
        <div className="grid gap-3 sm:grid-cols-2">
          {route.voice ? (
            <label className="grid gap-1 text-data text-fg-secondary">
              {t("聲音")}
              <Select value={voice} onChange={(event) => { setVoice(event.target.value); }}>
                {route.voice.options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
              </Select>
            </label>
          ) : null}
          {route.language ? (
            <label className="grid gap-1 text-data text-fg-secondary">
              {t("語言")}
              <Select value={language} onChange={(event) => { setLanguage(event.target.value); }}>
                {route.language.options.map((option) => <option key={option} value={option}>{LANGUAGE_NAMES[option] ?? option}</option>)}
              </Select>
            </label>
          ) : null}
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${id}-track`} className="text-data text-fg-secondary">{t("放到音訊軌")}</label>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select id={`${id}-track`} value={track?.track_id ?? ""} disabled={usable.length === 0} onChange={(event) => { setTrackId(event.target.value); }}>
                {usable.length === 0 ? <option value="">{t("沒有空白的音訊軌")}</option> : null}
                {audioTracks.map((item) => {
                  const taken = occupied(item.track_id);
                  const why = item.locked ? t("（已鎖定）") : taken ? t("（這些字幕位置已有聲音）") : "";
                  const short = trackLabel(item, timeline.tracks);
                  const name = item.name === short ? short : t("{short}・{name}", { short, name: item.name });
                  return <option key={item.track_id} value={item.track_id} disabled={item.locked || taken}>{name}{why}</option>;
                })}
              </Select>
            </div>
            <ActionButton size="md" variant="secondary" icon={<Plus aria-hidden />} disabledReason={editor.canAddTrack ? null : t("軌道數已達上限")} onClick={() => { void editor.addTrack("audio"); }}>
              {t("新增音訊軌")}
            </ActionButton>
          </div>
        </div>
        {note !== null ? <p role="status" className="rounded-md border border-info/30 bg-info/10 px-3 py-2 text-data text-info">{note}</p> : null}
        {problem !== null ? <p role="alert" className="text-data text-danger">{problem}</p> : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild><Button variant="quiet">{t("取消")}</Button></DialogClose>
        <ActionButton variant="primary" pending={sending} disabledReason={blocked} onClick={() => { void submit(); }}>
          {lines.length > 0 ? t("產生 {count} 句配音", { count: lines.length }) : t("產生配音")}
        </ActionButton>
      </DialogFooter>
    </>
  );
}

export function SpeechDialog({ open, onOpenChange, route, state }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("為字幕產生配音")}</DialogTitle>
          <DialogDescription>{t("每句字幕產生一段配音，完成後自動放到所選音訊軌、對齊字幕的開始位置。")}</DialogDescription>
        </DialogHeader>
        {open ? <Form route={route} state={state} onDone={() => { onOpenChange(false); }} /> : null}
      </DialogContent>
    </Dialog>
  );
}
