// The rows of a clip's basic colour correction: brightness, contrast, saturation and the negative. The Color group
// of Effect Controls shows them as fields; the Color dock adds a slider to every value.
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { ClipEdits } from "./clipEdits";
import { COLOR_VALUES, colorValue, withColor, withColorValue } from "./clipLooks";
import { SwitchField } from "./fields";
import { Row } from "./rows";
import { SliderField, UnitField } from "./UnitField";

export interface ColorRowsProps {
  clip: TimelineClip;
  edits: ClipEdits;
  /** A slider beside every value (the dock has the room). */
  sliders?: boolean;
}

export function ColorRows({ clip, edits, sliders = false }: ColorRowsProps) {
  return (
    <>
      {COLOR_VALUES.map(({ key, label, hint, unit, min, max }) => {
        const value = colorValue(clip, key);
        const field = { label, unit, value, min, max };
        return (
          <Row key={key} label={label} hint={hint}>
            {sliders ? <SliderField {...field} onCommit={(next) => void edits.perform(withColorValue(clip, key, next))} /> : null}
            <UnitField {...field} hint={hint} onCommit={(next) => edits.apply(withColorValue(clip, key, next))} />
          </Row>
        );
      })}
      <Row label={t("負片")} hint={t("整個片段的色彩反相")}>
        <SwitchField
          label={t("負片")}
          checked={clip.effects?.color?.invert ?? false}
          hint={t("整個片段的色彩反相")}
          onChange={(invert) => void edits.perform(withColor(clip, { invert }))}
        />
      </Row>
    </>
  );
}
