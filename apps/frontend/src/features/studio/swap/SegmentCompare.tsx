// One segment's check against the original, opened under its row in the swap panel: the verdict in plain words with
// what to try, the three numbers, the layout of every second and a filmstrip (original above, take below, every half
// second) — or where the check stands (waiting, reading frames, why it could not run). Its 「速度感…」 opens the
// speed-feel tool for the segment's clip in 「編輯」.
// Look (Phasyn): a sunken card; the result fades in, its columns enter one after another (Motion), the reading progress
// is the brand gradient (transform only).
import { CircleAlert, CircleCheck, CircleX, ImageOff, LoaderCircle, Play, RotateCcw, Scissors, TriangleAlert, Zap } from "lucide-react";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { reveal, useChangeFade } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import type { CompareStatus, ComparisonResult, StripFrame } from "./compareQueue";
import type { CompareTarget } from "./compareTarget";
import { cutsNote, cutsText, layoutReading, layoutText, motionText, ratioText, verdictView, type CheckTone } from "./compareView";
import { Fact, Facts, NoteList } from "./fields";
import { formatCueTime } from "./prompt";
import { t } from "@/i18n";

const TONE_TEXT: Record<CheckTone, string> = { success: "text-success", warning: "text-warning", danger: "text-danger" };
const TONE_BAR: Record<CheckTone, string> = { success: "bg-success/70", warning: "bg-warning/70", danger: "bg-danger/70" };
const TONE_ICON = { success: CircleCheck, warning: TriangleAlert, danger: CircleX } as const;

/** A moment of the original (seconds) as mm:ss.mmm. */
const cue = (seconds: number) => formatCueTime(Math.round(seconds * 1000), 1000);

/** The way to the speed-feel tool for this segment: why it cannot open (the segment is several clips), or how it opens. */
interface SpeedFeelEntry {
  blocked: string | null;
  onOpen: () => void;
}

export function SegmentCompare({ id, target, check, onRun, speedFeel = null }: { id: string; target: CompareTarget; check: CompareStatus | null; onRun: () => void; speedFeel?: SpeedFeelEntry | null }) {
  const fade = useChangeFade<HTMLDivElement>(check?.status ?? "none");
  const idle = check === null || check.status === "done" || check.status === "failed";
  return (
    <div id={id} ref={reveal(0)} role="region" aria-label={t("和原片比對")} className="grid min-w-0 gap-3 rounded-lg border border-line-subtle bg-sunken/60 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className="text-caption font-semibold text-fg-secondary">{t("和原片比對")}</h4>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {target.ok && speedFeel ? (
            <ActionButton
              size="sm"
              variant="quiet"
              icon={<Zap aria-hidden />}
              disabledReason={speedFeel.blocked}
              title={t("到「編輯」分析這段的速度感：在生成沒打到原片重音的地方加上震動與負片衝擊格")}
              onClick={speedFeel.onOpen}
            >
              {t("速度感…")}
            </ActionButton>
          ) : null}
          {target.ok && idle ? (
            <Button size="sm" variant="quiet" icon={check === null ? <Play aria-hidden /> : <RotateCcw aria-hidden />} onClick={onRun}>
              {check === null ? t("開始比對") : t("重新比對")}
            </Button>
          ) : null}
        </span>
      </div>
      <div ref={fade} className="grid min-w-0 gap-3">
        <Body target={target} check={check} />
      </div>
    </div>
  );
}

function Body({ target, check }: { target: CompareTarget; check: CompareStatus | null }) {
  if (!target.ok) return <NoteList tone="info" icon={<CircleAlert aria-hidden />} title={t("沒有辦法和原片比對")} items={[target.reason]} />;
  if (check === null) return <p className="text-caption text-fg-tertiary">{t("在這個瀏覽器讀取 take 與原片同一時間的影格（一次讀一支影片），算出構圖相符度、動作速度與切鏡。")}</p>;
  if (check.status === "queued") {
    return (
      <p role="status" className="flex items-center gap-1.5 text-caption text-info">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
        {t("等待中：一次只比對一段，前一段比完就開始。")}
      </p>
    );
  }
  if (check.status === "running") return <Reading check={check} />;
  if (check.status === "failed") return <NoteList tone="warning" icon={<CircleX aria-hidden />} title={t("比對沒有完成")} items={[check.reason]} />;
  return <Result result={check.result} />;
}

function Reading({ check }: { check: Extract<CompareStatus, { status: "running" }> }) {
  // The take is read first, then the original: each is half of the way
  const share = check.total > 0 ? ((check.clip === "take" ? 0 : check.total) + check.done) / (2 * check.total) : 0;
  return (
    <div role="status" className="grid gap-1.5">
      <p className="flex items-center gap-1.5 text-caption text-info">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
        {check.clip === "take" ? t("讀取生成影片的影格 {done}／{total}…", { done: check.done, total: check.total }) : t("讀取原片的影格 {done}／{total}…", { done: check.done, total: check.total })}
      </p>
      <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-raised">
        <span className="block h-full origin-left rounded-full bg-brand-gradient transition-transform duration-(--duration-base) ease-standard" style={{ transform: `scaleX(${share})` }} />
      </span>
    </div>
  );
}

function Result({ result }: { result: ComparisonResult }) {
  const { metrics, fps } = result;
  const view = verdictView(metrics);
  const Icon = TONE_ICON[view.tone];
  const note = cutsNote(metrics, fps);
  const from = result.refStart + result.first / fps;
  const to = result.refStart + result.end / fps;
  return (
    <>
      <p role="status" className={cn("flex items-start gap-1.5 text-data [overflow-wrap:anywhere]", TONE_TEXT[view.tone])}>
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{view.line}</span>
      </p>
      {note ? <NoteList tone="warning" icon={<Scissors aria-hidden />} items={[note]} /> : null}
      <Facts className="text-caption">
        <Fact label={t("構圖相符度")}>{layoutText(metrics.layout)}</Fact>
        <Fact label={t("動作速度（生成÷原版）")}>{motionText(metrics.motionRatio)}</Fact>
        <Fact label={t("切鏡（原版／生成）")}>{cutsText(metrics, fps)}</Fact>
        <Fact label={t("比對範圍")}>
          {t("生成第 {first}–{last} 影格，對照原片 {from}–{to}；每 {step} 影格量一次，共 {samples} 格。", { first: result.first, last: result.end - 1, from: cue(from), to: cue(to), step: result.step, samples: result.samples })}
          {result.clips > 1 ? t("這段在時間軸上有 {clips} 個片段：從第一個的入點比到最後一個的出點。", { clips: result.clips }) : null}
        </Fact>
      </Facts>
      <PerSecond values={metrics.layoutPerSecond} />
      <Filmstrip strip={result.strip} every={result.stripEvery} start={from} />
    </>
  );
}

function PerSecond({ values }: { values: readonly number[] }) {
  if (values.length === 0) return null;
  const title = t("每一秒的構圖相符度（從保留範圍的第 1 秒起）");
  return (
    <div className="grid gap-1">
      <span aria-hidden className="text-caption text-fg-tertiary">
        {title}
      </span>
      <ol className="flex flex-wrap items-end gap-1.5" aria-label={title}>
        {values.map((value, second) => {
          const reading = layoutReading(value);
          const height = Number.isFinite(value) ? Math.min(1, Math.max(0.04, value)) : 0;
          return (
            <li key={second} ref={reveal(second)} className="grid w-10 justify-items-center gap-0.5" title={t("第 {second} 秒：{value}（{reading}）", { second: second + 1, value: ratioText(value), reading: reading.text })}>
              <span aria-hidden className="flex h-10 w-3 items-end overflow-hidden rounded-sm bg-raised">
                <span className={cn("block w-full rounded-sm", TONE_BAR[reading.tone])} style={{ height: `${Math.round(height * 100)}%` }} />
              </span>
              <span className={cn("machine text-caption", TONE_TEXT[reading.tone])}>
                <span className="sr-only">{t("第 {second} 秒", { second: second + 1 })}</span>
                {Number.isFinite(value) ? ratioText(value) : "—"}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Picture({ src, alt }: { src: string | null; alt: string }) {
  if (src) return <img src={src} alt={alt} className="h-18 w-32 rounded-sm border border-line-subtle bg-stage object-contain" />;
  return (
    <span className="grid h-18 w-32 place-items-center rounded-sm border border-line-subtle bg-stage text-fg-tertiary">
      <ImageOff aria-hidden className="size-4" />
      <span className="sr-only">{t("沒有畫面")}</span>
    </span>
  );
}

const STRIP_ROWS = "grid-rows-[1.125rem_4.5rem_4.5rem_1.125rem]";

function Filmstrip({ strip, every, start }: { strip: readonly StripFrame[]; every: number; start: number }) {
  if (strip.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-caption text-fg-tertiary">{t("逐格對照（每 {seconds} 秒；上：原片，下：生成；數字是那一格的構圖相符度）", { seconds: Number(every.toFixed(2)) })}</span>
      <div className="flex min-w-0 gap-2">
        <div aria-hidden className={cn("grid shrink-0 items-center gap-1 text-caption text-fg-tertiary", STRIP_ROWS)}>
          <span />
          <span>{t("原片")}</span>
          <span>{t("生成")}</span>
          <span />
        </div>
        <ol className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-1" aria-label={t("原片與生成的對照影格")}>
          {strip.map((frame, index) => {
            const reading = frame.layout === null ? null : layoutReading(frame.layout);
            const original = cue(start + frame.offset);
            const at = t("{seconds} 秒", { seconds: frame.offset.toFixed(1) });
            return (
              <li key={frame.offset} ref={reveal(index)} className={cn("grid w-32 shrink-0 gap-1", STRIP_ROWS)} title={t("原片 {time}", { time: original })}>
                <span className="machine text-caption text-fg-tertiary">{at}</span>
                <Picture src={frame.original} alt={t("原片 {time}", { time: original })} />
                <Picture src={frame.take} alt={t("生成，保留範圍的第 {at}", { at })} />
                <span className={cn("machine text-caption", reading ? TONE_TEXT[reading.tone] : "text-fg-tertiary")}>{frame.layout === null ? "—" : ratioText(frame.layout)}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
