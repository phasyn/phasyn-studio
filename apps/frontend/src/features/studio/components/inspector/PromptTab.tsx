// The shot's Prompt tab: one column as tall as the inspector whose only scroll area is the prompt itself. Top to
// bottom: the shot's name (36 px), the editor toolbar (36 px, with the plugin check as a badge), the editor, the shot's
// generation row and, only while something is wrong, the problems row. Notes have a tab of their own. A window too
// short for the editor's minimum lets the whole tab scroll instead of hiding its rows.
import { useId } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Input } from "@/components/ui/controls";
import { t } from "@/i18n";
import { hasFirstFrame } from "../../model/continuity";
import { findRoute } from "../../model/routes";
import { PROMPT_MAX_LENGTH, PromptEditor } from "../../prompt";
import { useStudio } from "../../studioContext";
import { GenerationRow } from "../generation/GenerationRow";
import { PluginBadge } from "./PluginBadge";
import { referenceUnsupported } from "./referenceSupport";
import { usePluginBadge } from "./usePluginBadge";

export function PromptTab({ shot, onShowPlugins }: { shot: StudioShot; onShowPlugins: () => void }) {
  const { project, dispatch, engine } = useStudio();
  const id = useId();
  const update = (patch: Partial<StudioShot>) => dispatch({ type: "updateShot", shotId: shot.shot_id, patch });
  const route = findRoute(engine.routes, shot.route);
  // 有首幀（接續前一個鏡頭或素材庫圖片）就是 fl2va；其他依運算路由
  const mode = hasFirstFrame(shot) ? "fl2va" : (route?.capability ?? undefined);
  const badge = usePluginBadge(shot);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 p-3">
      <div className="flex h-9 shrink-0 items-center gap-2">
        <label htmlFor={`${id}-title`} className="shrink-0 text-caption font-medium text-fg-secondary">
          {t("名稱")}
        </label>
        <Input id={`${id}-title`} compact value={shot.title} maxLength={200} onChange={(event) => update({ title: event.target.value })} className="min-w-0 flex-1" />
      </div>
      <PromptEditor
        value={shot.prompt}
        onChange={(next) => update({ prompt: next.length > PROMPT_MAX_LENGTH ? next.slice(0, PROMPT_MAX_LENGTH) : next })}
        references={shot.references ?? []}
        library={project.library ?? []}
        durationFrames={shot.frames}
        mode={mode}
        contextLabel={shot.title || undefined}
        referenceEditing={{
          projectId: project.project_id,
          shotId: shot.shot_id,
          unsupportedReason: referenceUnsupported(engine, shot.route),
          onLibraryChange: (library) => dispatch({ type: "setLibrary", library }),
          onReferencesChange: (references) => dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { references } }),
        }}
        toolbarStatus={badge ? <PluginBadge shot={shot} badge={badge} onOpenPlugins={onShowPlugins} /> : undefined}
        toolbarStatusKey={badge?.key}
        blockers={badge?.reasons}
        afterEditor={<GenerationRow shot={shot} />}
      />
    </div>
  );
}
