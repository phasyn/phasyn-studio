// Effect Controls: the properties of the selected clip, or of the selected transition. Nothing selected shows the
// empty state. A command that asks for a field (rename, speed) is served here, once.
import { EmptyState } from "@/components/common/EmptyState";
import { t } from "@/i18n";
import { activeTransition } from "../../model/clipEffects";
import { useEditor } from "../editorContext";
import { ClipControls } from "./controls/ClipControls";
import { useFieldRequest } from "./controls/intents";
import { TransitionControls } from "./controls/TransitionControls";

export function EffectControls() {
  const editor = useEditor();
  const { timeline, selectedClip, selectedTransition } = editor;
  const request = useFieldRequest(editor);
  // A transition is selected by the id of its outgoing clip; one that was removed since (an undo) is no selection
  const outgoing = selectedTransition ? timeline.clips.find((clip) => clip.clip_id === selectedTransition) : undefined;
  const transition = outgoing ? activeTransition(outgoing.effects) : null;
  if (outgoing && transition) return <TransitionControls key={outgoing.clip_id} clip={outgoing} transition={transition} />;
  if (!selectedClip) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
        <EmptyState
          size="compact"
          illustration="timeline"
          title={t("選取時間軸上的片段")}
          description={t("片段的運動、不透明度、時間、效果與音訊都在這裡調整。")}
        />
      </div>
    );
  }
  return <ClipControls key={selectedClip.clip_id} clip={selectedClip} request={request} />;
}
