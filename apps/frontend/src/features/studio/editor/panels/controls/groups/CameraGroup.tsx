// The Camera move and the Impact frames group. Camera move: a push in on the centre of the picture and a shake at
// the start of the clip. Impact frames: the first frames of the clip replaced by an impact picture (a black and white
// negative, white or black), as action animation puts on a hit.
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import {
  IMPACT_MAX_FRAMES,
  IMPACT_STYLE_LABELS,
  IMPACT_STYLES,
  SHAKE_MAX_FRAMES,
  SHAKE_MAX_PX,
  ZOOM_MAX,
  ZOOM_MIN,
  type Camera,
  type ImpactStyle,
} from "../../../../model/clipEffects";
import { processedDuration } from "../../../model";
import { NumberField, SelectField, SwitchField, type ChoiceOption } from "../fields";
import { Group } from "../Group";
import { useClipPanel } from "../panelContext";
import { FRAMES_SUFFIX } from "../properties";
import { Row } from "../rows";

const STYLE_OPTIONS: readonly ChoiceOption<ImpactStyle>[] = IMPACT_STYLES.map((style) => ({ value: style, label: IMPACT_STYLE_LABELS[style] }));
/** Impact frames a clip gets when they are switched on (a hit usually takes one to three). */
const IMPACT_DEFAULT_FRAMES = 2;

const HINTS = {
  zoom: t("以畫面中心放大；100 % 是原本的大小"),
  shake: t("片段開頭的震動，幅度在震動長度內衰減到 0"),
  shakeFrames: t("從片段的第一個影格開始震動的影格數"),
  impact: t("把片段開頭的幾個影格換成衝擊畫面，片段長度不變"),
  impactFrames: t("換成衝擊畫面的影格數"),
} as const;

export function CameraGroup({ clip }: { clip: TimelineClip }) {
  const panel = useClipPanel();
  const effects = clip.effects ?? {};
  const camera = effects.camera ?? {};
  const zoom = camera.zoom_percent ?? ZOOM_MIN;
  const shake = camera.shake_px ?? 0;
  const shakeFrames = camera.shake_frames ?? 0;
  const change = (patch: Camera): TimelineClip => ({ ...clip, effects: { ...effects, camera: { ...camera, ...patch } } });
  const reset = () => {
    const { camera: _camera, ...rest } = effects;
    panel.perform({ ...clip, effects: rest });
  };
  return (
    <Group id="camera" title={t("鏡頭運動")} changed={zoom !== ZOOM_MIN || shake > 0 || shakeFrames > 0} onReset={reset}>
      <Row label={t("推近")} hint={HINTS.zoom}>
        <NumberField
          label={t("推近")}
          value={zoom}
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          suffix="%"
          hint={HINTS.zoom}
          onCommit={(zoom_percent) => panel.apply(change({ zoom_percent }))}
        />
      </Row>
      <Row label={t("震動幅度")} hint={HINTS.shake}>
        <NumberField
          label={t("震動幅度")}
          value={shake}
          min={0}
          max={SHAKE_MAX_PX}
          suffix="px"
          hint={HINTS.shake}
          onCommit={(shake_px) => panel.apply(change({ shake_px }))}
        />
      </Row>
      <Row label={t("震動長度")} hint={HINTS.shakeFrames}>
        <NumberField
          label={t("震動長度")}
          value={shakeFrames}
          min={0}
          max={Math.min(SHAKE_MAX_FRAMES, processedDuration(clip))}
          suffix={FRAMES_SUFFIX}
          hint={HINTS.shakeFrames}
          onCommit={(shake_frames) => panel.apply(change({ shake_frames }))}
        />
      </Row>
    </Group>
  );
}

export function ImpactGroup({ clip }: { clip: TimelineClip }) {
  const panel = useClipPanel();
  const effects = clip.effects ?? {};
  const impact = effects.impact;
  const longest = Math.min(IMPACT_MAX_FRAMES, processedDuration(clip));
  const toggle = (on: boolean) => {
    const { impact: _impact, ...rest } = effects;
    panel.perform({ ...clip, effects: on ? { ...rest, impact: { frames: Math.min(IMPACT_DEFAULT_FRAMES, longest), style: "negative" } } : rest });
  };
  return (
    <Group id="impact" title={t("衝擊格")} changed={impact !== undefined}>
      <Row label={t("啟用")} hint={HINTS.impact}>
        <SwitchField label={t("啟用衝擊格")} checked={impact !== undefined} hint={HINTS.impact} onChange={toggle} />
      </Row>
      {impact ? (
        <>
          <Row label={t("影格數")} hint={HINTS.impactFrames}>
            <NumberField
              label={t("衝擊格的影格數")}
              value={impact.frames}
              min={1}
              max={longest}
              suffix={FRAMES_SUFFIX}
              hint={HINTS.impactFrames}
              onCommit={(frames) => panel.apply({ ...clip, effects: { ...effects, impact: { ...impact, frames } } })}
            />
          </Row>
          <Row label={t("樣式")}>
            <SelectField
              label={t("衝擊格的樣式")}
              value={impact.style}
              options={STYLE_OPTIONS}
              onChange={(style) => void panel.perform({ ...clip, effects: { ...effects, impact: { ...impact, style } } })}
              className="max-w-56 flex-1"
            />
          </Row>
        </>
      ) : null}
    </Group>
  );
}
