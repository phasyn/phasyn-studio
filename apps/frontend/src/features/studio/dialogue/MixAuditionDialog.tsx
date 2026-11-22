// 「最終混音試聽」 beside the audio mixer: the whole sequence's audio mixed as the export would mix it, without encoding
// the picture. Bitrate and loudness target are the export's own remembered choices (the same stored keys as the export
// dialog), so what is heard here is what the delivery will carry.
import { Headphones } from "lucide-react";
import { Suspense, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { isRecord } from "@/lib/json";
import { usePersistentChoice } from "@/lib/usePersistentSize";
import { AudioMixAudition } from "../components/AudioMixAudition";
import { Segmented } from "../components/generation/Segmented";
import { useEditor } from "../editor/editorContext";
import { exportTarget, sequenceExport } from "../editor/export";
import { AUDIO_BITRATES, DEFAULT_EXPORT_CHOICE, exportOptionIssues, exportOptionsFor, formatBitrate, LOUDNESS_TARGETS } from "../model/exportPresets";

const AUDIO_KEYS: readonly string[] = AUDIO_BITRATES.map(String);
const LOUDNESS_KEYS: readonly string[] = LOUDNESS_TARGETS.map((item) => String(item.lufs));

function Body() {
  const loudnessId = useId();
  const bitrateId = useId();
  const { project, engine, runBlockedReason, busy } = useEditor();
  // The export dialog's stored choices (ExportForm uses the same keys)
  const [audioKey, setAudioKey] = usePersistentChoice<string>("studio.export.audio", String(DEFAULT_EXPORT_CHOICE.audioBitrate), AUDIO_KEYS);
  const [loudnessKey, setLoudnessKey] = usePersistentChoice<string>("studio.export.loudness", String(DEFAULT_EXPORT_CHOICE.loudness), LOUDNESS_KEYS);
  const component = engine.concat.component;
  const options = { ...exportOptionsFor(DEFAULT_EXPORT_CHOICE.quality, DEFAULT_EXPORT_CHOICE.speed, Number(audioKey), Number(loudnessKey)), range: "sequence" as const, unrendered: "gap" as const };
  const audition = sequenceExport(project, component ? exportTarget(component) : null, options);
  const capabilities = component?.facts?.["timeline_export"];
  const audioOnly = isRecord(capabilities) && capabilities["audio_only"] === true;
  const blocked =
    audition.problems[0] ??
    (!engine.concat.usable ? (engine.concat.reason ?? t("匯出元件目前無法使用")) : null) ??
    runBlockedReason ??
    (busy !== null ? t("正在送出匯出") : null) ??
    exportOptionIssues(options, component?.settings.parameters_schema)[0] ??
    null;
  if (!audioOnly) {
    return <p role="status" className="text-data text-fg-secondary">{t("目前的匯出元件不支援只混音訊；請更新 Node 後再試，或在匯出時一併聽成品。")}</p>;
  }
  return (
    <div className="grid gap-4">
      {/* Choice segments, not native menus (a dialog keeps one look); the hints are the tooltips */}
      <div className="grid gap-3">
        <div className="grid gap-1 text-data text-fg-secondary">
          <span id={loudnessId}>{t("響度目標")}</span>
          <Segmented name={loudnessId} label={t("響度目標")} value={loudnessKey} onChange={setLoudnessKey}
            options={LOUDNESS_TARGETS.map((item) => ({ value: String(item.lufs), label: item.label, title: item.hint }))} />
        </div>
        <div className="grid gap-1 text-data text-fg-secondary">
          <span id={bitrateId}>{t("AAC 音質")}</span>
          <Segmented name={bitrateId} label={t("AAC 音質")} value={audioKey} onChange={setAudioKey}
            options={AUDIO_BITRATES.map((bps) => ({ value: String(bps), label: formatBitrate(bps) }))} />
        </div>
      </div>
      {audition.gaps.length > 0 ? (
        <p role="status" className="text-data text-fg-secondary">
          {t("{count} 個還沒渲染的鏡頭在試聽裡是靜音：{names}", { count: audition.gaps.length, names: formatList(audition.gaps) })}
        </p>
      ) : null}
      <AudioMixAudition expected={audition.body} blocked={blocked} projectId={project.project_id} />
    </div>
  );
}

export function MixAuditionDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" icon={<Headphones aria-hidden />} title={t("把整個序列的聲音混成一個音檔試聽，不必匯出影片")}>
          {t("最終混音試聽")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl" onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("最終混音試聽")}</DialogTitle>
          <DialogDescription>{t("用匯出時的混音方式，把所有音軌混成一個音檔來聽；響度與峰值量自成品。")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {open ? <Suspense fallback={<p role="status" className="text-data text-fg-secondary">{t("正在準備…")}</p>}><Body /></Suspense> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
