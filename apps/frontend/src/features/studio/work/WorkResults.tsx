// What a finished job produced, in the work detail's 概覽: a transcription's lines (how many, the first few, and the way
// to the captions they became) and a video check's findings (the same report as the take's 「檢查影片」, with the shot it
// checked). Read only: nothing here starts or changes a run.
import { Captions, Clapperboard } from "lucide-react";
import { Link } from "react-router";
import { useFileJson } from "@/api/files";
import { asTypedValue, type WireRun } from "@/api/types";
import { CARD } from "@/components/ui/look";
import { buttonVariants } from "@/components/ui/variants";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { TakeSignalResults } from "../components/monitor/TakeSignalResults";
import { TRANSCRIPT_TYPE } from "../dialogue/dialogueRoutes";
import { useStudio } from "../studioContext";
import { projectHref } from "../workspaces";
import { lineTime, transcriptLines } from "./transcript";
import { noteOf } from "./workItems";

/** How many lines show before 「…」: enough to recognize the take, short enough for the card. */
const PREVIEW_LINES = 3;

function TranscriptResult({ run }: { run: WireRun }) {
  const { project } = useStudio();
  const output = Object.values(run.outputs).map(asTypedValue).find((value) => value?.type_id === TRANSCRIPT_TYPE);
  const file = output && "file" in output ? output.file : null;
  const document = useFileJson(file);
  const lines = transcriptLines(document.data);
  const captionsHref = `${projectHref("edit", project.project_id)}&layout=captions`;
  return (
    <section aria-label={t("辨識結果")} className={cn(CARD, "grid gap-2 px-4 py-3")}>
      <h3 className="text-body font-semibold text-fg">{t("辨識結果")}</h3>
      {file === null ? <p className="text-data text-fg-secondary">{t("這次辨識沒有留下台詞檔。")}</p> : null}
      {file !== null && document.isPending ? <p role="status" className="text-data text-fg-tertiary">{t("正在讀取台詞…")}</p> : null}
      {file !== null && (document.isError || (document.isSuccess && lines === null)) ? <p role="alert" className="text-data text-warning">{t("讀不到這次辨識的台詞檔。")}</p> : null}
      {lines !== null && lines.length === 0 ? <p className="text-data text-fg-secondary">{t("這段聲音裡沒有辨識到台詞。")}</p> : null}
      {lines !== null && lines.length > 0 ? (
        <>
          <p className="text-data text-fg-secondary">{t("辨識到 {count} 段台詞", { count: lines.length })}</p>
          <ol className="grid gap-1">
            {lines.slice(0, PREVIEW_LINES).map((line, index) => (
              <li key={`${String(line.startMs)}-${String(index)}`} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2 text-data">
                <span className="machine text-fg-tertiary">{lineTime(line.startMs)}</span>
                <span className="truncate text-fg" title={line.text}>{line.text}</span>
              </li>
            ))}
          </ol>
          {lines.length > PREVIEW_LINES ? <p className="text-caption text-fg-tertiary">{t("還有 {count} 段", { count: lines.length - PREVIEW_LINES })}</p> : null}
        </>
      ) : null}
      <Link to={captionsHref} className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "justify-self-start no-underline")}>
        <Captions aria-hidden />
        {t("到「字幕」查看")}
      </Link>
    </section>
  );
}

function CheckResult({ run }: { run: WireRun }) {
  const { project } = useStudio();
  const note = noteOf(run);
  const shot = project.shots.find((item) => item.shot_id === note["shot_id"]);
  const take = shot?.takes.find((item) => item.take_id === note["take_id"]);
  const source = take?.asset?.file;
  return (
    <section aria-label={t("檢查結果")} className={cn(CARD, "grid gap-3 px-4 py-3")}>
      <h3 className="text-body font-semibold text-fg">{t("檢查結果")}</h3>
      {run.state === "succeeded" && source ? <TakeSignalResults run={run} source={source} /> : null}
      {!source ? <p className="text-data text-fg-secondary">{t("檢查的 take 已不在這個專案裡。")}</p> : null}
      {shot ? (
        <Link
          to={`${projectHref("generate", project.project_id)}&shot=${encodeURIComponent(shot.shot_id)}`}
          className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "justify-self-start no-underline")}
        >
          <Clapperboard aria-hidden />
          {t("開啟「{shot}」", { shot: shot.title })}
        </Link>
      ) : null}
    </section>
  );
}

/** The result section of a finished transcription or video check; nothing for other jobs. */
export function WorkResult({ kind, run }: { kind: string; run: WireRun }) {
  if (run.state !== "succeeded" && kind !== "check") return null;
  if (kind === "transcribe") return <TranscriptResult run={run} />;
  if (kind === "check" && run.state !== "running") return <CheckResult run={run} />;
  return null;
}
