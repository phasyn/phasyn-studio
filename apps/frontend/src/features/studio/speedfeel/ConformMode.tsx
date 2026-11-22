// The cut conform of the speed-feel dialog (對齊原片切點): it reads the clip's take and its original frame by frame
// (with progress and a cancel), finds the cuts of both and pairs them, shows every pair with its offset, how each part
// between two cuts would be retimed and the on-time count before and after, and applies the edit as one named history
// step that one undo takes back. Next to it the motion edits (choice.ts): 依動作同步 (retime.ts) and, as its fallback,
// 整段平移 (sync.ts); the recommended edit is chosen until another is, and only one is ever applied. Opening the tool
// reads the clip once; closing it (or the dialog) stops a read.
// Look (Phasyn): as the effects tool — states fade into each other (useChangeFade, animate-reveal), table rows enter
// one after another (Motion), the on-time bars grow by transform; the tables stay crisp.
import { AudioWaveform, CircleCheck, Magnet, MoveHorizontal, TriangleAlert, type LucideIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { useEditor } from "../editor/editorContext";
import { formatTimecode } from "../model/frames";
import { Fact, Facts } from "../swap/fields";
import { chosenMethod, conformOptions, readyMethods, type ConformMethod, type ConformOptions } from "./choice";
import { planConform, type ConformPlan, type ConformPlanResult } from "./conform";
import { MethodChoice, MotionNote } from "./ConformChoice";
import { cancelConform, startConform, useConformResults } from "./conformReader";
import { conformLabel, conformVerdict, pairRows, recommendationVerdict, retimeLabel, shiftLabel, signedFrames, spanChanges, spanText, type ConformTone, type PairTone } from "./conformView";
import { ON_TIME_FRAMES, type ConformAnalysis, type CutTiming } from "./cuts";
import { ToolBody, ToolFooter, Verdict, type ToolProps } from "./DialogParts";
import { speedFeelTarget, type SpeedFeelTarget } from "./target";
import { clipTitle, cueTime } from "./view";

const TONE_ICON: Record<ConformTone, LucideIcon> = { info: Magnet, success: CircleCheck, warning: TriangleAlert };
const PAIR_TEXT: Record<PairTone, string> = { kept: "text-brand-cyan", skipped: "text-fg-tertiary", warning: "text-warning" };
const METHOD_ICON: Record<ConformMethod, LucideIcon> = { cut: Magnet, retime: AudioWaveform, shift: MoveHorizontal };

export function ConformMode({ clipId, applied, onApplied, onClose }: ToolProps) {
  const editor = useEditor();
  const { project, timeline } = editor;
  const results = useConformResults();
  const target = useMemo(() => speedFeelTarget(project, timeline, clipId), [project, timeline, clipId]);
  const clip = timeline.clips.find((item) => item.clip_id === clipId) ?? null;
  const status = target.ok ? (results.get(target.key) ?? null) : null;
  const done = status?.status === "done" ? status : null;
  const analysis = done?.analysis ?? null;
  const plan = useMemo(() => (analysis && applied === null ? planConform({ timeline, clipId, analysis }) : null), [analysis, applied, timeline, clipId]);
  const options = useMemo(
    () => (done && applied === null ? conformOptions({ timeline, clipId, analysis: done.analysis, sync: done.sync, cut: plan }) : null),
    [done, applied, timeline, clipId, plan],
  );
  const [choice, setChoice] = useState<ConformMethod | null>(null);
  const selected = options ? chosenMethod(options, choice) : null;

  // Opening the tool (or a clip that changed since) reads the clip once
  const begin = useEffectEvent(() => {
    if (target.ok && applied === null && status?.status !== "done" && status?.status !== "failed") startConform(target);
  });
  const key = target.ok ? target.key : null;
  useEffect(() => {
    begin();
  }, [key]);
  // Leaving the tool or closing the dialog stops a read (finished results stay)
  useEffect(() => cancelConform, []);

  const apply = () => {
    if (!clip) return;
    const title = clipTitle(project, timeline, clip);
    const edit =
      selected === "retime" && (options?.retime?.ok === true)
        ? { timeline: options.retime.plan.timeline, label: retimeLabel(title) }
        : selected === "shift" && (options?.shift?.ok === true)
          ? { timeline: options.shift.plan.timeline, label: shiftLabel(title, options.shift.plan.lag) }
          : selected === "cut" && (plan?.ok === true)
            ? { timeline: plan.plan.timeline, label: conformLabel(title, plan.plan.anchors.length) }
            : null;
    if (edit && editor.commit(edit.timeline, edit.label)) onApplied(edit.label);
  };
  const shotId = timeline.sources.find((source) => source.source_id === clip?.source_id)?.shot_id ?? null;
  const generateHref = (shotId != null && shotId !== "") ? `/studio/generate?project=${encodeURIComponent(project.project_id)}&shot=${encodeURIComponent(shotId)}` : null;
  // The edits that can be made; without one, the cut plan's refusal keeps the button (and its reason) as before
  const ready = options ? readyMethods(options) : [];
  const offered = ready.length > 0 || (plan !== null && !plan.ok && !plan.settled);
  const blocked = selected !== null ? null : ready.length > 0 ? t("先選一種做法") : plan && !plan.ok ? plan.reason : null;
  const ApplyIcon = METHOD_ICON[selected ?? "cut"];

  return (
    <>
      <ToolBody
        applied={applied}
        target={target}
        status={status}
        intro={t("在這個瀏覽器逐格讀取這個片段的 take 和原片（一次讀一支影片），找出兩邊的切點並配對，再算出怎麼讓生成的切點落在原片的切點上。片段越長，讀取越久；可以隨時取消。")}
      >
        {target.ok && clip && analysis ? <Result analysis={analysis} target={target} clip={clip} plan={plan} options={options} selected={selected} onSelect={setChoice} generateHref={generateHref} onLeave={onClose} /> : null}
      </ToolBody>
      <ToolFooter applied={applied} onUndone={() => { onApplied(null); }} reading={target.ok ? { status: status?.status ?? null, start: () => { startConform(target); }, cancel: cancelConform } : null}>
        {applied === null && offered ? (
          <ActionButton variant="primary" icon={<ApplyIcon aria-hidden />} disabledReason={blocked} onClick={apply}>
            {t("套用")}
          </ActionButton>
        ) : null}
      </ToolFooter>
    </>
  );
}

interface ResultProps {
  analysis: ConformAnalysis;
  target: SpeedFeelTarget;
  clip: TimelineClip;
  plan: ConformPlanResult | null;
  options: ConformOptions | null;
  selected: ConformMethod | null;
  onSelect: (method: ConformMethod) => void;
  generateHref: string | null;
  onLeave: () => void;
}

function Result({ analysis, target, clip, plan, options, selected, onSelect, generateHref, onLeave }: ResultProps) {
  const editor = useEditor();
  const at = (frame: number) => formatTimecode(clip.start_frame + frame, editor.fps);
  const originalAt = (frame: number) => cueTime(target.refStart + (target.first + frame) / target.fps);
  const verdict = (options ? recommendationVerdict(options.recommendation, options.scores.retime) : null) ?? conformVerdict(analysis, plan);
  const recommended = options?.recommendation.kind === "method" ? options.recommendation.method : null;
  const worse = options?.recommendation.kind === "none" && options.recommendation.why === "worse";
  const unmatched = analysis.originalCuts.length > 0 && analysis.timing.matched === 0;
  // The tables below describe the cut plan unless a motion edit is chosen
  const motion = selected === "retime" || selected === "shift" ? selected : null;
  const score = selected && options ? options.scores[selected] : null;
  return (
    <>
      <Verdict
        verdict={verdict}
        icon={recommended ? METHOD_ICON[recommended] : TONE_ICON[verdict.tone]}
        regenerate={(generateHref != null && generateHref !== "") && (unmatched || worse) ? { href: generateHref, label: t("到「鏡頭」重新生成這段"), onLeave } : null}
      />
      {options && options.listed.length > 0 ? <MethodChoice options={options} selected={selected} onSelect={onSelect} /> : null}
      <Facts className="text-caption">
        <Fact label={t("原片的切點")}>{analysis.originalCuts.length === 0 ? t("沒有") : t("{count} 個：{times}", { count: analysis.originalCuts.length, times: formatList(analysis.originalCuts.map(at)) })}</Fact>
        <Fact label={t("生成的切點")}>{analysis.takeCuts.length === 0 ? t("沒有") : t("{count} 個：{times}", { count: analysis.takeCuts.length, times: formatList(analysis.takeCuts.map(at)) })}</Fact>
      </Facts>
      {analysis.timing.matched > 0 ? <OnTime before={analysis.timing} after={score ? score.timing : (plan?.ok === true) ? plan.plan.after : null} /> : null}
      <PairTable analysis={analysis} plan={motion ? null : plan} at={at} originalAt={originalAt} />
      {!motion && (plan?.ok === true) ? <SpanTable plan={plan.plan} at={at} /> : null}
      {!motion && (plan?.ok === true) ? <PlanNote plan={plan.plan} /> : null}
      {motion && options ? <MotionNote options={options} method={motion} /> : null}
    </>
  );
}

/** The on-time count now and after the edit, as two bars. */
function OnTime({ before, after }: { before: CutTiming; after: CutTiming | null }) {
  const rows = [
    { label: t("現在"), timing: before, tone: "bg-fg-tertiary/60" },
    ...(after ? [{ label: t("套用後"), timing: after, tone: "bg-brand-gradient" }] : []),
  ];
  return (
    <section aria-label={t("準時的切點")} className="grid gap-1.5">
      <span className="text-caption text-fg-tertiary">{t("準時的切點（和原片差 {frames} 影格以內）", { frames: ON_TIME_FRAMES })}</span>
      {rows.map((row, index) => (
        <div key={row.label} ref={reveal(index)} className="grid grid-cols-[4rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-caption">
          <span className="text-fg-secondary">{row.label}</span>
          <span aria-hidden className="block h-1.5 overflow-hidden rounded-full bg-raised">
            <span
              className={cn("block h-full origin-left rounded-full transition-transform duration-(--duration-slow) ease-standard", row.tone)}
              style={{ transform: `scaleX(${String(row.timing.matched > 0 ? row.timing.onTime / row.timing.matched : 0)})` }}
            />
          </span>
          <span className="machine text-right text-fg">{t("{onTime}／{matched}", { onTime: row.timing.onTime, matched: row.timing.matched })}</span>
        </div>
      ))}
    </section>
  );
}

function PairTable({ analysis, plan, at, originalAt }: { analysis: ConformAnalysis; plan: ConformPlanResult | null; at: (frame: number) => string; originalAt: (frame: number) => string }) {
  const rows = pairRows(analysis, plan);
  if (rows.length === 0) return <p className="text-caption text-fg-tertiary">{t("兩邊都沒有找到切點。")}</p>;
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-caption text-fg-tertiary">{t("切點配對（偏差 = 生成的切點減原片的切點，正數是生成晚了）")}</span>
      <div className="overflow-x-auto rounded-lg border border-line-subtle">
        <table className="w-full min-w-[40rem] table-fixed border-collapse text-data">
          <caption className="sr-only">{t("原片和生成的切點配對與處理結果")}</caption>
          <thead className="bg-canvas text-caption text-fg-tertiary">
            <tr>
              <th scope="col" className="w-36 px-2 py-1.5 text-left font-medium">
                {t("原片的切點")}
              </th>
              <th scope="col" className="w-32 px-2 py-1.5 text-left font-medium">
                {t("生成的切點")}
              </th>
              <th scope="col" className="w-24 px-2 py-1.5 text-left font-medium">
                {t("偏差")}
              </th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t("結果")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${String(index)}:${String(row.original ?? "-")}:${String(row.take ?? "-")}`} ref={reveal(index)} className="border-t border-line-subtle align-top">
                <td className="px-2 py-1.5">
                  {row.original === null ? (
                    <span className="text-fg-tertiary">—</span>
                  ) : (
                    <>
                      {(row.atEnd === true) ? <span className="block text-fg">{t("片段結尾")}</span> : <span className="machine block text-fg">{at(row.original)}</span>}
                      <span className="machine block text-caption text-fg-tertiary">{t("原片 {time}", { time: originalAt(row.original) })}</span>
                    </>
                  )}
                </td>
                <td className="px-2 py-1.5">{row.take === null ? <span className="text-fg-tertiary">—</span> : <span className="machine block text-fg">{at(row.take)}</span>}</td>
                <td className="px-2 py-1.5">
                  {row.offset === null ? (
                    <span className="text-fg-tertiary">—</span>
                  ) : (
                    <span className={cn("machine", Math.abs(row.offset) <= ON_TIME_FRAMES ? "text-success" : "text-warning")}>{t("{frames} 影格", { frames: signedFrames(row.offset) })}</span>
                  )}
                </td>
                <td className={cn("px-2 py-1.5 text-caption [overflow-wrap:anywhere]", PAIR_TEXT[row.tone])}>{row.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SpanTable({ plan, at }: { plan: ConformPlan; at: (frame: number) => string }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-caption text-fg-tertiary">{t("每一段怎麼調整（套用後的位置；影格數是生成 → 套用後）")}</span>
      <div className="overflow-x-auto rounded-lg border border-line-subtle">
        <table className="w-full min-w-[40rem] table-fixed border-collapse text-data">
          <caption className="sr-only">{t("切點之間每一段的調整")}</caption>
          <thead className="bg-canvas text-caption text-fg-tertiary">
            <tr>
              <th scope="col" className="w-56 px-2 py-1.5 text-left font-medium">
                {t("位置")}
              </th>
              <th scope="col" className="w-28 px-2 py-1.5 text-left font-medium">
                {t("影格數")}
              </th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t("做法")}
              </th>
            </tr>
          </thead>
          <tbody>
            {plan.spans.map((span, index) => (
              <tr key={`${String(span.output.from)}:${String(span.take.from)}`} ref={reveal(index)} className="border-t border-line-subtle align-top">
                <td className="machine px-2 py-1.5 text-fg">{span.output.from === span.output.to ? <span className="text-fg-tertiary">—</span> : `${at(span.output.from)}–${at(span.output.to)}`}</td>
                <td className="machine px-2 py-1.5 text-fg-secondary">{`${String(span.take.to - span.take.from)} → ${String(span.output.to - span.output.from)}`}</td>
                <td className={cn("px-2 py-1.5 text-caption [overflow-wrap:anywhere]", spanChanges(span) ? "text-brand-cyan" : "text-fg-tertiary")}>{spanText(span, at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanNote({ plan }: { plan: ConformPlan }) {
  const holds = plan.spans.filter((span) => span.treatment.kind === "hold").length;
  const faster = plan.spans.filter((span) => span.treatment.kind === "faster" || span.treatment.kind === "drops").length;
  const end = plan.spans.find((span) => span.treatment.kind === "end");
  return (
    <section aria-label={t("套用後")} className="grid gap-1 rounded-lg border border-line-subtle bg-sunken/60 p-3 text-caption text-fg-secondary animate-reveal">
      <h4 className="font-semibold text-fg-secondary">{t("套用後")}</h4>
      <p>
        {faster === 0
          ? t("這個片段分成 {parts} 段：{holds} 段在最靜止的一格停格補足，生成的切點落在原片切點的同一格。片段總長不變，後面的片段和原片的聲音都不動。", { parts: plan.parts, holds })
          : holds === 0
            ? t("這個片段分成 {parts} 段：{faster} 段在最靜止的地方加快（一次最多跳過 1 格，不碰閃光和切鏡旁的畫格），生成的切點落在原片切點的同一格。片段總長不變，後面的片段和原片的聲音都不動。", { parts: plan.parts, faster })
            : t("這個片段分成 {parts} 段：{holds} 段在最靜止的一格停格補足，{faster} 段在最靜止的地方加快（一次最多跳過 1 格，不碰閃光和切鏡旁的畫格），生成的切點落在原片切點的同一格。片段總長不變，後面的片段和原片的聲音都不動。", {
                parts: plan.parts,
                holds,
                faster,
              })}
      </p>
      {end ? <p>{t("生成在片段結尾前 {frames} 影格就切到下一個鏡頭：這 {frames} 影格剪掉，前面的畫面拉長補到片段結尾。", { frames: end.take.to - end.take.from })}</p> : null}
      {plan.linked ? <p>{t("連結的聲音（這個 take 自己的聲音）跟著畫面一起分割、停格和變速，保持同步。")}</p> : null}
      {plan.blocked.length > 0 ? <p>{t("{count} 個切點不能用，維持原樣（原因列在上面的表格）。", { count: plan.blocked.length })}</p> : null}
      <p>{t("對齊後，有停格或變速的片段不能再用「加效果」分析；已經加了震動的片段也不能對齊。")}</p>
    </section>
  );
}
