// The generation settings of a shot, under the prompt: the settings a person changes for every render, as a titled
// section of four framed fields in a 2×2 grid — 方式 (how it is generated), 時長 / Seed, 數量 — each with its label over
// its value and opening its popover (a single line of four segments reads as cramped). A value that cannot render as it is (the route is not ready, the mode has a problem, the previous shot has
// nothing to continue from) is stated once, in one status line under the grid; the field shows the warning frame and
// names that line as its description.
// The section keeps no state of the shot: every field edits it (one project edit each), 數量 starts variants (seeds,
// a reference's file, routes; VariationsControl.tsx) without editing it, and a 方式 change leaves one notice with 復原
// just above the section.
import { Dices, TriangleAlert } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useId, useRef, useState, type Ref } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { continuitySource } from "../../model/continuity";
import { formatDuration } from "../../model/frames";
import { readMode, routeReadyForMode } from "../../model/generationMode";
import { RANDOM_SEED } from "../../model/project";
import { findRoute } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { VariationsControl } from "../VariationsControl";
import { frameLimits } from "../../model/studioGenerationBinding";
import { FrameCountInput } from "./FrameCountInput";
import { DurationList } from "./DurationList";
import { ModeNotice, type AppliedMode } from "./ModeNotice";
import { ModePicker } from "./ModePicker";
import { MODE_ICON, readingText } from "./modeText";
import { Popover } from "./Popover";
import { SeedForm } from "./SeedForm";
import { SegmentButton } from "./SegmentButton";
import { usePopover } from "./usePopover";
import { t } from "@/i18n";

export interface GenerationRowProps {
  shot: StudioShot;
}

/** Why the shot's mode cannot render as it is, or null: the one status the section states. */
function useModeWarning(shot: StudioShot): string | null {
  const { project, engine, catalog } = useStudio();
  const route = findRoute(engine.routes, shot.route);
  const reading = readMode(shot, route, engine.status === "ready");
  const { problem } = readingText(reading);
  const notReady = reading.mode && route && !reading.issue && engine.status === "ready" && !routeReadyForMode(route, reading.mode, catalog) ? t("路線還沒準備好：{summary}", { summary: route.summary }) : null;
  const source = reading.mode === "continue" ? continuitySource(project, shot).problem : null;
  const warning = problem ?? source ?? notReady;
  return warning != null && warning !== "" ? warning : null;
}

function ModeField({ shot, warningId, onApplied, ref }: { shot: StudioShot; warningId: string | null; onApplied: (applied: Omit<AppliedMode, "id">) => void; ref: Ref<HTMLButtonElement> }) {
  const { engine } = useStudio();
  const id = useId();
  const popover = usePopover();
  const route = findRoute(engine.routes, shot.route);
  const reading = readMode(shot, route, engine.status === "ready");
  const { value } = readingText(reading);
  return (
    <>
      <SegmentButton
        ref={ref}
        label={t("方式")}
        value={value}
        valueText={value}
        {...(reading.mode ? { icon: MODE_ICON[reading.mode] } : {})}
        warning={warningId !== null}
        {...(warningId === null ? {} : { describedBy: warningId })}
        open={popover.open}
        popoverId={id}
        onClick={popover.toggle}
      />
      <Popover id={id} open={popover.open} anchor={popover.anchor} label={t("生成方式")} onClose={popover.close} className="w-[25rem]">
        <ModePicker shot={shot} onApplied={onApplied} onClose={popover.close} />
      </Popover>
    </>
  );
}

function DurationField({ shot }: { shot: StudioShot }) {
  const { dispatch, project, engine } = useStudio();
  const id = useId();
  const popover = usePopover();
  const route = findRoute(engine.routes, shot.route);
  const limits = frameLimits([route]);
  // A route driven by media (表演影片, 音訊驅動) takes its length from that media: the shot's frames are not sent
  const driven = route?.family === "creative";
  const value = driven ? t("跟隨素材") : formatDuration(shot.frames, project.format.fps.num / project.format.fps.den);
  const apply = (frames: number) => {
    if (frames !== shot.frames) dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { frames } });
    popover.close(true);
  };
  return (
    <>
      <SegmentButton
        label={t("時長")}
        value={value}
        valueText={driven ? t("長度跟隨驅動素材") : t("{duration}（{frames} 影格）", { duration: value, frames: shot.frames })}
        open={popover.open}
        popoverId={id}
        onClick={popover.toggle}
      />
      <Popover id={id} open={popover.open} anchor={popover.anchor} label={t("時長")} onClose={popover.close} className="w-60">
        {driven ? (
          <p className="p-3 text-caption text-fg-secondary">{t("這條路線生成的長度跟隨表演影片或驅動音訊，不用設定時長。")}</p>
        ) : limits.h3 ? <DurationList frames={shot.frames} onPick={apply} /> : (
          <div className="p-2"><FrameCountInput key={shot.frames} initial={shot.frames} limits={limits} onApply={apply} /></div>
        )}
      </Popover>
    </>
  );
}

function SeedField({ shot }: { shot: StudioShot }) {
  const id = useId();
  const popover = usePopover();
  const random = shot.seed === RANDOM_SEED;
  return (
    <>
      <SegmentButton
        label="Seed"
        value={random ? t("隨機") : <span className="machine">{shot.seed}</span>}
        valueText={random ? t("每次隨機") : String(shot.seed)}
        {...(random ? { icon: Dices } : {})}
        open={popover.open}
        popoverId={id}
        onClick={popover.toggle}
      />
      <Popover id={id} open={popover.open} anchor={popover.anchor} label="Seed" onClose={popover.close} className="w-72">
        <SeedForm shot={shot} />
      </Popover>
    </>
  );
}

function CountField({ shot }: { shot: StudioShot }) {
  const id = useId();
  const popover = usePopover();
  return (
    <>
      <SegmentButton
        label={t("數量")}
        value={<span className="machine">×1</span>}
        valueText={t("一次渲染 1 個；可改成一次渲染最多 8 個變體")}
        title={t("工具列的「渲染鏡頭」一次渲染 1 個；這裡一次渲染最多 8 個變體：不同的 seed、參考檔案或路線，各成為一個 take")}
        open={popover.open}
        popoverId={id}
        onClick={popover.toggle}
      />
      <Popover id={id} open={popover.open} anchor={popover.anchor} label={t("變體")} onClose={popover.close} className="w-[26rem] max-w-[calc(100vw-1rem)]">
        <VariationsControl shot={shot} onSent={popover.close} />
      </Popover>
    </>
  );
}

export function GenerationRow({ shot }: GenerationRowProps) {
  const [notice, setNotice] = useState<AppliedMode | null>(null);
  const modeFieldRef = useRef<HTMLButtonElement>(null);
  const noticesRef = useRef(0);
  const headingId = useId();
  const warningId = useId();
  const warning = useModeWarning(shot);
  const dismiss = useCallback(() => { setNotice(null); }, []);
  const applied = useCallback((change: Omit<AppliedMode, "id">) => {
    noticesRef.current += 1;
    setNotice({ ...change, id: noticesRef.current });
  }, []);
  return (
    <div role="group" aria-labelledby={headingId} className="relative grid shrink-0 gap-1.5 border-t border-line-subtle pt-2.5">
      <AnimatePresence>
        {notice ? <ModeNotice key={notice.id} shot={shot} notice={notice} onDismiss={dismiss} returnFocus={() => modeFieldRef.current?.focus({ preventScroll: true })} /> : null}
      </AnimatePresence>
      <h3 id={headingId} className="text-caption font-medium text-fg-secondary">{t("生成設定")}</h3>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <ModeField ref={modeFieldRef} shot={shot} warningId={warning === null ? null : warningId} onApplied={applied} />
        <DurationField shot={shot} />
        <SeedField shot={shot} />
        <CountField shot={shot} />
      </div>
      {warning === null ? null : (
        <p id={warningId} role="status" className="flex min-w-0 items-start gap-1.5 text-caption text-warning animate-reveal">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]" title={warning}>{warning}</span>
        </p>
      )}
    </div>
  );
}
