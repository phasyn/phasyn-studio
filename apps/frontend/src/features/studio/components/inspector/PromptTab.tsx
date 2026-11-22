// The shot's Prompt tab: one column as tall as the inspector whose only scroll area is the prompt itself, laid out as
// calm sections. Top to bottom: the shot's name as the panel's
// title (an inline-editable 40 px heading) with ⋯ beside it for the rarer take sources (附加歷史輸出, 採用現有影片 — each
// a dialog), the Prompt section (one toolbar row, the editor taking every spare pixel, the problems row only while
// something is wrong) and the 生成設定 section (方式, 時長, Seed, 數量 as a 2×2 grid with one status line). Notes have a
// tab of their own. A window too short for the editor's minimum lets the whole tab scroll instead of hiding its rows.
import { Ellipsis, Film, History } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import { Input } from "@/components/ui/controls";
import { t } from "@/i18n";
import { AdoptMediaTake } from "../../attach/AdoptMediaTake";
import { AttachRunTake } from "../../attach/AttachRunTake";
import { hasFirstFrame } from "../../model/continuity";
import { routeDrivingRoles } from "../../model/drivingMedia";
import { shotFps } from "../../model/promptRules";
import { findRoute } from "../../model/routes";
import { PROMPT_MAX_LENGTH, PromptEditor } from "../../prompt";
import { useStudio } from "../../studioContext";
import { GenerationRow } from "../generation/GenerationRow";
import { PluginBadge } from "./PluginBadge";
import { referenceUnsupported } from "./referenceSupport";
import { usePluginBadge } from "./usePluginBadge";

type TakeDialog = "attach" | "adopt" | null;

/** The shot's name (the tab's title) and ⋯ with the take sources that are not part of the everyday loop. */
function ShotHeader({ shot, onTitle }: { shot: StudioShot; onTitle: (title: string) => void }) {
  const { adoptMedia } = useStudio();
  const id = useId();
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [dialog, setDialog] = useState<TakeDialog>(null);
  const onOpenChange = (open: boolean) => {
    if (open) return;
    setDialog(null);
    // The dialog came from the menu, which is gone: focus goes back to ⋯ once the dialog has let it go
    const trigger = triggerRef.current;
    if (trigger) requestAnimationFrame(() => { if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
  };
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5">
      <Input
        id={`${id}-title`}
        aria-label={t("鏡頭名稱")}
        title={t("鏡頭名稱")}
        value={shot.title}
        maxLength={200}
        onChange={(event) => { onTitle(event.target.value); }}
        className="min-h-10 flex-1 truncate border-transparent bg-transparent px-2 text-body font-semibold hover:border-line-control focus-visible:border-line-control focus-visible:bg-sunken"
      />
      <MenuTriggerButton
        menuId={`${id}-menu`}
        open={menuAnchor !== null}
        label={t("鏡頭的其他動作")}
        onOpen={(element) => {
          triggerRef.current = element;
          setMenuAnchor(element);
        }}
        onClose={() => { setMenuAnchor(null); }}
        className="size-8 [&_svg]:size-4"
      >
        <Ellipsis aria-hidden />
      </MenuTriggerButton>
      {menuAnchor ? (
        <ActionMenu
          id={`${id}-menu`}
          label={t("鏡頭的其他動作")}
          anchor={{ kind: "element", element: menuAnchor }}
          returnFocus={menuAnchor}
          onClose={() => { setMenuAnchor(null); }}
          items={[
            { id: "attach", label: t("附加歷史輸出"), icon: History, onSelect: () => { setDialog("attach"); } },
            { id: "adopt", label: t("採用現有影片"), icon: Film, onSelect: () => { setDialog("adopt"); } },
          ]}
        />
      ) : null}
      <AttachRunTake key={shot.shot_id} shot={shot} open={dialog === "attach"} onOpenChange={onOpenChange} />
      <AdoptMediaTake key={`adopt-${shot.shot_id}`} shot={shot} onAdopt={adoptMedia} open={dialog === "adopt"} onOpenChange={onOpenChange} />
    </div>
  );
}

export function PromptTab({ shot, onShowPlugins }: { shot: StudioShot; onShowPlugins: () => void }) {
  const { project, dispatch, engine } = useStudio();
  const update = (patch: Partial<StudioShot>) => { dispatch({ type: "updateShot", shotId: shot.shot_id, patch }); };
  const route = findRoute(engine.routes, shot.route);
  // 有首幀（接續前一個鏡頭或素材庫圖片）就是 fl2va；其他依運算路由
  const mode = hasFirstFrame(shot) ? "fl2va" : (route?.capability ?? undefined);
  const badge = usePluginBadge(shot);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pt-2 pb-3">
      <ShotHeader shot={shot} onTitle={(title) => { update({ title }); }} />
      <PromptEditor
        value={shot.prompt}
        onChange={(next) => { update({ prompt: next.length > PROMPT_MAX_LENGTH ? next.slice(0, PROMPT_MAX_LENGTH) : next }); }}
        references={shot.references ?? []}
        library={project.library ?? []}
        durationFrames={shot.frames}
        fps={shotFps(route, project)}
        {...(mode === undefined ? {} : { mode })}
        drivenByReferences={routeDrivingRoles(route).length > 0}
        {...(shot.title ? { contextLabel: shot.title } : {})}
        referenceEditing={{
          projectId: project.project_id,
          shotId: shot.shot_id,
          unsupportedReason: referenceUnsupported(engine, shot.route),
          onLibraryChange: (library) => { dispatch({ type: "setLibrary", library }); },
          onReferencesChange: (references) => { dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { references } }); },
        }}
        toolbarStatus={badge ? <PluginBadge shot={shot} badge={badge} onOpenPlugins={onShowPlugins} /> : undefined}
        {...(badge?.key === undefined ? {} : { toolbarStatusKey: badge.key })}
        {...(badge?.reasons === undefined ? {} : { blockers: badge.reasons })}
        afterEditor={<GenerationRow shot={shot} />}
        className="gap-2"
      />
    </div>
  );
}
