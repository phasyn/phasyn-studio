// The Motion and the Opacity group of a clip on a video track. Motion: position X / Y in pixels of the output frame,
// scale and rotation; choosing its header marks the group and shows the transform box of the Program monitor, and the
// header carries the switch for that box. Opacity: the opacity and the blend mode.
import { Move } from "lucide-react";
import { useContext } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { BLEND_NAMES } from "../../../compositing";
import { useEditor } from "../../../editorContext";
import { GroupsContext } from "../controlsContext";
import { SelectField, type ChoiceOption } from "../fields";
import { Group } from "../Group";
import { useClipPanel } from "../panelContext";
import type { ClipProperty } from "../properties";
import { PropertyRow } from "../PropertyRow";
import { IconButton, Row } from "../rows";

type BlendMode = NonNullable<TimelineClip["blend_mode"]>;

const MOTION_KEYS = ["x", "y", "scale", "rotation"] as const;
const BLEND_MODES: readonly BlendMode[] = ["normal", "multiply", "screen", "add"];
const BLEND_OPTIONS: readonly ChoiceOption<BlendMode>[] = BLEND_MODES.map((value) => ({ value, label: BLEND_NAMES[value] }));

export interface VideoGroupProps {
  clip: TimelineClip;
  /** The clip's animatable properties by channel key. */
  properties: ReadonlyMap<string, ClipProperty>;
}

export function MotionGroup({ clip, properties }: VideoGroupProps) {
  const { ui } = useEditor();
  const panel = useClipPanel();
  const groups = useContext(GroupsContext);
  const { motion } = clip;
  const moved = motion.x !== 0 || motion.y !== 0 || motion.scale !== 1 || motion.rotation !== 0;
  const keys = MOTION_KEYS.reduce((count, key) => count + (motion.keyframes[key]?.length ?? 0), 0);
  const changed = moved || keys > 0;
  const reset = () => {
    const { x: _x, y: _y, scale: _scale, rotation: _rotation, ...keyframes } = motion.keyframes;
    panel.perform({ ...clip, motion: { ...motion, x: 0, y: 0, scale: 1, rotation: 0, keyframes } });
  };
  // The first press on the title chooses the group (the transform box shows); once chosen, the title opens and closes it
  const choose = () => {
    if (ui.transform) return false;
    ui.setTransform(true);
    groups.setOpen("motion", true);
    return true;
  };
  return (
    <Group
      id="motion"
      title={t("運動")}
      changed={changed}
      onReset={reset}
      resetKeys={keys}
      selected={ui.transform}
      onChoose={choose}
      actions={
        <IconButton
          label={t("變形控制框")}
          title={ui.transform ? t("節目監看器正在顯示變形控制框；按一下關閉") : t("在節目監看器上顯示變形控制框")}
          pressed={ui.transform}
          onClick={() => ui.setTransform(!ui.transform)}
        >
          <Move aria-hidden />
        </IconButton>
      }
    >
      {MOTION_KEYS.map((key) => {
        const property = properties.get(key);
        return property ? <PropertyRow key={key} property={property} owner={clip} /> : null;
      })}
    </Group>
  );
}

export function OpacityGroup({ clip, properties }: VideoGroupProps) {
  const panel = useClipPanel();
  const { motion } = clip;
  const opacity = properties.get("opacity");
  const blend = clip.blend_mode ?? "normal";
  const keys = motion.keyframes.opacity?.length ?? 0;
  const changed = motion.opacity !== 1 || keys > 0 || blend !== "normal";
  const reset = () => {
    const { opacity: _opacity, ...keyframes } = motion.keyframes;
    const { blend_mode: _blend, ...rest } = clip;
    panel.perform({ ...rest, motion: { ...motion, opacity: 1, keyframes } });
  };
  return (
    <Group id="opacity" title={t("不透明度")} changed={changed} onReset={reset} resetKeys={keys}>
      {opacity ? <PropertyRow property={opacity} owner={clip} /> : null}
      <Row label={t("混合模式")}>
        <SelectField
          label={t("混合模式")}
          value={blend}
          options={BLEND_OPTIONS}
          onChange={(blend_mode) => panel.perform({ ...clip, blend_mode })}
          className="max-w-56 flex-1"
        />
      </Row>
    </Group>
  );
}
