// The Clip group: the clip's name, where it starts on the sequence, the source frames it shows (In and Out, typed as
// frame numbers and applied as a plain, a ripple or a rolling edit), its length and a slip by a number of frames.
// Every edit is a command of the timeline: move, trim, roll, slip.
import { useRef } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { MAX_NAME_CHARS, MAX_SOURCE_FRAMES } from "@/api/generated/timelineLimits";
import { t } from "@/i18n";
import { usePersistentChoice } from "@/lib/usePersistentSize";
import { formatTimecode } from "../../../../model/frames";
import type { EditCommand } from "../../../commands";
import { useEditor } from "../../../editorContext";
import { clipDuration, MAX_TIMELINE_FRAMES } from "../../../model";
import { applyClip, runEdit } from "../clipEdits";
import { sourceEdge, TRIM_MODES, trimEdit, type TrimMode } from "../clipTiming";
import type { ClipKindId } from "../controlsContext";
import { NumberField, Segmented, TextField, type ChoiceOption } from "../fields";
import { Group } from "../Group";
import { useFocusRequest } from "../intents";
import { FRAMES_SUFFIX } from "../properties";
import { Row } from "../rows";

const TRIM_OPTIONS: readonly ChoiceOption<TrimMode>[] = [
  { value: "normal", label: t("一般"), title: t("一般修剪：只改這個片段，旁邊留下空隙") },
  { value: "ripple", label: t("波紋"), title: t("波紋編輯：後面的片段跟著移動，不留空隙") },
  { value: "roll", label: t("滾動"), title: t("滾動編輯：相鄰片段的編輯點一起移動，總長度不變") },
];

const HINTS = {
  start: t("片段在序列上開始的影格"),
  sourceIn: t("片段開始的素材影格"),
  sourceOut: t("片段結束的素材影格（不含這個影格）"),
  trim: t("輸入入點或出點時的修剪方式"),
  slip: t("輸入影格數後按 Enter：素材在片段內前後移動，片段的位置和長度不變"),
} as const;

export interface ClipGroupProps {
  clip: TimelineClip;
  kind: ClipKindId;
  /** The id of a request to bring the name forward; null when there is none. */
  focusName: number | null;
}

export function ClipGroup({ clip, kind, focusName }: ClipGroupProps) {
  const editor = useEditor();
  const nameRef = useRef<HTMLInputElement>(null);
  useFocusRequest(nameRef, focusName);
  const [mode, setMode] = usePersistentChoice<TrimMode>("studio.nle.controls.trim", "normal", TRIM_MODES);
  const { linked } = editor;
  const duration = clipDuration(clip);
  const sourceFrames = editor.sourceOf(clip)?.duration_frames ?? MAX_SOURCE_FRAMES;
  const sourceIn = sourceEdge(clip, "in");
  const sourceOut = sourceEdge(clip, "out");
  const run = (command: EditCommand) => runEdit(editor, command);
  const trim = (edge: "in" | "out", frame: number) => {
    const command = trimEdit(editor.timeline, clip, edge, mode, frame, linked);
    return command.ok ? run(command.value) : command.error;
  };
  return (
    <Group id="clip" title={t("片段")}>
      <Row label={t("名稱")}>
        <TextField
          label={t("片段名稱")}
          value={clip.name}
          inputRef={nameRef}
          validate={(text) => (!text.trim() || text.length > MAX_NAME_CHARS ? t("片段名稱需為 1–200 個字元") : null)}
          onCommit={(text) => applyClip(editor, { ...clip, name: text.trim() })}
        />
      </Row>
      <Row label={t("序列起點")} hint={HINTS.start}>
        <NumberField
          label={t("序列起點")}
          value={clip.start_frame}
          min={0}
          max={MAX_TIMELINE_FRAMES - duration}
          suffix={FRAMES_SUFFIX}
          hint={HINTS.start}
          onCommit={(startFrame) => run({ type: "move", clipId: clip.clip_id, trackId: clip.track_id, startFrame, linked })}
        />
      </Row>
      <Row label={t("入點")} hint={HINTS.sourceIn}>
        <NumberField
          label={t("入點")}
          value={sourceIn.frame}
          min={0}
          max={Math.ceil(sourceOut.frame) - 1}
          suffix={FRAMES_SUFFIX}
          hint={HINTS.sourceIn}
          disabledReason={sourceIn.reason}
          onCommit={(frame) => trim("in", frame)}
        />
      </Row>
      <Row label={t("出點")} hint={HINTS.sourceOut}>
        <NumberField
          label={t("出點")}
          value={sourceOut.frame}
          min={Math.floor(sourceIn.frame) + 1}
          max={sourceFrames}
          suffix={FRAMES_SUFFIX}
          hint={HINTS.sourceOut}
          disabledReason={sourceOut.reason}
          onCommit={(frame) => trim("out", frame)}
        />
      </Row>
      <Row label={t("長度")}>
        <span className="machine text-data text-fg-secondary" title={t("{frames} 影格", { frames: duration })}>
          {formatTimecode(duration, editor.fps)}
        </span>
      </Row>
      <Row label={t("修剪")} hint={HINTS.trim}>
        <Segmented label={t("入點與出點的修剪方式")} value={mode} options={TRIM_OPTIONS} onChange={setMode} />
      </Row>
      {/* A text or an adjustment layer has no media to slip */}
      {kind === "text" || kind === "adjustment" ? null : (
        <Row label={t("外滑")} hint={HINTS.slip}>
          <NumberField
            label={t("外滑的影格數")}
            value={0}
            min={-sourceFrames}
            max={sourceFrames}
            suffix={FRAMES_SUFFIX}
            hint={HINTS.slip}
            onCommit={(delta) => run({ type: "slip", clipId: clip.clip_id, delta, linked })}
          />
        </Row>
      )}
    </Group>
  );
}
