// The dialogue row of the Captions panel: 「從片段辨識台詞」 sends the selected clip (else the clips in the sequence
// In/Out, else the sequence) to transcription and applies the result as captions when it finishes; 「為字幕產生配音」
// voices chosen captions onto an empty audio track. 「從過去結果選」 re-applies an earlier transcription. A stopped
// speech component is not an error: it loads on first use, and the row says how long that takes.
import { AudioLines, History, ScanText } from "lucide-react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { indexCatalog, useStableCatalog, type ComponentEntry } from "@/api/catalog";
import { costProfilesQueryOptions } from "@/api/costProfiles";
import { qk } from "@/api/keys";
import { usePipelines } from "@/api/pipelines";
import { createRun } from "@/api/runs";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { useEditor } from "../editor/editorContext";
import { audibleSource } from "./clipLabel";
import { dialogueJobs, type TranscribeJob } from "./dialogueJobs";
import { readiness, readinessNote, speechRoute, transcribeRoute } from "./dialogueRoutes";
import { JobRows } from "./JobRows";
import { PastTranscripts } from "./PastTranscripts";
import { SpeechDialog } from "./SpeechDialog";
import { MAX_TRANSCRIBE_SOURCES, targetText, transcribeRequests, transcribeTarget } from "./transcribe";
import { useDialogueJobs } from "./useDialogueJobs";

/** The component's measured load time (median of its cost profiles' load_ms), null while it has none. */
function useMeasuredLoad(entry: ComponentEntry | undefined): number | null {
  const profiles = useQuery({
    ...costProfilesQueryOptions({ node_id: entry?.descriptor.node_id ?? "", component_id: entry?.descriptor.component_id ?? "" }),
    enabled: entry !== undefined,
  });
  const times = (profiles.data?.items ?? []).flatMap((item) => (item.load_ms !== null && item.load_ms > 0 ? [item.load_ms] : [])).sort((a, b) => a - b);
  return times.length === 0 ? null : (times[Math.floor(times.length / 2)] ?? null);
}

export function DialogueBar() {
  const editor = useEditor();
  const { project, timeline, fps } = editor;
  const client = useQueryClient();
  const pipelines = usePipelines();
  const catalog = useStableCatalog();
  const views = useDialogueJobs(editor);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [speechOpen, setSpeechOpen] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);

  const index = indexCatalog(catalog.data);
  const saved = pipelines.data?.items ?? [];
  const transcriber = catalog.data ? transcribeRoute(saved, index) : null;
  const voice = catalog.data ? speechRoute(saved, index) : null;
  const transcribeLoad = useMeasuredLoad(transcriber?.entry);
  const speechLoad = useMeasuredLoad(voice?.entry);
  const transcribeState = transcriber ? readiness(transcriber.entry, "transcribe", transcribeLoad) : null;
  const speechState = voice ? readiness(voice.entry, "speech", speechLoad) : null;
  const loading = catalog.isPending || pipelines.isPending;

  const target = transcribeTarget(timeline, editor.selectedClip);
  const transcribeBlocked =
    (loading ? t("正在讀取語音元件…") : null) ??
    (!transcriber ? t("沒有可用的語音辨識元件；請到「元件」安裝語音辨識") : null) ??
    (transcribeState?.kind === "blocked" ? transcribeState.reason : null) ??
    (target.clips.length === 0 ? targetText(project, timeline, target, fps) : null);
  const speechBlocked =
    (loading ? t("正在讀取語音元件…") : null) ??
    (!voice ? t("沒有可用的配音元件；請到「元件」安裝配音") : null) ??
    (speechState?.kind === "blocked" ? speechState.reason : null) ??
    (timeline.captions.length === 0 ? t("還沒有字幕可以配音") : null);
  const hint = (base: string, state: typeof transcribeState) => {
    const note = state ? readinessNote(state) : null;
    return note === null ? base : `${base}\n${note}`;
  };

  const transcribe = async () => {
    if (!transcriber || transcribeBlocked !== null || sending) return;
    setSending(true);
    setProblem(null);
    const requests = transcribeRequests(project, timeline, target, transcriber, fps);
    const started: TranscribeJob[] = [];
    try {
      if (requests.length === 0) throw new Error(t("這些片段的媒體格式無法辨識"));
      for (const request of requests) {
        const run = await createRun(request.body);
        started.push({ kind: "transcribe", runId: run.run_id, label: request.label, startedAt: Date.parse(run.created_at), clipIds: request.clipIds, outputKey: transcriber.outputKey });
      }
      if (new Set(target.clips.map((clip) => audibleSource(timeline, clip)?.file?.sha256)).size > MAX_TRANSCRIBE_SOURCES) {
        setProblem(t("一次最多辨識 {count} 段素材，其餘請再按一次", { count: MAX_TRANSCRIBE_SOURCES }));
      }
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      if (started.length > 0) dialogueJobs.add(project.project_id, started);
      void client.invalidateQueries({ queryKey: qk.runs() });
      setSending(false);
    }
  };

  return (
    <>
      <div data-keep-focus="" className="@container flex shrink-0 flex-wrap items-center gap-2 border-b border-line-subtle px-2 py-2">
        <ActionButton
          variant="primary"
          className="min-w-42 flex-1"
          icon={<ScanText aria-hidden />}
          pending={sending}
          disabledReason={transcribeBlocked}
          title={hint(targetText(project, timeline, target, fps), transcribeState)}
          onClick={() => { void transcribe(); }}
        >
          <span className="truncate">{t("從片段辨識台詞")}</span>
        </ActionButton>
        <ActionButton
          variant="secondary"
          className="min-w-42 flex-1"
          icon={<AudioLines aria-hidden />}
          disabledReason={speechBlocked}
          title={hint(t("為選取的字幕產生配音，放到空白音訊軌"), speechState)}
          onClick={() => { setSpeechOpen(true); }}
        >
          <span className="truncate">{t("為字幕產生配音")}</span>
        </ActionButton>
        <Button variant="quiet" icon={<History aria-hidden />} aria-label={t("從過去結果選")} title={t("從這個專案過去的辨識結果選一個套用")} onClick={() => { setPastOpen(true); }}>
          <span className="hidden @[30rem]:inline">{t("從過去結果選")}</span>
        </Button>
      </div>
      {problem !== null ? <p role="alert" className="shrink-0 border-b border-line-subtle px-3 py-1.5 text-data text-danger">{problem}</p> : null}
      <JobRows projectId={project.project_id} views={views} transcribeState={transcribeState} speechState={speechState} />
      {voice && speechState ? <SpeechDialog open={speechOpen} onOpenChange={setSpeechOpen} route={voice} state={speechState} /> : null}
      <PastTranscripts open={pastOpen} onOpenChange={setPastOpen} />
    </>
  );
}
