import { useId } from "react";
import { Select } from "@/components/ui/controls";
import { t } from "@/i18n";
import { isListed } from "@/lib/json";
import { DECODE_LABELS, LIMITS, PREVIEW_LABELS, SIGMA_LABELS } from "../model/constants";
import { imageControls, supportsImageValue, type DeclaredImage } from "../model/declaredImage";
import type { ImageRoute } from "../model/routes";
import type { StudioImageShot } from "../types";
import { Button } from "@/components/ui/button";
import { NumberField, Row } from "./fields";

const schedules = ["native", "karras", "exponential"] as const;
const decoders = ["full", "tiled"] as const;
const previews = ["off", "vae_thumbnail", "linear_fit"] as const;

interface Props {
  route: ImageRoute;
  declaration: DeclaredImage;
  shot: StudioImageShot;
  update: (patch: Partial<StudioImageShot>) => void;
}

interface ChoiceProps<K extends string> {
  id: string;
  label: string;
  value: K;
  choices: readonly K[];
  labels: Record<K, string>;
  accepts: (value: K) => boolean;
  change: (value: K) => void;
}

function Choice<K extends string>({ id, label, value, choices, labels, accepts, change }: ChoiceProps<K>) {
  return <Row label={label} htmlFor={id}>
    <Select id={id} compact value={value} onChange={(event) => {
      const picked = event.target.value;
      if (isListed(picked, choices) && accepts(picked)) change(picked);
    }}>
      {choices.filter((choice) => choice === value || accepts(choice)).map((choice) =>
        <option key={choice} value={choice} disabled={!accepts(choice)}>{labels[choice]}</option>
      )}
    </Select>
  </Row>;
}

export function DeclaredSampling({ route, declaration, shot, update }: Props) {
  const id = useId();
  const controls = imageControls(declaration);
  const { guidance, steps, flowShift, previewEvery } = LIMITS;
  const fixedControls = ["width", "height", "steps", "guidance"] as const;
  const changedFixed = fixedControls.some((key) => {
    const value = declaration.fixed[key];
    return value !== undefined && shot[key] !== value;
  });
  return <div className="grid gap-3 p-3">
    {changedFixed ? <Button size="sm" onClick={() => { update({ ...declaration.fixed }); }}>{t("使用此路由的固定配方")}</Button> : null}
    {controls.has("steps") ? <Row label={t("採樣步數")} htmlFor={id + "-steps"}>
      <NumberField id={id + "-steps"} integer disabled={declaration.fixed.steps !== undefined} min={steps.min} max={steps.max} value={shot.steps}
        onCommit={(value) => { if (value !== null) update({ steps: value }); }} />
    </Row> : null}
    {controls.has("guidance") ? <Row label="Guidance" htmlFor={id + "-guidance"}>
      <NumberField id={id + "-guidance"} disabled={declaration.fixed.guidance !== undefined} min={guidance.min} max={guidance.max} value={shot.guidance}
        onCommit={(value) => { if (value !== null) update({ guidance: value }); }} />
    </Row> : null}
    {controls.has("sigma_schedule") ? <Choice id={id + "-sigma"} label={t("Sigma 排程")} value={shot.sigma_schedule}
      choices={schedules} labels={SIGMA_LABELS} accepts={(value) => supportsImageValue(route, "sigma_schedule", value)}
      change={(value) => { update({ sigma_schedule: value }); }} /> : null}
    {controls.has("flow_shift_mu") ? <Row label="Flow shift μ" htmlFor={id + "-mu"}>
      <NumberField id={id + "-mu"} allowEmpty min={flowShift.min} max={flowShift.max} value={shot.flow_shift_mu}
        onCommit={(value) => { update({ flow_shift_mu: value }); }} />
    </Row> : null}
    {controls.has("decode") ? <Choice id={id + "-decode"} label={t("解碼方式")} value={shot.decode}
      choices={decoders} labels={DECODE_LABELS} accepts={(value) => supportsImageValue(route, "decode", value)}
      change={(value) => { update({ decode: value }); }} /> : null}
    {controls.has("preview") ? <>
      <Choice id={id + "-preview"} label={t("預覽方式")} value={shot.preview.mode} choices={previews} labels={PREVIEW_LABELS}
        accepts={(mode) => supportsImageValue(route, "preview", { ...shot.preview, mode })}
        change={(mode) => { update({ preview: { ...shot.preview, mode } }); }} />
      <Row label={t("每 N 步")} htmlFor={id + "-every"}>
        <NumberField id={id + "-every"} integer disabled={shot.preview.mode === "off"}
          min={previewEvery.min} max={previewEvery.max} value={shot.preview.every}
          onCommit={(value) => { if (value !== null) update({ preview: { ...shot.preview, every: value } }); }} />
      </Row>
    </> : null}
    {controls.size === 3 ? <p className="text-caption text-fg-tertiary">{t("此路由的採樣由元件組合設定。")}</p> : null}
  </div>;
}
