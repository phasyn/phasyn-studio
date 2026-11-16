// Export of the sequence as one video, in one screen: 基本 (range, size, quality) and 進階 (fit, encoding speed, sound)
// tabs and a fixed footer with what comes out (size and length) and what blocks it. How long the export takes and
// how big the file gets are not shown: nothing in the Studio has a basis for either estimate. Quality, speed, sound
// and range are remembered in this browser; size and fit are the project's (export_format). Submitting hands the
// options to exportSequence, which creates the media.concat run; progress shows in notices and in Render. Every
// project exports through its timeline, a face-swap project included. A clip that plays an original video's sound is
// pointed out (not blocked): its lines do not match the new characters' mouths and voices.
import { CircleAlert, Download, Settings2, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { OPTION_CARD, OPTION_IDLE, OPTION_SELECTED } from "@/components/ui/look";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { t } from "@/i18n";
import { formatList, joinInline } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { usePersistentChoice } from "@/lib/usePersistentSize";
import { useEditor } from "../editor/editorContext";
import { exportTarget, sequenceExport } from "../editor/export";
import { originalSoundClips } from "../editor/originalSound";
import { AUDIO_BITRATES, DEFAULT_EXPORT_CHOICE, exportOptionIssues, exportOptionsFor, formatBitrate, QUALITY_PRESETS, SPEED_PRESETS, type QualityId, type SpeedId } from "../model/exportPresets";
import { formatDuration, formatTimecode } from "../model/frames";
import { EXPORT_SIZE_PRESETS, exportGeometry, type ExportFit } from "../model/project";

type ExportTab = "basic" | "advanced";
type ExportRange = "sequence" | "work_area";

const QUALITY_IDS: readonly QualityId[] = QUALITY_PRESETS.map((item) => item.id);
const SPEED_IDS: readonly SpeedId[] = SPEED_PRESETS.map((item) => item.id);
const AUDIO_KEYS: readonly string[] = AUDIO_BITRATES.map(String);
const RANGES: readonly ExportRange[] = ["sequence", "work_area"];

interface ChoiceProps<T extends string | number> {
  legend: string;
  name: string;
  value: T;
  /** hint: a second line; with quiet, only the tooltip (a hint that names encoder parameters). */
  options: readonly { value: T; label: string; hint: string; quiet?: boolean }[];
  onChange: (value: T) => void;
}

function Choice<T extends string | number>({ legend, name, value, options, onChange }: ChoiceProps<T>) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="pb-1 text-caption font-medium text-fg-secondary">{legend}</legend>
      <div className="grid gap-1.5 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
        {options.map((option) => (
          <label
            key={option.value}
            title={option.hint}
            className={cn(OPTION_CARD, "flex min-h-11 cursor-pointer items-center gap-2 px-2.5 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus", option.value === value ? OPTION_SELECTED : OPTION_IDLE)}
          >
            <input type="radio" name={name} checked={option.value === value} onChange={() => onChange(option.value)} className="accent-action" />
            <span className="grid min-w-0">
              <span className="truncate text-data text-fg">{option.label}</span>
              {option.quiet ? null : <span className="truncate text-caption text-fg-tertiary">{option.hint}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ExportForm({ onDone }: { onDone: () => void }) {
  const { project, timeline, exportSequence, busy, runBlockedReason, engine, setEngineOpen, dispatch } = useEditor();
  const id = useId();
  const [tab, setTab] = useState<ExportTab>("basic");
  const [quality, setQuality] = usePersistentChoice<QualityId>("studio.export.quality", DEFAULT_EXPORT_CHOICE.quality, QUALITY_IDS);
  const [speed, setSpeed] = usePersistentChoice<SpeedId>("studio.export.speed", DEFAULT_EXPORT_CHOICE.speed, SPEED_IDS);
  const [audioKey, setAudioKey] = usePersistentChoice<string>("studio.export.audio", String(DEFAULT_EXPORT_CHOICE.audioBitrate), AUDIO_KEYS);
  const [storedRange, storeRange] = usePersistentChoice<ExportRange>("studio.export.range", "sequence", RANGES);
  const area = timeline.work_area;
  // A remembered 入點到出點 opens as the whole sequence in a sequence without marks; choosing it there shows why it
  // cannot export (the problem list), as before
  const [range, setRangeState] = useState<ExportRange>(() => (storedRange === "work_area" && !area ? "sequence" : storedRange));
  const setRange = (next: ExportRange) => {
    setRangeState(next);
    storeRange(next);
  };
  const [submitting, setSubmitting] = useState(false);
  const audioBitrate = Number(audioKey);
  const fps = timeline.fps.num / timeline.fps.den;
  const geometry = exportGeometry(project);
  const sizeId = project.export_format ? (EXPORT_SIZE_PRESETS.find((item) => item.width === geometry.width && item.height === geometry.height)?.id ?? "custom") : "project";
  const setSize = (value: string) => {
    const preset = EXPORT_SIZE_PRESETS.find((item) => item.id === value);
    dispatch({ type: "setExportFormat", exportFormat: preset ? { width: preset.width, height: preset.height, fit: project.export_format?.fit ?? "cover" } : null });
  };
  const setFit = (fit: ExportFit) => {
    if (project.export_format) dispatch({ type: "setExportFormat", exportFormat: { ...project.export_format, fit } });
  };
  const options = { ...exportOptionsFor(quality, speed, audioBitrate), range };
  const component = engine.concat.component;
  const preview = sequenceExport(project, component ? exportTarget(component) : null, options);
  const optionIssues = exportOptionIssues(options, component?.settings.parameters_schema);
  // Not a blocker: a film may keep the original sound on purpose; the user is told what it does to mouths and voices
  const originalSound = originalSoundClips(project, timeline);
  const audioTracks = timeline.tracks.filter((track) => track.kind === "audio" && timeline.clips.some((clip) => clip.track_id === track.track_id)).length;
  const blocked =
    (preview.problems.length > 0 ? t("還不能匯出：{problems}", { problems: preview.problems.join(t("；")) }) : null) ??
    (!engine.concat.usable ? t("匯出元件無法使用：{value}", { value: engine.concat.reason ?? t("未知原因") }) : null) ??
    runBlockedReason ??
    (busy === "render" ? t("正在送出渲染") : busy === "export" ? t("正在送出匯出") : null) ??
    (optionIssues.length > 0 ? optionIssues.join(t("；")) : null);
  // What comes out, in the footer; the rest of the facts are its tooltip
  const summary = t("{width}×{height}・{duration}", { width: geometry.width, height: geometry.height, duration: formatDuration(preview.totalFrames, fps) });
  const facts = joinInline([
    t("MP4（H.264 影片＋AAC 音訊）"),
    t("{clips} 個片段", { clips: preview.clips }),
    audioTracks > 0 ? t("{count} 條音訊軌混音", { count: audioTracks }) : t("沒有聲音"),
    geometry.fit ? t("由 {width}×{height} {fit}", { width: project.format.width, height: project.format.height, fit: geometry.fit === "cover" ? t("填滿") : t("補黑邊") }) : "",
    component ? t("匯出元件 {component}（{node}）", { component: component.component_id, node: engine.concat.nodeLabel }) : "",
  ].filter(Boolean));

  const submit = async () => {
    if (blocked || submitting) return;
    setSubmitting(true);
    try {
      await exportSequence(options);
    } finally {
      setSubmitting(false);
      onDone();
    }
  };

  const basic = (
    <div className="grid content-start gap-4">
      <Choice<ExportRange>
        legend={t("匯出範圍")}
        name={`${id}-range`}
        value={range}
        onChange={setRange}
        options={[
          { value: "sequence", label: t("完整序列"), hint: t("時間軸上的所有內容") },
          {
            value: "work_area",
            label: t("入點到出點"),
            hint: area ? t("{start} – {end}", { start: formatTimecode(area.start_frame, fps), end: formatTimecode(area.end_frame, fps) }) : t("還沒有標記序列的入點和出點"),
          },
        ]}
      />
      <Choice<string>
        legend={t("輸出尺寸")}
        name={`${id}-size`}
        value={sizeId}
        onChange={setSize}
        options={[
          { value: "project", label: t("與渲染相同"), hint: t("{width}×{height}", { width: project.format.width, height: project.format.height }) },
          ...EXPORT_SIZE_PRESETS.map((item) => ({ value: item.id, label: item.label, hint: t("{width}×{height}", { width: item.width, height: item.height }) })),
        ]}
      />
      <Choice legend={t("畫質")} name={`${id}-quality`} value={quality} onChange={setQuality} options={QUALITY_PRESETS.map((item) => ({ value: item.id, label: item.label, hint: item.hint, quiet: true }))} />
      {preview.problems.length > 0 ? (
        <div role="alert" className="grid gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
          <p className="flex items-center gap-1.5 text-data font-medium text-warning">
            <CircleAlert aria-hidden className="size-4 shrink-0" />
            {t("要先處理這些問題才能匯出")}
          </p>
          <ul className="grid max-h-28 list-disc gap-0.5 overflow-y-auto pl-6 text-data text-fg-secondary">
            {preview.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {originalSound.length > 0 ? (
        <div role="status" className="grid gap-0.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 animate-fade-in">
          <p className="flex items-center gap-1.5 text-data font-medium text-warning">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            {t("時間軸上有原片的聲音")}
          </p>
          <p className="line-clamp-3 text-data text-fg-secondary [overflow-wrap:anywhere]" title={formatList(originalSound)}>
            {t("「{names}」播放原影片的聲音：台詞是原角色的嘴型與聲線，會對不上新角色。要用生成的聲音，到「編輯」把它靜音或刪除。", { names: formatList(originalSound) })}
          </p>
        </div>
      ) : null}
    </div>
  );

  const advanced = (
    <div className="grid content-start gap-4">
      {project.export_format ? (
        <Choice<ExportFit>
          legend={t("縮放方式")}
          name={`${id}-fit`}
          value={project.export_format.fit}
          onChange={setFit}
          options={[
            { value: "cover", label: t("填滿"), hint: t("裁掉超出的邊緣") },
            { value: "contain", label: t("完整放入"), hint: t("比例不同時補黑邊") },
          ]}
        />
      ) : (
        <fieldset className="grid gap-1.5">
          <legend className="pb-1 text-caption font-medium text-fg-secondary">{t("縮放方式")}</legend>
          <p className="text-data text-fg-tertiary">{t("輸出尺寸與渲染相同，不需要縮放。")}</p>
        </fieldset>
      )}
      <Choice legend={t("編碼速度")} name={`${id}-speed`} value={speed} onChange={setSpeed} options={SPEED_PRESETS.map((item) => ({ value: item.id, label: item.label, hint: item.hint, quiet: true }))} />
      <Choice
        legend={t("音訊位元率（AAC）")}
        name={`${id}-audio`}
        value={audioKey}
        onChange={setAudioKey}
        options={AUDIO_BITRATES.map((bps) => ({ value: String(bps), label: formatBitrate(bps), hint: bps === 192_000 ? t("元件預設") : bps < 192_000 ? t("檔案較小") : t("音質較好") }))}
      />
    </div>
  );

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <PanelTabs
        variant="studio"
        idPrefix={`${id}-export`}
        label={t("匯出設定")}
        value={tab}
        onChange={(next) => setTab(next === "advanced" ? "advanced" : "basic")}
        tabs={[
          { id: "basic", label: t("基本"), icon: SlidersHorizontal, count: preview.problems.length || undefined, countTone: "warning" },
          { id: "advanced", label: t("進階"), icon: Settings2 },
        ]}
      />
      <DialogBody className="h-[min(22rem,48vh)] flex-none">
        <div key={tab} role="tabpanel" id={`${id}-export-panel-${tab}`} aria-labelledby={`${id}-export-tab-${tab}`} className="animate-fade-in">
          {tab === "basic" ? basic : advanced}
        </div>
      </DialogBody>
      <DialogFooter className="flex-nowrap justify-between gap-4">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="machine truncate text-body text-fg" title={facts}>
            {summary}
          </p>
          {blocked ? (
            <p className="flex min-w-0 items-center gap-1.5 text-caption text-warning">
              <span className="line-clamp-2 min-w-0" title={blocked}>
                {blocked}
              </span>
              {!engine.concat.usable && component ? (
                <button type="button" onClick={() => setEngineOpen(true)} className="pressable shrink-0 rounded-md px-1.5 text-action-fg hover:bg-raised active:bg-sunken">
                  {t("開啟渲染引擎")}
                </button>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DialogClose asChild>
            <Button>{t("取消")}</Button>
          </DialogClose>
          <ActionButton type="submit" variant="primary" icon={<Download aria-hidden />} pending={submitting || busy === "export"} disabledReason={blocked}>
            {t("開始匯出")}
          </ActionButton>
        </div>
      </DialogFooter>
    </form>
  );
}

/**
 * The export button and its dialog: 「匯出影片…」; `primary` draws the gradient 「匯出」 of the Edit workspace's header.
 * size and className size the trigger where it sits (the render queue's footer makes it full width).
 */
export function ExportDialog({ primary = false, size = "sm", className }: { primary?: boolean; size?: "sm" | "md"; className?: string }) {
  const { busy } = useEditor();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={size} variant={primary ? "primary" : "secondary"} icon={<Download aria-hidden />} pending={busy === "export"} title={t("檢查序列、選擇編碼設定後匯出成一支 MP4")} className={className}>
          {primary ? t("匯出") : t("匯出影片…")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl" onKeyDown={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t("匯出影片")}</DialogTitle>
          <DialogDescription>{t("把時間軸合成並重新編碼成一支影片。")}</DialogDescription>
        </DialogHeader>
        {open ? <ExportForm onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
