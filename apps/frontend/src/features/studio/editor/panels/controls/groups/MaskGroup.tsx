// The Mask group: the shape of the clip's mask (none, rectangle, ellipse), its rectangle as percentages of the frame,
// its feather and whether it is inverted. The rectangle and the feather can be animated. While a value is not
// animated its field keeps the rectangle inside the frame, as the document requires.
import type { TimelineClip } from "@/api/generated/contracts";
import { MASK_BOUNDS } from "@/api/generated/timelineLimits";
import { t } from "@/i18n";
import { defaultMask, type ClipMask } from "../../../compositing";
import { SelectField, SwitchField, type ChoiceOption } from "../fields";
import { Group } from "../Group";
import { useClipPanel } from "../panelContext";
import { MASK_PARAMETER_NAMES, maskKey, type ClipProperty } from "../properties";
import { PropertyRow } from "../PropertyRow";
import { Row } from "../rows";

type Shape = ClipMask["kind"] | "none";
type Ranges = Partial<Record<string, { min: number; max: number }>>;

const SHAPES: readonly ChoiceOption<Shape>[] = [
  { value: "none", label: t("無遮罩") },
  { value: "rectangle", label: t("矩形") },
  { value: "ellipse", label: t("橢圓") },
];

/** The bounds of the fixed values of a mask, by parameter: its rectangle stays inside the frame. */
function fixedRanges(mask: ClipMask | undefined): Ranges {
  if (!mask) return {};
  return {
    x: { min: MASK_BOUNDS.x[0], max: 1 - mask.width },
    y: { min: MASK_BOUNDS.y[0], max: 1 - mask.height },
    width: { min: MASK_BOUNDS.width[0], max: 1 - mask.x },
    height: { min: MASK_BOUNDS.height[0], max: 1 - mask.y },
  };
}

export interface MaskGroupProps {
  clip: TimelineClip;
  /** The clip's animatable properties by channel key. */
  properties: ReadonlyMap<string, ClipProperty>;
}

export function MaskGroup({ clip, properties }: MaskGroupProps) {
  const panel = useClipPanel();
  const mask = clip.mask;
  const ranges = fixedRanges(mask);
  const setShape = (shape: Shape) => {
    if (shape === "none") {
      const { mask: _mask, ...rest } = clip;
      panel.perform(rest);
    } else panel.perform({ ...clip, mask: mask ? { ...mask, kind: shape } : defaultMask(shape) });
  };
  // Putting a mask back keeps its shape and returns its rectangle, feather and animation to the shape's defaults
  const reset = mask ? () => { panel.perform({ ...clip, mask: defaultMask(mask.kind) }); } : undefined;
  const keys = Object.values(mask?.keyframes ?? {}).reduce((count, list) => count + list.length, 0);
  return (
    <Group id="mask" title={t("遮罩")} changed={mask !== undefined} {...(reset === undefined ? {} : { onReset: reset })} resetKeys={keys}>
      <Row label={t("形狀")}>
        <SelectField label={t("遮罩形狀")} value={mask?.kind ?? "none"} options={SHAPES} onChange={setShape} className="max-w-56 flex-1" />
      </Row>
      {mask ? (
        <>
          {MASK_PARAMETER_NAMES.map((param) => {
            const property = properties.get(maskKey(param));
            return property ? <PropertyRow key={param} property={property} owner={clip} {...(ranges[param] === undefined ? {} : { fixedRange: ranges[param] })} /> : null;
          })}
          <Row label={t("反轉")} hint={t("遮罩裡面變透明，外面保留")}>
            <SwitchField
              label={t("反轉遮罩")}
              checked={mask.invert}
              hint={t("遮罩裡面變透明，外面保留")}
              onChange={(invert) => void panel.perform({ ...clip, mask: { ...mask, invert } })}
            />
          </Row>
        </>
      ) : null}
    </Group>
  );
}
