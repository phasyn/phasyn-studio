// The speed-feel dialog for one clip of the timeline, with two tools. 加效果: it reads the clip's take and its original
// frame by frame (with progress and a cancel), says in plain words whether effects help and why, lists the original's
// accents with what became of each, shows the clip's flags and the rough photosensitivity check, and applies the edit
// as one named history step that one undo takes back. 對齊原片切點 (ConformMode): the take's cuts moved onto the
// original's. Opened from the clip's menu, Effect Controls (速度感: either tool) and the swap panel's check; opening a
// tool reads the clip once, leaving it or closing the dialog stops a read. The tools are WAI-ARIA tabs (arrow keys,
// Home and End switch them).
// Look (Phasyn): the dialog; the tab line slides to the chosen tool and its panel fades in; states fade into each other
// (useChangeFade, animate-reveal), the accent rows enter one after another (Motion), the reading progress is the brand
// gradient (transform only); the table stays crisp.
import { Activity, CircleCheck, CircleX, Flag, Layers, Magnet, Scissors, ShieldAlert, TriangleAlert, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reveal } from "@/components/ui/motion";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { useEditor } from "../editor/editorContext";
import { formatTimecode } from "../model/frames";
import { Fact, Facts, NoteList } from "../swap/fields";
import type { AccentKind, SpeedFeelAnalysis } from "./analysis";
import { ConformMode } from "./ConformMode";
import { ToolBody, ToolFooter, Verdict, type ToolProps } from "./DialogParts";
import { clearSpeedFeelTool, requestedSpeedFeelTool, type SpeedFeelTool } from "./mode";
import { planSpeedFeel, type SpeedFeelPlanResult } from "./plan";
import { cancelSpeedFeel, startSpeedFeel, useSpeedFeelResults } from "./reader";
import { speedFeelTarget, type SpeedFeelTarget } from "./target";
import { clipTitle, cueTime, flagNotes, flashCheck, kindLabel, outcomeText, speedFeelLabel, verdictView, type FeelTone, type OutcomeTone } from "./view";

const TONE_ICON: Record<FeelTone, LucideIcon> = { info: Zap, success: CircleCheck, warning: TriangleAlert };
const OUTCOME_TEXT: Record<OutcomeTone, string> = { kept: "text-brand-cyan", skipped: "text-fg-tertiary", generation: "text-warning" };
const KIND_ICON: Record<AccentKind, LucideIcon> = { action: Activity, flash: Zap, twos: Layers, edit: Scissors };

export function SpeedFeelDialog() {
  const editor = useEditor();
  const clipId = editor.ui.speedFeelClip;
  const close = () => editor.ui.setSpeedFeelClip(null);
  return (
    <Dialog
      open={clipId !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {clipId !== null ? <SpeedFeelContent key={clipId} clipId={clipId} onClose={close} /> : null}
    </Dialog>
  );
}

function SpeedFeelContent({ clipId, onClose }: { clipId: string; onClose: () => void }) {
  const editor = useEditor();
  const clip = editor.timeline.clips.find((item) => item.clip_id === clipId) ?? null;
  const [tool, setTool] = useState<SpeedFeelTool>(() => requestedSpeedFeelTool(clipId));
  // The tool asked for steers this opening only
  useEffect(() => clearSpeedFeelTool(), []);
  // The step each tool applied stays here: switching tools unmounts the one left
  const [effectsApplied, setEffectsApplied] = useState<string | null>(null);
  const [conformApplied, setConformApplied] = useState<string | null>(null);
  const idPrefix = useId();
  const tools = [
    { id: "effects", label: t("加效果"), icon: <Zap aria-hidden /> },
    { id: "conform", label: t("對齊原片切點"), icon: <Magnet aria-hidden /> },
  ];
  return (
    <DialogContent wide onKeyDown={(event) => event.stopPropagation()}>
      <DialogHeader className="pb-0">
        <DialogTitle className="flex items-center gap-2">
          <Zap aria-hidden className="size-4 text-brand-cyan" />
          {t("速度感")}
        </DialogTitle>
        <DialogDescription>
          {tool === "effects"
            ? t("「{clip}」：比對原片（這個鏡頭的 @Video1 參考影片）的動作重音，在生成沒打到的地方切開片段，加上震動與負片衝擊格。", { clip: clip?.name ?? "" })
            : t("「{clip}」：找出原片（這個鏡頭的 @Video1 參考影片）和生成的切點並配對，在動作最少的地方停格或加快，讓生成的切點落在原片切點的同一格；片段總長不變。", { clip: clip?.name ?? "" })}
        </DialogDescription>
        <Tabs items={tools} value={tool} onChange={(id) => setTool(id === "conform" ? "conform" : "effects")} idPrefix={idPrefix} label={t("速度感的工具")} size="sm" className="-mx-6 mt-2 border-b-0 px-6" />
      </DialogHeader>
      <TabPanel key={tool} idPrefix={idPrefix} id={tool} className="flex min-h-0 flex-1 flex-col animate-reveal">
        {tool === "effects" ? (
          <EffectsTool clipId={clipId} applied={effectsApplied} onApplied={setEffectsApplied} onClose={onClose} />
        ) : (
          <ConformMode clipId={clipId} applied={conformApplied} onApplied={setConformApplied} onClose={onClose} />
        )}
      </TabPanel>
    </DialogContent>
  );
}

function EffectsTool({ clipId, applied, onApplied, onClose }: ToolProps) {
  const editor = useEditor();
  const { project, timeline } = editor;
  const results = useSpeedFeelResults();
  const target = useMemo(() => speedFeelTarget(project, timeline, clipId), [project, timeline, clipId]);
  const clip = timeline.clips.find((item) => item.clip_id === clipId) ?? null;
  const status = target.ok ? (results.get(target.key) ?? null) : null;
  const analysis = status?.status === "done" ? status.analysis : null;
  const plan = useMemo(() => (analysis?.verdict === "add" && applied === null ? planSpeedFeel(timeline, clipId, analysis.hits) : null), [analysis, applied, timeline, clipId]);

  // Opening the tool (or a clip that changed since) reads the clip once
  const begin = useEffectEvent(() => {
    if (target.ok && applied === null && status?.status !== "done" && status?.status !== "failed") startSpeedFeel(target);
  });
  const key = target.ok ? target.key : null;
  useEffect(() => {
    begin();
  }, [key]);
  // Leaving the tool or closing the dialog stops a read (finished results stay)
  useEffect(() => cancelSpeedFeel, []);

  const apply = () => {
    if (!plan?.ok || !clip) return;
    const label = speedFeelLabel(clipTitle(project, timeline, clip), plan.plan.hits.length);
    if (editor.commit(plan.plan.timeline, label)) onApplied(label);
  };
  const shotId = timeline.sources.find((source) => source.source_id === clip?.source_id)?.shot_id ?? null;
  const generateHref = shotId ? `/studio/generate?project=${encodeURIComponent(project.project_id)}&shot=${encodeURIComponent(shotId)}` : null;

  return (
    <>
      <ToolBody
        applied={applied}
        target={target}
        status={status}
        intro={t("在這個瀏覽器逐格讀取這個片段的 take 和原片（一次讀一支影片），找出原片的動作重音，判斷生成在哪裡沒打到。片段越長，讀取越久；可以隨時取消。")}
      >
        {target.ok && clip && analysis ? <Result analysis={analysis} target={target} clip={clip} plan={plan} generateHref={generateHref} onLeave={onClose} /> : null}
      </ToolBody>
      <ToolFooter applied={applied} onUndone={() => onApplied(null)} reading={target.ok ? { status: status?.status ?? null, start: () => startSpeedFeel(target), cancel: cancelSpeedFeel } : null}>
        {applied === null && analysis?.verdict === "add" ? (
          <ActionButton variant="primary" icon={<Zap aria-hidden />} disabledReason={plan && !plan.ok ? plan.reason : null} onClick={apply}>
            {t("套用")}
          </ActionButton>
        ) : null}
      </ToolFooter>
    </>
  );
}

interface ResultProps {
  analysis: SpeedFeelAnalysis;
  target: SpeedFeelTarget;
  clip: TimelineClip;
  plan: SpeedFeelPlanResult | null;
  generateHref: string | null;
  onLeave: () => void;
}

function Result({ analysis, target, clip, plan, generateHref, onLeave }: ResultProps) {
  const editor = useEditor();
  const at = (frame: number) => formatTimecode(clip.start_frame + frame, editor.fps);
  const originalAt = (frame: number) => cueTime(target.refStart + (target.first + frame) / target.fps);
  const verdict = verdictView(analysis, at);
  const notes = flagNotes(analysis, at);
  const flashes = analysis.verdict === "add" ? flashCheck(analysis) : null;
  const length = target.end - target.first;
  const regenerate =
    generateHref && (analysis.verdict === "regenerate" || analysis.verdict === "edits")
      ? { href: generateHref, label: analysis.verdict === "regenerate" ? t("到「鏡頭」重新生成這段") : t("到「鏡頭」調整這段"), onLeave }
      : null;
  return (
    <>
      <Verdict verdict={verdict} icon={TONE_ICON[verdict.tone]} regenerate={regenerate} />
      {notes.length > 0 ? <NoteList tone="warning" icon={<Flag aria-hidden />} items={notes} /> : null}
      {flashes?.warning ? <NoteList tone="danger" icon={<ShieldAlert aria-hidden />} items={[flashes.text]} /> : null}
      <Facts className="text-caption">
        <Fact label={t("動作量 p90（生成／原片）")}>
          {t("{take}／{original}", { take: analysis.take.p90.toFixed(1), original: analysis.original.p90.toFixed(1) })}
        </Fact>
        <Fact label={t("分析範圍")}>
          {t("這個片段的 {frames} 影格（序列 {from}–{to}），對照原片 {originalFrom}–{originalTo}", { frames: length, from: at(0), to: at(length), originalFrom: originalAt(0), originalTo: originalAt(length) })}
        </Fact>
        {flashes && !flashes.warning ? <Fact label={t("光敏粗檢")}>{flashes.text}</Fact> : null}
      </Facts>
      <AccentTable analysis={analysis} plan={plan} at={at} originalAt={originalAt} />
      {analysis.verdict === "add" && plan ? <PlanNote plan={plan} at={at} /> : null}
    </>
  );
}

function AccentTable({ analysis, plan, at, originalAt }: { analysis: SpeedFeelAnalysis; plan: SpeedFeelPlanResult | null; at: (frame: number) => string; originalAt: (frame: number) => string }) {
  if (analysis.decisions.length === 0) return <p className="text-caption text-fg-tertiary">{t("原片這段沒有找到重音。")}</p>;
  const hits = new Map(analysis.hits.map((hit) => [hit.accent, hit.effects]));
  const blocked = new Map((plan ? (plan.ok ? plan.plan.blocked : plan.blocked) : []).map((hit) => [hit.accent, hit.reason]));
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-caption text-fg-tertiary">{t("原片的重音（強度是和這段最大的變化相比，0–1）")}</span>
      <div className="overflow-x-auto rounded-lg border border-line-subtle">
        <table className="w-full min-w-[40rem] table-fixed border-collapse text-data">
          <caption className="sr-only">{t("原片的重音與處理結果")}</caption>
          <thead className="bg-canvas text-caption text-fg-tertiary">
            <tr>
              <th scope="col" className="w-36 px-2 py-1.5 text-left font-medium">
                {t("時間")}
              </th>
              <th scope="col" className="w-36 px-2 py-1.5 text-left font-medium">
                {t("種類")}
              </th>
              <th scope="col" className="w-28 px-2 py-1.5 text-left font-medium">
                {t("強度")}
              </th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t("結果")}
              </th>
            </tr>
          </thead>
          <tbody>
            {analysis.decisions.map((decision, index) => {
              const { accent } = decision;
              const outcome = outcomeText(decision, analysis, hits.get(accent) ?? null, blocked.get(accent) ?? null);
              const KindIcon = KIND_ICON[accent.kind];
              return (
                <tr key={`${index}:${accent.frame}`} ref={reveal(index)} className="border-t border-line-subtle align-top">
                  <td className="px-2 py-1.5">
                    <span className="machine block text-fg">{at(accent.frame)}</span>
                    <span className="machine block text-caption text-fg-tertiary">{t("原片 {time}", { time: originalAt(accent.frame) })}</span>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1.5 text-fg-secondary [&_svg]:size-3.5 [&_svg]:shrink-0">
                      <KindIcon aria-hidden />
                      {kindLabel(accent.kind)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span className="machine w-9 text-fg">{accent.strength.toFixed(2)}</span>
                      <span aria-hidden className="block h-1 w-12 overflow-hidden rounded-full bg-raised">
                        <span className={cn("block h-full rounded-full", decision.kept ? "bg-brand-cyan/80" : "bg-fg-tertiary/50")} style={{ width: `${Math.round(accent.strength * 100)}%` }} />
                      </span>
                    </span>
                  </td>
                  <td className={cn("px-2 py-1.5 text-caption [overflow-wrap:anywhere]", OUTCOME_TEXT[outcome.tone])}>{outcome.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanNote({ plan, at }: { plan: SpeedFeelPlanResult; at: (frame: number) => string }) {
  if (!plan.ok) return <NoteList tone="warning" icon={<CircleX aria-hidden />} title={t("沒辦法套用")} items={[plan.reason]} />;
  const { hits, linked } = plan.plan;
  const shakes = hits.some((hit) => hit.effects.camera);
  return (
    <section aria-label={t("套用後")} className="grid gap-1 rounded-lg border border-line-subtle bg-sunken/60 p-3 text-caption text-fg-secondary animate-reveal">
      <h4 className="font-semibold text-fg-secondary">{t("套用後")}</h4>
      <p>{t("在 {times} 切開這個片段，從重音那格開始的片段加上效果；不移動任何畫格，片段總長和聲音同步都不變。", { times: formatList(hits.map((hit) => at(hit.accent.frame))) })}</p>
      {linked ? <p>{t("連結的音訊片段會在同樣的影格一起切開，聲音照常連續播放。")}</p> : null}
      {shakes ? <p>{t("有震動的片段會稍微放大（震動需要的留邊），到下一個切點恢復。")}</p> : null}
    </section>
  );
}
