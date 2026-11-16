// 數量 in the generation row: render this shot in several variants in one run, each a take of the shot to compare in
// the monitor — new random seeds (the ×2–×4 of before, still where it starts), the shot's own fixed seed and typed
// fixed seeds; the file behind one reference alias; other ready routes of the same task (variants/VariantChoices.tsx,
// model/variants.ts). Every combination is one take (2–8), listed before sending with what it changes from the shot;
// the shot's own settings are left as they are, and its active take stays (a shot without one gets the first variant
// that finishes, as before). ×1 is the toolbar's 渲染鏡頭. Blocked for the same reasons as 渲染鏡頭 — the shared
// render check, run on every variant — with the estimate of the whole run. The popover stays open while the run is
// sent and closes once it was (the render notice says how it went).
// Layout: a title row with the take count, the choices and the list scrolling in between, the estimate and 渲染 n 個
// 變體 always in view at the bottom. Motion: sections reveal, list rows enter one after another.
import { Shuffle } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { engineBlock, renderDisabledReason, useRenderBlock } from "../hooks/useRenderBlock";
import { useRenderEta } from "../hooks/useRenderEta";
import { useProjectLanes } from "../model/lanePrefs";
import { MAX_TAKES } from "../model/project";
import { engineUnavailable, findRoute, routeDisplayLabel, routeName } from "../model/routes";
import { variantRoutes, variantsProblem } from "../model/variantBatch";
import { choicesProblem, comboBadge, INITIAL_CHOICES, previewShots, variantAxes, variantCombos, variantCount, variantShots, type VariantChoices } from "../model/variants";
import { useStudio } from "../studioContext";
import { EtaLine } from "./RenderEta";
import { FileChoices, RouteChoices, ShotSeedChoices } from "./variants/VariantChoices";

const NO_SHOTS: readonly StudioShot[] = [];

export function VariationsControl({ shot, onSent }: { shot: StudioShot; onSent: (focusWasOnStart: boolean) => void }) {
  const { project, engine, catalog, plugins, busy, renderVariants } = useStudio();
  const id = useId();
  const [choices, setChoices] = useState<VariantChoices>(INITIAL_CHOICES);
  const [pending, setPending] = useState(false);
  const start = useRef<HTMLButtonElement>(null);
  const block = useRenderBlock(shot);
  const lanes = useProjectLanes(project.project_id);
  const library = useMemo(() => project.library ?? [], [project.library]);
  const axes = useMemo(() => variantAxes(shot, choices, library), [shot, choices, library]);
  const count = variantCount(axes);
  const combos = useMemo(() => variantCombos(axes), [axes]);
  const preview = useMemo(() => previewShots(shot, axes), [shot, axes]);
  const routes = variantRoutes(shot, engine.routes, catalog);
  const references = findRoute(engine.routes, shot.route)?.capability === "ref2va" ? (shot.references ?? []) : [];
  const routeLabel = (routeId: string) => routeName(routeDisplayLabel(engine.routes, routeId)).name;

  const problem = choicesProblem(axes) ?? (shot.takes.length + count > MAX_TAKES ? t("這個鏡頭已有 {count} 個 take，最多 {max} 個", { count: shot.takes.length, max: MAX_TAKES }) : null);
  // Every variant through the render check the send runs; the lanes move only variants on the shot's own route
  const preflight = useMemo(() => {
    if (problem !== null) return null;
    return engineBlock(engineUnavailable(engine)) ?? variantsProblem(project, shot, preview, { routes: engine.routes, catalog, plugins, lanes });
  }, [problem, engine, preview, shot, project, lanes, catalog, plugins]);
  const reason = renderDisabledReason({ problem: block.problem ?? problem, preflight }, busy);
  const eta = useRenderEta(problem === null ? preview : NO_SHOTS);

  const submit = () => {
    if (reason || pending) return;
    setPending(true);
    void renderVariants(shot.shot_id, variantShots(shot, axes)).finally(() => {
      setPending(false);
      onSent(document.activeElement === start.current);
    });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/8 px-3">
        <p className="min-w-0 flex-1 truncate text-data font-semibold text-fg">{t("變體")}</p>
        <span aria-live="polite" className={cn("machine shrink-0 text-caption", problem === null ? "text-fg-secondary" : "text-warning")}>
          {t("共 {count} 個 take", { count })}
        </span>
      </div>
      <div className="grid min-h-0 gap-4 overflow-y-auto p-3">
        <p className="text-caption text-fg-tertiary">{t("同一個鏡頭用不同的 seed、參考檔案或路線一起渲染：每一種都成為這個鏡頭的 take，在監看器比較；鏡頭本身的設定不變。")}</p>
        <ShotSeedChoices shot={shot} choices={choices} onChange={setChoices} />
        {references.length > 0 ? <FileChoices shot={shot} choices={choices} onChange={setChoices} library={library} /> : null}
        {routes.length > 0 ? <RouteChoices shot={shot} choices={choices} onChange={setChoices} routes={routes} /> : null}
        <section aria-labelledby={`${id}-list`} className="grid gap-1.5">
          <h3 id={`${id}-list`} className="text-caption font-semibold text-fg-secondary">
            {t("會渲染的 take")}
          </h3>
          {problem ? (
            <p className="text-caption text-warning animate-fade-in">{problem}</p>
          ) : (
            <ol className="grid gap-1">
              {combos.map((combo, index) => {
                const badge = comboBadge(shot, axes, combo, routeLabel);
                return (
                  <li key={`${combo.route}\n${combo.item?.item_id ?? ""}\n${combo.seed}`} ref={reveal(index)} title={badge.text} className="flex min-w-0 items-center gap-2 rounded-md bg-canvas/50 px-2 py-1 text-caption">
                    <span className="machine shrink-0 font-semibold text-fg">{`#${shot.takes.length + index + 1}`}</span>
                    <span className={cn("min-w-0 truncate", badge.same ? "text-fg-tertiary" : "text-fg-secondary")}>{badge.text}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
      <div className="grid shrink-0 gap-2 border-t border-white/8 p-3">
        {problem === null ? <EtaLine state={eta} /> : null}
        <ActionButton ref={start} size="md" variant="primary" icon={<Shuffle aria-hidden />} pending={pending} disabledReason={reason} onClick={submit} className="w-full">
          {t("渲染 {count} 個變體", { count })}
        </ActionButton>
      </div>
    </div>
  );
}
