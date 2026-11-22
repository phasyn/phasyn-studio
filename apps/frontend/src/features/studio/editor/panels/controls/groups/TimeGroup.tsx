// The Time and the Fade group. Time: the clip's speed, the frames its first and last frame are held and, for a
// picture, its frame step (limited animation). Fade: the picture's fade from and to black, in frames, as the document
// keeps them (an adjustment layer's fades ease its effect in and out instead). A change of timing re-times the clip (and
// its linked sound) as one edit; when the document cannot keep the clip's keyframes on whole frames the reason shows
// under the row.
import { useRef } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { FADE_MAX_FRAMES, FRAME_STEP_LABELS, FRAME_STEPS, HOLD_MAX_FRAMES, SPEED_MAX, SPEED_MIN, type Effects, type Fade } from "../../../../model/clipEffects";
import { processedDuration } from "../../../model";
import { usePersistentFlag } from "@/lib/usePersistentSize";
import { NumberField, SelectField, SwitchField, type ChoiceOption } from "../fields";
import { Group } from "../Group";
import { useFocusRequest } from "../intents";
import { withFade } from "../fades";
import { useClipPanel } from "../panelContext";
import { FRAMES_SUFFIX } from "../properties";
import { Row } from "../rows";

const STEP_OPTIONS: readonly ChoiceOption<string>[] = FRAME_STEPS.map((step) => ({ value: String(step), label: FRAME_STEP_LABELS[step] }));

const HINTS = {
  speed: t("100 % 是原速；聲音變速不變調"),
  holdStart: t("第一個影格停住的影格數；停格期間沒有聲音"),
  holdEnd: t("最後一個影格停住的影格數；停格期間沒有聲音"),
  keepLength: t("開啟時，停格吃掉片段自己的影格，片段長度不變、後面的片段不動（打擊時的停頓）；關閉時片段會變長"),
  step: t("有限動畫：每張畫停留的影格數；聲音不受影響"),
  fadeIn: t("畫面從黑場淡入的影格數"),
  fadeOut: t("畫面淡出到黑場的影格數"),
  adjustIn: t("調整效果從無漸漸加強的影格數；畫面不會變黑"),
  adjustOut: t("調整效果漸漸消失的影格數；畫面不會變黑"),
} as const;

export interface TimeGroupProps {
  clip: TimelineClip;
  /** A clip on an audio track: sound has no frame step. */
  sound: boolean;
  /** The id of a request to bring the speed forward; null when there is none. */
  focusSpeed: number | null;
}

export function TimeGroup({ clip, sound, focusSpeed }: TimeGroupProps) {
  const panel = useClipPanel();
  const speedRef = useRef<HTMLInputElement>(null);
  useFocusRequest(speedRef, focusSpeed);
  const effects = clip.effects ?? {};
  const hold = effects.hold ?? {};
  const step = effects.frame_step ?? 1;
  const changed = (effects.speed_percent ?? 100) !== 100 || (hold.start ?? 0) > 0 || (hold.end ?? 0) > 0 || step !== 1;
  const change = (patch: Partial<Effects>): TimelineClip => ({ ...clip, effects: { ...effects, ...patch } });
  const [keepLength, setKeepLength] = usePersistentFlag("hold-keeps-length", true);
  const holdAt = (edge: "start" | "end", frames: number) =>
    keepLength ? panel.fixedLengthTiming({ edge, frames }) : panel.apply(change({ hold: { ...hold, [edge]: frames } }));
  const reset = () => {
    if (keepLength) {
      const result = panel.fixedLengthTiming({ reset: true });
      if (typeof result === "string") panel.warn(result);
      return;
    }
    const { speed_percent: _speed, hold: _hold, frame_step: _step, ...rest } = effects;
    panel.perform({ ...clip, effects: rest });
  };
  return (
    <Group id="time" title={t("時間")} changed={changed} onReset={reset}>
      <Row label={t("速度")} hint={HINTS.speed}>
        <NumberField
          label={t("速度")}
          value={effects.speed_percent ?? 100}
          min={SPEED_MIN}
          max={SPEED_MAX}
          suffix="%"
          hint={HINTS.speed}
          inputRef={speedRef}
          onCommit={(speed_percent) => panel.apply(change({ speed_percent }))}
        />
      </Row>
      <Row label={t("開頭停格")} hint={HINTS.holdStart}>
        <NumberField
          label={t("開頭停格")}
          value={hold.start ?? 0}
          min={0}
          max={HOLD_MAX_FRAMES}
          suffix={FRAMES_SUFFIX}
          hint={HINTS.holdStart}
          onCommit={(start) => holdAt("start", start)}
        />
      </Row>
      <Row label={t("結尾停格")} hint={HINTS.holdEnd}>
        <NumberField
          label={t("結尾停格")}
          value={hold.end ?? 0}
          min={0}
          max={HOLD_MAX_FRAMES}
          suffix={FRAMES_SUFFIX}
          hint={HINTS.holdEnd}
          onCommit={(end) => holdAt("end", end)}
        />
      </Row>
      <Row label={t("停格不改長度")} hint={HINTS.keepLength}>
        <SwitchField label={t("停格時保持片段長度")} checked={keepLength} hint={HINTS.keepLength} onChange={setKeepLength} />
      </Row>
      {sound ? null : (
        <Row label={t("拍數")} hint={HINTS.step}>
          <SelectField
            label={t("拍數")}
            value={String(step)}
            options={STEP_OPTIONS}
            hint={HINTS.step}
            onChange={(value) => void panel.perform(change({ frame_step: Number(value) }))}
            className="max-w-56 flex-1"
          />
        </Row>
      )}
    </Group>
  );
}

export interface FadeGroupProps {
  clip: TimelineClip;
  /** An adjustment layer: its fades ease its effect in and out over the picture below (never to black). */
  adjustment?: boolean;
}

export function FadeGroup({ clip, adjustment = false }: FadeGroupProps) {
  const panel = useClipPanel();
  const hintIn = adjustment ? HINTS.adjustIn : HINTS.fadeIn;
  const hintOut = adjustment ? HINTS.adjustOut : HINTS.fadeOut;
  const effects = clip.effects ?? {};
  const fade = effects.fade ?? {};
  const duration = processedDuration(clip);
  const fadeIn = fade.video_in ?? 0;
  const fadeOut = fade.video_out ?? 0;
  const change = (patch: Fade): TimelineClip => ({ ...clip, effects: withFade(effects, patch) });
  const reset = () => { panel.perform({ ...clip, effects: withFade(effects, { video_in: 0, video_out: 0 }) }); };
  return (
    <Group id="fade" title={t("淡化")} changed={fadeIn > 0 || fadeOut > 0} onReset={reset}>
      <Row label={t("淡入")} hint={hintIn}>
        <NumberField
          label={t("影像淡入")}
          value={fadeIn}
          min={0}
          max={Math.max(0, Math.min(FADE_MAX_FRAMES, duration - fadeOut))}
          suffix={FRAMES_SUFFIX}
          hint={hintIn}
          onCommit={(video_in) => panel.apply(change({ video_in }))}
        />
      </Row>
      <Row label={t("淡出")} hint={hintOut}>
        <NumberField
          label={t("影像淡出")}
          value={fadeOut}
          min={0}
          // The last frame of a fade out is black (an adjustment's has no effect left), so it never takes the whole clip
          max={Math.max(0, Math.min(FADE_MAX_FRAMES, duration - Math.max(1, fadeIn)))}
          suffix={FRAMES_SUFFIX}
          hint={hintOut}
          onCommit={(video_out) => panel.apply(change({ video_out }))}
        />
      </Row>
    </Group>
  );
}
