// The Text dock of the Captions and graphics layout: the text of the selected text layer, or of the selected clip
// that carries a text. Without one it offers to add a text layer at the playhead (and, when a clip on a video track
// is selected, to put a text on that clip; an adjustment layer has no picture to carry one). The title templates are
// offered beside both. The same rows are in the Text group of Effect Controls.
import { Plus, Type } from "lucide-react";
import type { TimelineClip } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { isAdjustment } from "../adjustment";
import { useEditor } from "../editorContext";
import { chordOf } from "../keymap";
import { TitleTemplateMenu } from "../titles/TitleTemplateMenu";
import { clipEdits, lockReason } from "./controls/clipEdits";
import { newTitle, withTitle } from "./controls/clipLooks";
import { DensityContext, FieldLockContext } from "./controls/controlsContext";
import { TextRows } from "./controls/TextRows";

function ClipText({ clip }: { clip: TimelineClip }) {
  const editor = useEditor();
  const lock = lockReason(editor.timeline, clip, editor.linked);
  const standalone = editor.sourceOf(clip)?.kind === "text";
  return (
    <DensityContext.Provider value="comfortable">
      <FieldLockContext.Provider value={lock}>
        <div data-keep-focus="" className="flex min-h-0 flex-1 flex-col">
          <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
            <Type aria-hidden className="size-4 shrink-0 text-brand-violet" />
            <h2 className="min-w-0 flex-1 truncate text-body font-semibold text-fg" title={clip.name}>
              {clip.name}
            </h2>
            <TitleTemplateMenu />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            <TextRows clip={clip} standalone={standalone} edits={clipEdits(editor, editor.warn)} />
          </div>
        </div>
      </FieldLockContext.Provider>
    </DensityContext.Provider>
  );
}

export function TextDock() {
  const editor = useEditor();
  const clip = editor.selectedClip;
  const picture = clip && editor.trackOf(clip)?.kind === "video" && !isAdjustment(editor.timeline, clip) ? clip : null;
  if (picture?.effects?.title) return <ClipText key={picture.clip_id} clip={picture} />;
  const lock = picture ? lockReason(editor.timeline, picture, editor.linked) : null;
  const addToClip = () => {
    if (picture && !lock) clipEdits(editor, editor.warn).perform(withTitle(picture, newTitle()));
  };
  return (
    <div data-keep-focus="" className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
      <EmptyState
        size="compact"
        icon={<Type />}
        title={t("選取文字圖層或有文字的片段")}
        action={
          <>
            <Button
              size="sm"
              icon={<Plus aria-hidden />}
              title={t("在播放頭新增文字圖層（{shortcut}）", { shortcut: chordOf("addText") })}
              onClick={editor.addTextLayer}
            >
              {t("新增文字圖層")}
            </Button>
            <TitleTemplateMenu labelled />
            {picture ? (
              <Button
                size="sm"
                variant="quiet"
                aria-disabled={lock ? true : undefined}
                title={lock ?? t("把文字加在選取的片段上，跟著片段一起移動")}
                onClick={addToClip}
              >
                {t("在選取的片段加上文字")}
              </Button>
            ) : null}
          </>
        }
      />
    </div>
  );
}
