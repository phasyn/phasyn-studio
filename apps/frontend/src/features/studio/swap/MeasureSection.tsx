// The swap panel's measurement: when finished segments ran a request their DiT does not declare yet (no limits.swap,
// more characters, longer segments, larger character images), offer to record it as the DiT's swap limits, so the next
// swap's wizard uses measured limits instead of the conservative default (measure.ts). After a recording the section
// says what was recorded until the panel closes.
// Look (Phasyn): a quiet section like the export one; the button is the shared pressable; the result line fades in.
import { Gauge } from "lucide-react";
import { useMemo, useState } from "react";
import { usePatchComponentMeta } from "@/api/components";
import { ActionButton } from "@/components/common/ActionButton";
import { useChangeFade } from "@/components/ui/motion";
import { useStudio } from "../studioContext";
import { errorText } from "./errors";
import { Section } from "./fields";
import { framesByCharactersText } from "./limits";
import { measurementIsNew, recordedLimits, swapMeasurements, type SwapMeasurement } from "./measure";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const keyOf = (measurement: SwapMeasurement) => `${measurement.nodeId}/${measurement.componentId}`;

function MeasureRow({ measurement, recorded, onRecorded }: { measurement: SwapMeasurement; recorded: string | undefined; onRecorded: (text: string) => void }) {
  const patch = usePatchComponentMeta(measurement.nodeId, measurement.componentId);
  const [failure, setFailure] = useState<string | null>(null);
  const message = recorded ?? failure ?? "";
  const messageRef = useChangeFade<HTMLParagraphElement>(message);
  const record = () => {
    setFailure(null);
    patch.mutate(
      { limits: recordedLimits(measurement, localDate()) },
      {
        onSuccess: () => onRecorded(t("已記錄成「{dit}」的換角上限；換角精靈之後用量測過的值，元件修改頁可以再調整。", { dit: measurement.label })),
        onError: (error) => setFailure(t("沒有記錄：{reason}", { reason: errorText(error) })),
      },
    );
  };
  return (
    <div className="grid gap-2 rounded-lg border border-line-subtle bg-sunken/60 px-3 py-2.5">
      {recorded ? null : (
        <>
          <p className="text-caption text-fg-secondary [overflow-wrap:anywhere]">
            {t("這次跑完的設定還沒記在「{dit}」的換角上限：{frames}・畫面 {formats}（{takes} 段）。記錄後，換角精靈就用這些量測過的值，不再用保守的預設上限。", {
              dit: measurement.label,
              frames: framesByCharactersText(measurement.capacity),
              formats: formatList(measurement.formats, { type: "unit" }),
              takes: measurement.takes,
            })}
          </p>
          <ActionButton size="sm" variant="secondary" icon={<Gauge aria-hidden />} pending={patch.isPending} className="justify-self-start" onClick={record}>
            {t("記錄成換角上限")}
          </ActionButton>
        </>
      )}
      {message ? (
        <p ref={messageRef} role="status" className={recorded ? "text-caption text-success" : "text-caption text-danger"}>
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** The DiTs the project's finished swap segments ran on, each with what it proved (only the ones with something new). */
export function MeasureSection() {
  const { project, engine } = useStudio();
  const measurements = useMemo(() => swapMeasurements(project, engine.routes), [project, engine.routes]);
  // What was recorded while the panel is open (key → message): the row stays to say so
  const [recorded, setRecorded] = useState<Readonly<Record<string, string>>>({});
  const shown = measurements.filter((measurement) => measurementIsNew(measurement) || recorded[keyOf(measurement)] !== undefined);
  if (shown.length === 0) return null;
  return (
    <Section title={t("量測換角上限")} icon={<Gauge />}>
      {shown.map((measurement) => (
        <MeasureRow
          key={keyOf(measurement)}
          measurement={measurement}
          recorded={recorded[keyOf(measurement)]}
          onRecorded={(text) => setRecorded((current) => ({ ...current, [keyOf(measurement)]: text }))}
        />
      ))}
    </Section>
  );
}
