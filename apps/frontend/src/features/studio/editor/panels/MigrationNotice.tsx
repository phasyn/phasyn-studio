// What the Controller adjusted and the user cannot see on the timeline itself: a value it brought into range when
// it built the timeline of an older project, a longer take whose clips could not follow. The notes of
// StudioTimeline.migration_notes are shown until the user closes them; closing removes them from the project, so
// they are read once and never come back.
import { Info, X } from "lucide-react";
import { TOOL_BUTTON } from "@/components/ui/look";
import { t } from "@/i18n";
import { useEditor } from "../editorContext";

export function MigrationNotice() {
  const { project, dispatch } = useEditor();
  const saved = project.timeline;
  const notes = saved?.migration_notes ?? [];
  if (!saved || notes.length === 0) return null;
  const close = () => {
    const { migration_notes: _notes, ...timeline } = saved;
    dispatch({ type: "setTimeline", timeline });
  };
  return (
    <div role="status" className="mb-1.5 flex items-start gap-2 rounded-lg border border-info/35 bg-info/10 px-3 py-2 text-data text-fg animate-rise-in">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="font-medium">{t("時間軸有幾項調整需要你留意")}</p>
        <ul className="grid list-disc gap-0.5 pl-5 text-fg-secondary">
          {notes.map((note) => (
            <li key={note} className="[overflow-wrap:anywhere]">
              {note}
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className={TOOL_BUTTON} aria-label={t("關閉這則說明")} title={t("關閉這則說明")} onClick={close}>
        <X aria-hidden />
      </button>
    </div>
  );
}
