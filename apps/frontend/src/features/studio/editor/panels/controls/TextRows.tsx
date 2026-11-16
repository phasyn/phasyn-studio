// The rows of a clip's text: what it says, its font, weight, size, alignment, place and colour, and for a text that
// sits on another clip the frames of that clip it shows on. A text still on its preset layout shows the preset's
// position and size; the first change of its font, colour or place gives it a layout of its own, and the preset can
// be brought back. A text layer is named on the timeline after its first line until someone renames the clip, and
// its In and Out animations follow it when it moves (their scale and rotation turn around the text). Used by the Text
// group of Effect Controls and by the Text dock.
import { Plus, TextAlignCenter, TextAlignEnd, TextAlignStart, Trash2 } from "lucide-react";
import { useContext } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { TITLE_MAX_LENGTH, type Title } from "../../../model/clipEffects";
import { exportGeometry, localId } from "../../../model/project";
import { defaultTitleStyle, type TitleStyle } from "../../../model/titleLayout";
import { useEditor } from "../../editorContext";
import { processedDuration, toClipLocalFrame, toProcessingFrame, windowBounds } from "../../model";
import { textLayerName } from "../../textLayer";
import { withTextAnimationsKept } from "../../titles/textAnimation";
import type { ClipEdits } from "./clipEdits";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  newTitle,
  TITLE_FONTS,
  TITLE_POSITIONS,
  TITLE_SIZES,
  TITLE_WEIGHTS,
  withoutTitle,
  withoutTitleStyle,
  withTitle,
} from "./clipLooks";
import { FieldLockContext } from "./controlsContext";
import { ColorField, NumberField, Segmented, SelectField, TextAreaField, type ChoiceOption } from "./fields";
import { FRAMES_SUFFIX, UNITS } from "./properties";
import { ActionRow, Row, TextButton } from "./rows";
import { UnitField } from "./UnitField";

const ALIGNMENTS: readonly ChoiceOption<TitleStyle["align"]>[] = [
  { value: "left", label: t("靠左"), icon: <TextAlignStart aria-hidden /> },
  { value: "center", label: t("置中"), icon: <TextAlignCenter aria-hidden /> },
  { value: "right", label: t("靠右"), icon: <TextAlignEnd aria-hidden /> },
];

/** Width of the choices of a row (they fill the row up to this). */
const CHOICE = "max-w-56 flex-1";

const HINTS = {
  fontSize: t("以 1080 高的畫面為準的像素"),
  x: t("0 % 是畫面左緣，100 % 是右緣"),
  y: t("0 % 是畫面上緣，100 % 是下緣"),
  start: t("文字出現的片段內影格"),
  end: t("文字消失的片段內影格（不含這個影格）"),
} as const;

export interface TextRowsProps {
  clip: TimelineClip;
  /** A text layer: the clip is the text, so the text has no range of its own and cannot be taken off the clip. */
  standalone: boolean;
  edits: ClipEdits;
}

export function TextRows({ clip, standalone, edits: plain }: TextRowsProps) {
  const locked = useContext(FieldLockContext);
  const editor = useEditor();
  const frame = exportGeometry(editor.project);
  // A text layer that moves takes its animation presets along, in the same step
  const kept = (next: TimelineClip) => withTextAnimationsKept(clip, next, frame, localId);
  const edits: ClipEdits = standalone ? { apply: (next) => plain.apply(kept(next)), perform: (next) => plain.perform(kept(next)) } : plain;
  const title = clip.effects?.title;
  if (!title) {
    return (
      <ActionRow>
        <TextButton icon={<Plus aria-hidden />} disabledReason={locked} onClick={() => edits.perform(withTitle(clip, newTitle()))}>
          {t("加入片段文字")}
        </TextButton>
      </ActionRow>
    );
  }
  const style = title.style ?? defaultTitleStyle(title);
  const change = (patch: Partial<Title>) => withTitle(clip, { ...title, ...patch });
  const restyle = (patch: Partial<TitleStyle>) => change({ style: { ...style, ...patch } });
  const duration = processedDuration(clip);
  const start = toClipLocalFrame(clip, title.start_frame);
  const end = toClipLocalFrame(clip, title.end_frame ?? duration);
  return (
    <>
      <Row label={t("內容")} tall>
        <div className="grid min-w-0 flex-1 py-1">
          <TextAreaField
            label={t("文字內容")}
            value={title.text}
            rows={2}
            validate={(text) => (!text.trim() || text.length > TITLE_MAX_LENGTH ? t("標題內容需為 1–200 個字元") : null)}
            onCommit={(text) => {
              // A text layer keeps the name of what it says (its first line) until someone renames the clip
              const named = standalone && (clip.name === t("文字圖層") || clip.name === textLayerName(title.text));
              return edits.apply(named ? { ...change({ text }), name: textLayerName(text) } : change({ text }));
            }}
          />
        </div>
      </Row>
      {title.style ? null : (
        <>
          <Row label={t("位置")}>
            <SelectField
              label={t("文字位置")}
              value={title.position}
              options={TITLE_POSITIONS}
              onChange={(position) => edits.perform(change({ position }))}
              className={CHOICE}
            />
          </Row>
          <Row label={t("大小")}>
            <Segmented label={t("文字大小")} value={title.size} options={TITLE_SIZES} onChange={(size) => edits.perform(change({ size }))} />
          </Row>
        </>
      )}
      <Row label={t("字型")}>
        <SelectField
          label={t("字型")}
          value={style.font_family}
          options={TITLE_FONTS}
          onChange={(font_family) => edits.perform(restyle({ font_family }))}
          className={CHOICE}
        />
      </Row>
      <Row label={t("字重")}>
        <Segmented
          label={t("字重")}
          value={style.font_weight === 700 ? "bold" : "regular"}
          options={TITLE_WEIGHTS}
          onChange={(weight) => edits.perform(restyle({ font_weight: weight === "bold" ? 700 : 400 }))}
        />
      </Row>
      <Row label={t("字級")} hint={HINTS.fontSize}>
        <NumberField
          label={t("字級")}
          value={style.font_size}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          suffix="px"
          hint={HINTS.fontSize}
          onCommit={(font_size) => edits.apply(restyle({ font_size }))}
        />
      </Row>
      <Row label={t("對齊")}>
        <Segmented label={t("文字對齊")} value={style.align} options={ALIGNMENTS} onChange={(align) => edits.perform(restyle({ align }))} />
      </Row>
      <Row label={t("水平位置")} hint={HINTS.x}>
        <UnitField
          label={t("文字的水平位置")}
          unit={UNITS.percent}
          value={style.x}
          min={0}
          max={1}
          hint={HINTS.x}
          onCommit={(x) => edits.apply(restyle({ x }))}
        />
      </Row>
      <Row label={t("垂直位置")} hint={HINTS.y}>
        <UnitField
          label={t("文字的垂直位置")}
          unit={UNITS.percent}
          value={style.y}
          min={0}
          max={1}
          hint={HINTS.y}
          onCommit={(y) => edits.apply(restyle({ y }))}
        />
      </Row>
      <Row label={t("色彩")}>
        <ColorField label={t("文字色彩")} value={style.color} onCommit={(color) => edits.apply(restyle({ color }))} />
      </Row>
      {standalone ? null : (
        <>
          <Row label={t("開始")} hint={HINTS.start}>
            <NumberField
              label={t("文字開始")}
              value={start}
              min={-windowBounds(clip).start_frame}
              max={end - 1}
              suffix={FRAMES_SUFFIX}
              hint={HINTS.start}
              onCommit={(frame) => edits.apply(change({ start_frame: toProcessingFrame(clip, frame) }))}
            />
          </Row>
          <Row label={t("結束")} hint={HINTS.end}>
            <NumberField
              label={t("文字結束")}
              value={end}
              min={start + 1}
              max={toClipLocalFrame(clip, duration)}
              suffix={FRAMES_SUFFIX}
              hint={HINTS.end}
              onCommit={(frame) => edits.apply(change({ end_frame: toProcessingFrame(clip, frame) }))}
            />
          </Row>
        </>
      )}
      {title.style || !standalone ? (
        <ActionRow>
          {title.style ? (
            <TextButton
              title={t("改回預設的位置與大小排版")}
              disabledReason={locked}
              onClick={() => edits.perform(withTitle(clip, withoutTitleStyle(title)))}
            >
              {t("恢復預設排版")}
            </TextButton>
          ) : null}
          {standalone ? null : (
            <TextButton tone="danger" icon={<Trash2 aria-hidden />} disabledReason={locked} onClick={() => edits.perform(withoutTitle(clip))}>
              {t("移除片段文字")}
            </TextButton>
          )}
        </ActionRow>
      ) : null}
    </>
  );
}
