// The one-step fix on a slate whose shot fixes sampling values that the LoRA sampling contract of its route's DiT
// refuses (the render is held back before it is sent; one sent anyway fails in the DiT step). 改用元件預設 clears
// those values of the shot (an ordinary project edit, offered back with 復原 right there); 開啟畫質設定 opens the engine
// sheet on its 畫質 tab. Nothing here starts a render.
import { MonitorCog, RotateCcw, Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { formatSampling, samplingConflicts, type SamplingKey } from "@/lib/ditSampling";
import { t } from "@/i18n";
import { useProjectLanes } from "../../model/lanePrefs";
import { laneRouteFor } from "../../model/lanes";
import type { ShotPatch } from "../../model/project";
import { findRoute } from "../../model/routes";
import { showEngine } from "../generation/engineView";
import { useStudio } from "../../studioContext";

/** The shot's own sampling values that the DiT of the route it would render with refuses (the same route as useRenderBlock). */
function useRefusedSampling(shot: StudioShot): SamplingKey[] {
  const { project, engine } = useStudio();
  const lanes = useProjectLanes(project.project_id);
  const route = findRoute(engine.routes, laneRouteFor(engine.routes, lanes, shot));
  const dit = route?.steps.find((item) => item.step.step_id === route.ditStepId)?.slot.component;
  if (!dit) return [];
  const pinned = { steps: shot.steps, video_shift: shot.video_shift, audio_shift: shot.audio_shift };
  return samplingConflicts(pinned, dit)
    .filter((item) => item.blocking)
    .map((item) => item.key);
}

export function SamplingFix({ shot }: { shot: StudioShot }) {
  const { dispatch, setEngineOpen } = useStudio();
  const refused = useRefusedSampling(shot);
  /** The values 改用元件預設 cleared, until 復原 puts them back or the shot needs the fix again. */
  const [cleared, setCleared] = useState<ShotPatch | null>(null);
  const fixRef = useRef<HTMLButtonElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);

  if (refused.length > 0) {
    const values = Object.fromEntries(refused.map((key) => [key, shot[key]])) as ShotPatch;
    const fix = () => {
      dispatch({ type: "updateShot", shotId: shot.shot_id, patch: Object.fromEntries(refused.map((key) => [key, null])) });
      setCleared(values);
      requestAnimationFrame(() => undoRef.current?.focus());
    };
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 animate-fade-in">
        <Button
          ref={fixRef}
          size="sm"
          variant="secondary"
          icon={<RotateCcw aria-hidden />}
          title={t("清空這個鏡頭固定的 {values}，渲染時改用 DiT 元件保存的值", { values: formatSampling(values) })}
          onClick={fix}
        >
          {t("改用元件預設")}
        </Button>
        <Button size="sm" variant="quiet" icon={<MonitorCog aria-hidden />} onClick={() => { showEngine({ tab: "quality", routeId: null }, setEngineOpen); }}>
          {t("開啟畫質設定")}
        </Button>
      </div>
    );
  }
  if (!cleared) return null;
  const undo = () => {
    dispatch({ type: "updateShot", shotId: shot.shot_id, patch: cleared });
    setCleared(null);
    requestAnimationFrame(() => fixRef.current?.focus());
  };
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 animate-fade-in">
      <span role="status" className="text-caption text-success">
        {t("已改用元件預設（原本 {values}）", { values: formatSampling(cleared) })}
      </span>
      <Button ref={undoRef} size="sm" variant="quiet" icon={<Undo2 aria-hidden />} onClick={undo}>
        {t("復原")}
      </Button>
    </div>
  );
}
