// The engine sheet's 畫質 tab: the selected shot's DiT steps and shifts, and the project's frame format. A field left
// empty uses the default (its value is the placeholder; where it comes from is in the field's help); 還原預設 empties a
// field that was set. A line under a field appears only when its value is not the default: red when the DiT's LoRA
// sampling contract refuses it (the render would be blocked), amber otherwise. The settings people change for every
// render (方式, 時長, Seed, 數量) are in the generation row under the prompt.
import { MonitorCog, RotateCcw, Timer } from "lucide-react";
import { useId, useState } from "react";
import type { ComponentDescriptor, StudioShot } from "@/api/generated/contracts";
import { HelpButton, HelpText } from "@/components/common/HelpTip";
import { Button } from "@/components/ui/button";
import { samplingConflicts, type SamplingKey } from "@/lib/ditSampling";
import { SectionTitle } from "@/features/studio-shell";
import { ditDefaults, findRoute, routeName, type ParameterDefault, type StudioRoute } from "../model/routes";
import { useStudio } from "../studioContext";
import { NumberField } from "./fields";
import { FormatSelect } from "./ProjectSettings";
import { t } from "@/i18n";

/** Where an empty field's value comes from (the field's help). */
function describeDefault(item: ParameterDefault, route: StudioRoute | null): string {
  if (item.value === null) return t("空白＝元件內建預設（元件沒有回報數值）");
  const ditStep = route?.steps.find((step) => step.step.step_id === route.ditStepId);
  if (item.source === "pipeline") return t("空白＝{value}（元件組合「{value2}」的步驟參數）", { value: item.value, value2: route ? routeName(route.label).name : "" });
  return t("空白＝{value}（{value2} 的保存設定）", { value: item.value, value2: ditStep?.step.component_id ?? "DiT" });
}

/** The line under a field that is set: why the DiT refuses it, or that it differs from the default. Null when it is the default. */
function fieldNote(key: SamplingKey, value: number | null, fallback: ParameterDefault, dit: ComponentDescriptor | null): { tone: "danger" | "warning"; text: string } | null {
  if (value === null || value === fallback.value) return null;
  const conflict = dit ? samplingConflicts({ [key]: value }, dit).find((item) => item.blocking) : undefined;
  if (conflict) return { tone: "danger", text: t("這個 DiT 的 LoRA 採樣合約只接受 {expected}：渲染會被擋下，按「還原預設」", { expected: conflict.expected }) };
  if (fallback.value === null) return { tone: "warning", text: t("元件沒有回報預設值；這個值會原樣送給 DiT") };
  return { tone: "warning", text: t("與預設 {value} 不同；加速版 DiT 改這個值可能明顯影響畫質", { value: fallback.value }) };
}

function SamplingField({
  field,
  label,
  value,
  fallback,
  route,
  dit,
  integer = false,
  min,
  max,
  onChange,
}: {
  field: SamplingKey;
  label: string;
  value: number | null;
  fallback: ParameterDefault;
  route: StudioRoute | null;
  dit: ComponentDescriptor | null;
  integer?: boolean;
  min: number;
  max: number;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  const [help, setHelp] = useState(false);
  const source = describeDefault(fallback, route);
  const helpText = t("{source}。值會原樣送給 DiT；元件不接受時渲染會被擋下。", { source });
  const note = fieldNote(field, value, fallback, dit);
  return (
    <div className="grid min-w-0 content-start gap-1">
      <div className="flex min-h-7 items-center gap-1">
        <label htmlFor={`${id}-input`} className="text-caption font-medium text-fg-secondary">
          {label}
        </label>
        <HelpButton open={help} onToggle={() => setHelp((open) => !open)} controls={`${id}-help`} label={label} text={helpText} />
        {value !== null ? (
          <Button size="sm" variant="quiet" className="ml-auto min-h-7 px-1.5 text-caption animate-fade-in" icon={<RotateCcw aria-hidden />} onClick={() => onChange(null)} title={source}>
            {t("還原預設")}
          </Button>
        ) : null}
      </div>
      <NumberField
        id={`${id}-input`}
        integer={integer}
        value={value}
        min={min}
        max={max}
        allowEmpty
        placeholder={fallback.value === null ? t("預設") : String(fallback.value)}
        describedBy={note ? `${id}-help ${id}-note` : `${id}-help`}
        onCommit={onChange}
      />
      <HelpText id={`${id}-help`} open={help}>
        {helpText}
      </HelpText>
      {note ? (
        <p id={`${id}-note`} className={note.tone === "danger" ? "text-caption text-danger animate-reveal" : "text-caption text-warning animate-reveal"}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

function FormatField() {
  const id = useId();
  const [help, setHelp] = useState(false);
  const label = t("畫面格式（專案設定）");
  const helpText = t("套用到專案中所有鏡頭，不只這個鏡頭；改格式後，已渲染的鏡頭會標示「設定已變更」，需要重新渲染。");
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex min-h-7 items-center gap-1">
        <label htmlFor={`${id}-format`} className="text-caption font-medium text-fg-secondary">
          {label}
        </label>
        <HelpButton open={help} onToggle={() => setHelp((open) => !open)} controls={`${id}-help`} label={label} text={helpText} />
      </div>
      <FormatSelect id={`${id}-format`} />
      <HelpText id={`${id}-help`} open={help}>
        {helpText}
      </HelpText>
    </div>
  );
}

export function QualitySettings({ shot }: { shot: StudioShot }) {
  const { dispatch, engine } = useStudio();
  const route = findRoute(engine.routes, shot.route);
  const defaults = ditDefaults(route);
  const dit = route?.steps.find((item) => item.step.step_id === route.ditStepId)?.slot.component ?? null;
  const update = (patch: Pick<Partial<StudioShot>, "steps" | "video_shift" | "audio_shift">) => dispatch({ type: "updateShot", shotId: shot.shot_id, patch });
  return (
    <div className="grid gap-5">
      <section className="grid gap-2.5">
        <SectionTitle icon={Timer}>{t("DiT 去噪")}</SectionTitle>
        <SamplingField field="steps" label={t("步數")} integer min={1} max={200} value={shot.steps} fallback={defaults.steps} route={route} dit={dit} onChange={(steps) => update({ steps })} />
        <div className="grid grid-cols-2 gap-3">
          <SamplingField field="video_shift" label="video shift" min={0.01} max={100} value={shot.video_shift} fallback={defaults.video_shift} route={route} dit={dit} onChange={(value) => update({ video_shift: value })} />
          <SamplingField field="audio_shift" label="audio shift" min={0.01} max={100} value={shot.audio_shift} fallback={defaults.audio_shift} route={route} dit={dit} onChange={(value) => update({ audio_shift: value })} />
        </div>
      </section>
      <section className="grid gap-1.5">
        <SectionTitle icon={MonitorCog}>{t("解析度")}</SectionTitle>
        <FormatField />
      </section>
    </div>
  );
}
