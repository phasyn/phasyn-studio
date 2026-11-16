// The 方式 popover of the generation row: the four ways a shot is generated (參考素材, 接續上一鏡, 首幀圖片, 只用文字),
// each with one line of what it uses. Choosing one sets the route and the first frame together (model/generationMode.ts)
// and leaves one notice with 復原. A 方式 whose route is not ready says so in place with the engine sheet on that route's
// components; one that no saved route can render says it has to be created under 元件修改. 首幀圖片 asks for the image
// first, as a second step of the same popover. Below the list: the first-frame detail of the current 方式, and the route
// in use (自動 when it is the one the 方式 picks, 指定 when another one was pinned) with 變更… for the engine sheet, and
// under it the route's caveat when it has one (a DiT of fewer than 4 steps). The full route label is the tooltip.
// Keyboard: ↑／↓ move between the 方式, Enter chooses; the current one has focus when the popover opens.
// Motion: the 方式 reveal one after another and each step fades in; tints change on the fast timing.
import { Check, Cpu, ExternalLink } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Link } from "react-router";
import type { StudioLibraryItem, StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { OPTION_CARD, OPTION_IDLE, OPTION_SELECTED } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { useRenderEta } from "../../hooks/useRenderEta";
import { continuityMode, predecessor } from "../../model/continuity";
import { formatEtaClock, planEtaText } from "../../model/eta";
import { GENERATION_MODES, modeChange, rankModeRoutes, readMode, routeBlock, routeFitsMode, routeReadyForMode, type GenerationMode } from "../../model/generationMode";
import { findRoute, routeContinuity, type StudioRoute } from "../../model/routes";
import { useStudio, type StudioContextValue } from "../../studioContext";
import { FirstFrameDetail, FirstFrameImagePicker } from "../ContinuityControl";
import { ReadyDot, RouteCaveatLine } from "../routeParts";
import { showEngine } from "./engineView";
import type { AppliedMode } from "./ModeNotice";
import { firstFrameImagesProblem, MODE_ICON, MODE_LABEL, modeHint, routeFace } from "./modeText";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

interface ModeOption {
  mode: GenerationMode;
  current: boolean;
  /** Why it cannot be chosen now; null = it can. */
  blocked: string | null;
  /** No saved route renders it: one has to be created under 元件修改. */
  missing: boolean;
  /** The route it would use when that route cannot render it yet, with why (start its components, or its setup). */
  notReady: { route: StudioRoute; text: string; detail: string } | null;
}

function modeOptions(shot: StudioShot, { project, engine, catalog }: Pick<StudioContextValue, "project" | "engine" | "catalog">): ModeOption[] {
  const route = findRoute(engine.routes, shot.route);
  const reading = readMode(shot, route, engine.status === "ready");
  return GENERATION_MODES.map((mode): ModeOption => {
    const current = reading.mode === mode;
    const base: ModeOption = { mode, current, blocked: null, missing: false, notReady: null };
    if (engine.status !== "ready") return { ...base, blocked: engine.status === "error" ? t("讀不到路線：{error}", { error: engine.error ?? t("未知錯誤") }) : t("還在讀取路線") };
    const target = route && routeFitsMode(route, mode) ? route : rankModeRoutes(mode, { routes: engine.routes, catalog, project, shot })[0];
    if (!target) return { ...base, missing: true, blocked: t("還沒有能這樣生成的路線") };
    if (mode === "continue" && !current) {
      const problem = predecessor(project, shot.shot_id).problem;
      if (problem) return { ...base, blocked: problem };
    }
    if (mode === "image" && !current) {
      const problem = firstFrameImagesProblem(project);
      if (problem) return { ...base, blocked: problem };
    }
    if (routeReadyForMode(target, mode, catalog)) return base;
    const support = mode === "continue" ? routeContinuity(target, catalog) : null;
    const block = routeBlock(target, support?.frame ? [support.frame] : []);
    return { ...base, notReady: { route: target, text: block === "start" ? t("需要的元件還沒啟動") : t("路線有問題，渲染會被擋下"), detail: support?.summary ?? target.summary } };
  });
}

/** The notice's second line: what the change did besides the 方式 itself. */
function describeChange(
  { mode, route, routeChanged, item, ready }: { mode: GenerationMode; route: StudioRoute; routeChanged: boolean; item: StudioLibraryItem | undefined; ready: boolean },
  { project, catalog }: Pick<StudioContextValue, "project" | "catalog">,
  shot: StudioShot,
): string {
  const parts: string[] = [];
  if (routeChanged) {
    const face = routeFace(route, catalog);
    parts.push(face.machine ? t("路線換成「{name}」（{machine}）", { name: face.name, machine: face.machine }) : t("路線換成「{name}」", { name: face.name }));
  }
  if (mode === "continue") parts.push(t("首幀取自「{title}」的最後一格", { title: predecessor(project, shot.shot_id).previous?.shot.title || t("前一個鏡頭") }));
  else if (mode === "image" && item) parts.push(t("首幀用「{name}」", { name: item.name }));
  else if (continuityMode(shot) !== "none") parts.push(t("不再使用首幀"));
  if (mode !== "references" && (shot.references?.length ?? 0) > 0) parts.push(t("參考素材不會送出（仍保留在鏡頭裡）"));
  if (!ready) parts.push(t("路線還沒準備好"));
  return parts.join(t("；"));
}

function OptionRow({ option, hint, onChoose, onEngine, onLeave, ref }: { option: ModeOption; hint: string; onChoose: () => void; onEngine: (routeId: string) => void; onLeave: () => void; ref?: Ref<HTMLDivElement> }) {
  const id = useId();
  const Icon = MODE_ICON[option.mode];
  const disabled = option.blocked !== null;
  const note = option.notReady?.text ?? option.blocked;
  return (
    <div ref={ref} className="grid gap-1">
      <button
        type="button"
        data-mode-option={option.mode}
        data-autofocus={option.current ? "" : undefined}
        aria-pressed={option.current}
        aria-disabled={disabled || undefined}
        aria-describedby={note ? `${id}-hint ${id}-note` : `${id}-hint`}
        title={option.blocked ?? undefined}
        onClick={onChoose}
        className={cn(
          OPTION_CARD,
          "grid w-full grid-cols-[1.75rem_minmax(0,1fr)_1rem] items-center gap-x-2.5 px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-focus",
          option.current ? OPTION_SELECTED : disabled ? "cursor-not-allowed border-transparent bg-transparent" : OPTION_IDLE,
        )}
      >
        <span
          aria-hidden
          className={cn(
            "row-span-2 grid size-7 place-items-center rounded-md border transition-colors duration-(--duration-fast)",
            option.current ? "border-brand-blue/50 bg-brand-soft text-brand-cyan" : "border-line bg-raised text-fg-tertiary",
            disabled && "opacity-60",
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className={cn("truncate text-data font-medium", disabled ? "text-fg-disabled" : "text-fg")}>{MODE_LABEL[option.mode]}</span>
        {option.current ? <Check aria-hidden className="row-span-2 size-4 text-brand-cyan animate-pop-in" /> : <span aria-hidden className="row-span-2" />}
        <span id={`${id}-hint`} className={cn("col-start-2 truncate text-caption", disabled ? "text-fg-disabled" : "text-fg-tertiary")}>
          {hint}
        </span>
      </button>
      {note ? (
        <div id={`${id}-note`} className={cn("flex min-w-0 items-center gap-2 pr-1 pl-11 text-caption", option.notReady ? "text-warning" : "text-fg-tertiary")}>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]" title={option.notReady?.detail}>
            {note}
          </span>
          {option.notReady ? (
            <Button size="sm" variant="quiet" className="min-h-7 shrink-0 px-2" icon={<Cpu aria-hidden />} onClick={() => option.notReady && onEngine(option.notReady.route.id)}>
              {t("開啟渲染引擎")}
            </Button>
          ) : option.missing ? (
            <Link to="/admin/pipelines" onClick={onLeave} className="inline-flex shrink-0 items-center gap-1">
              <ExternalLink aria-hidden className="size-3.5" />
              {t("到「元件修改・元件組合」建立")}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The route in use: 「自動：<名稱>」 when the 方式 would pick it, 「指定：<名稱>」 when another one was pinned; machine, state, estimate, 變更…. */
function RouteLine({ shot, mode, onChange }: { shot: StudioShot; mode: GenerationMode | null; onChange: () => void }) {
  const { project, engine, catalog } = useStudio();
  const route = findRoute(engine.routes, shot.route);
  const shots = useMemo(() => [shot], [shot]);
  const { eta } = useRenderEta(shots);
  const face = route ? routeFace(route, catalog) : null;
  const auto = route !== null && mode !== null && rankModeRoutes(mode, { routes: engine.routes, catalog, project, shot })[0]?.id === route.id;
  const name = <span className="min-w-0 truncate" />;
  return (
    <div className="shrink-0 border-t border-white/8">
      <div className="flex h-11 items-center gap-1.5 px-3 text-caption">
        <span className="shrink-0 text-fg-tertiary">{t("路線")}</span>
        {route && face ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-fg" title={route.ready ? face.title : `${face.title}\n${route.summary}`}>
            {mode === null ? (
              <span className="min-w-0 truncate">{face.name}</span>
            ) : auto ? (
              <T source={"自動：<0>{name}</0>"} values={{ name: face.name }} slots={[name]} />
            ) : (
              <T source={"指定：<0>{name}</0>"} values={{ name: face.name }} slots={[name]} />
            )}
            {face.machine ? <span className="shrink-0 text-fg-tertiary">{`· ${face.machine}`}</span> : null}
            <ReadyDot ready={route.ready} />
            <span className="sr-only">{route.ready ? t("就緒") : t("未就緒：{summary}", { summary: route.summary })}</span>
            {eta ? (
              <span className="machine shrink-0 text-fg-tertiary" title={planEtaText(eta)}>
                {t("約 {time}", { time: formatEtaClock(eta.totalSeconds) })}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-warning">{engine.status === "ready" ? t("找不到這個鏡頭的路線") : t("讀取中…")}</span>
        )}
        <Button size="sm" variant="quiet" className="min-h-7 shrink-0 px-2" onClick={onChange}>
          {t("變更…")}
        </Button>
      </div>
      {route ? <RouteCaveatLine route={route} className="-mt-1 h-6 px-3 pb-1" /> : null}
    </div>
  );
}

export function ModePicker({ shot, onApplied, onClose }: { shot: StudioShot; onApplied: (applied: Omit<AppliedMode, "id">) => void; onClose: (restoreFocus: boolean) => void }) {
  const studio = useStudio();
  const { project, engine, catalog, dispatch, setEngineOpen } = studio;
  const root = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<"modes" | "image">("modes");
  const reading = readMode(shot, findRoute(engine.routes, shot.route), engine.status === "ready");
  const options = modeOptions(shot, studio);

  const focusLater = (selector: string) => window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }));
  // Focus goes back to the 方式 field first: the sheet returns it there when it closes
  const openEngine = (view: Parameters<typeof showEngine>[0]) => {
    onClose(true);
    showEngine(view, setEngineOpen);
  };
  const apply = (mode: GenerationMode, item?: StudioLibraryItem) => {
    const change = modeChange(project, shot, mode, { routes: engine.routes, catalog }, item?.item_id);
    if (!change.ok) return;
    if (Object.keys(change.patch).length === 0) {
      onClose(true);
      return;
    }
    const ready = routeReadyForMode(change.route, mode, catalog);
    const after = { route: change.patch.route ?? shot.route, continuity: "continuity" in change.patch ? change.patch.continuity : shot.continuity };
    dispatch({ type: "updateShot", shotId: shot.shot_id, patch: change.patch });
    onApplied({
      title: reading.mode === mode ? t("已更新「{mode}」", { mode: MODE_LABEL[mode] }) : t("已改用「{mode}」", { mode: MODE_LABEL[mode] }),
      detail: describeChange({ mode, route: change.route, routeChanged: change.route.id !== shot.route, item, ready }, studio, shot),
      before: { route: shot.route, continuity: shot.continuity },
      after,
      notReadyRouteId: ready ? null : change.route.id,
    });
    onClose(true);
  };
  const choose = (option: ModeOption) => {
    if (option.blocked) return;
    if (option.mode === "image") {
      setStep("image");
      focusLater("input[type='search']");
      return;
    }
    if (option.current && reading.issue === null) onClose(true);
    else apply(option.mode);
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-mode-option]")];
    const index = buttons.findIndex((button) => button === document.activeElement);
    buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    event.preventDefault();
  };

  if (step === "image") {
    return (
      <div ref={root} className="flex min-h-0 flex-col animate-reveal">
        <FirstFrameImagePicker
          shot={shot}
          onPick={(item) => apply("image", item)}
          onBack={() => {
            setStep("modes");
            focusLater("[data-mode-option='image']");
          }}
        />
      </div>
    );
  }
  return (
    <div ref={root} className="flex min-h-0 flex-col animate-reveal">
      <p className="flex h-10 shrink-0 items-center border-b border-white/8 px-3 text-data font-semibold text-fg">{t("生成方式")}</p>
      <div className="min-h-0 overflow-y-auto p-1.5">
        <div role="group" aria-label={t("生成方式")} className="grid gap-1" onKeyDown={onListKeyDown}>
          {options.map((option, index) => (
            <OptionRow
              key={option.mode}
              ref={reveal(index)}
              option={option}
              hint={modeHint(option.mode, project, shot)}
              onChoose={() => choose(option)}
              onEngine={(routeId) => openEngine({ tab: "components", routeId })}
              onLeave={() => onClose(false)}
            />
          ))}
        </div>
        {reading.mode === "continue" || reading.mode === "image" ? (
          <div className="mt-1.5 border-t border-white/8 px-1 pt-2 pb-0.5">
            <FirstFrameDetail
              shot={shot}
              onChangeImage={() => {
                setStep("image");
                focusLater("input[type='search']");
              }}
            />
          </div>
        ) : null}
      </div>
      <RouteLine shot={shot} mode={reading.mode} onChange={() => openEngine({ tab: "routes", routeId: null })} />
    </div>
  );
}
