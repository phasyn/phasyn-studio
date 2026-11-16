// The generation row of a shot, under the prompt: the settings a person changes for every render, one field each —
// 方式 (how it is generated), 時長, Seed and 數量 — each opening its popover. Always one 40 px line: from 22.5rem
// (360 px) of row width every field shows its chevron and a fixed seed its number (the 420 px inspector leaves 394 px;
// the four fields need at most about 350); narrower, the chevrons go and a fixed seed reads 固定, its number in the
// tooltip and the name (the 352 px inspector leaves 326 px, the 300 px minimum 274 px; the fields then need at most
// about 256).
// The row keeps no state of the shot: every field edits it (one project edit each), 數量 starts variants (seeds,
// a reference's file, routes; VariationsControl.tsx) without editing it, and a 方式 change leaves one notice with 復原
// just above the row.
import { Dices } from "lucide-react";
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

/** Hairline between two fields (on the field's left). */
const DIVIDER = "before:pointer-events-none before:absolute before:inset-y-2 before:-left-px before:w-px before:bg-line-subtle";

function ModeField({ shot, onApplied, ref }: { shot: StudioShot; onApplied: (applied: Omit<AppliedMode, "id">) => void; ref: Ref<HTMLButtonElement> }) {
  const { project, engine, catalog } = useStudio();
  const id = useId();
  const popover = usePopover();
  const route = findRoute(engine.routes, shot.route);
  const reading = readMode(shot, route, engine.status === "ready");
  const { value, problem } = readingText(reading);
  const notReady = reading.mode && route && !reading.issue && engine.status === "ready" && !routeReadyForMode(route, reading.mode, catalog) ? t("路線還沒準備好：{summary}", { summary: route.summary }) : null;
  const source = reading.mode === "continue" ? continuitySource(project, shot).problem : null;
  return (
    <>
      <SegmentButton
        ref={ref}
        label={t("方式")}
        value={value}
        valueText={value}
        icon={reading.mode ? MODE_ICON[reading.mode] : undefined}
        warning={problem ?? source ?? notReady}
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

function DurationField({ shot, className }: { shot: StudioShot; className?: string }) {
  const { dispatch } = useStudio();
  const id = useId();
  const popover = usePopover();
  const value = formatDuration(shot.frames);
  return (
    <>
      <SegmentButton
        label={t("時長")}
        value={value}
        valueText={t("{duration}（{frames} 影格）", { duration: value, frames: shot.frames })}
        open={popover.open}
        popoverId={id}
        onClick={popover.toggle}
        className={className}
      />
      <Popover id={id} open={popover.open} anchor={popover.anchor} label={t("時長")} onClose={popover.close} className="w-60">
        <DurationList
          frames={shot.frames}
          onPick={(frames) => {
            if (frames !== shot.frames) dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { frames } });
            popover.close(true);
          }}
        />
      </Popover>
    </>
  );
}

function SeedField({ shot, className }: { shot: StudioShot; className?: string }) {
  const id = useId();
  const popover = usePopover();
  const random = shot.seed === RANDOM_SEED;
  return (
    <>
      <SegmentButton
        label="Seed"
        value={random ? t("隨機") : <span className="machine">{shot.seed}</span>}
        compactValue={random ? t("隨機") : t("固定")}
        valueText={random ? t("每次隨機") : String(shot.seed)}
        icon={random ? Dices : undefined}
        open={popover.open}
        popoverId={id}
        onClick={popover.toggle}
        className={className}
      />
      <Popover id={id} open={popover.open} anchor={popover.anchor} label="Seed" onClose={popover.close} className="w-72">
        <SeedForm shot={shot} />
      </Popover>
    </>
  );
}

function CountField({ shot, className }: { shot: StudioShot; className?: string }) {
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
        className={className}
      />
      <Popover id={id} open={popover.open} anchor={popover.anchor} label={t("變體")} onClose={popover.close} className="w-[26rem] max-w-[calc(100vw-1rem)]">
        <VariationsControl shot={shot} onSent={popover.close} />
      </Popover>
    </>
  );
}

export function GenerationRow({ shot }: GenerationRowProps) {
  const [notice, setNotice] = useState<AppliedMode | null>(null);
  const modeField = useRef<HTMLButtonElement>(null);
  const notices = useRef(0);
  const dismiss = useCallback(() => setNotice(null), []);
  const applied = useCallback((change: Omit<AppliedMode, "id">) => {
    notices.current += 1;
    setNotice({ ...change, id: notices.current });
  }, []);
  return (
    <div role="group" aria-label={t("生成設定")} className="@container/genrow relative flex h-10 shrink-0 items-center border-t border-line-subtle px-1">
      <AnimatePresence>
        {notice ? <ModeNotice key={notice.id} shot={shot} notice={notice} onDismiss={dismiss} returnFocus={() => modeField.current?.focus({ preventScroll: true })} /> : null}
      </AnimatePresence>
      <div className="grid w-full min-w-0 grid-cols-[repeat(4,minmax(0,auto))]">
        <ModeField ref={modeField} shot={shot} onApplied={applied} />
        <DurationField shot={shot} className={DIVIDER} />
        <SeedField shot={shot} className={DIVIDER} />
        <CountField shot={shot} className={DIVIDER} />
      </div>
    </div>
  );
}
