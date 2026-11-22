// The Color and the Text group of Effect Controls: the same rows the Color dock and the Text dock show, inside the
// accordion.
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { colorChanged, withoutColor } from "../clipLooks";
import { ColorRows } from "../ColorRows";
import { Group } from "../Group";
import { useClipPanel } from "../panelContext";
import { TextRows } from "../TextRows";

export function ColorGroup({ clip }: { clip: TimelineClip }) {
  const panel = useClipPanel();
  return (
    <Group id="color" title={t("調色")} changed={colorChanged(clip)} onReset={() => void panel.perform(withoutColor(clip))}>
      <ColorRows clip={clip} edits={panel} />
    </Group>
  );
}

export interface TextGroupProps {
  clip: TimelineClip;
  /** The clip is a text layer (its text is all it shows). */
  standalone: boolean;
}

export function TextGroup({ clip, standalone }: TextGroupProps) {
  const panel = useClipPanel();
  return (
    <Group id="text" title={t("文字")} changed={!standalone && clip.effects?.title !== undefined}>
      <TextRows clip={clip} standalone={standalone} edits={panel} />
    </Group>
  );
}
