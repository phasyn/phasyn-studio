// The slate of a shot that renders: its title, what the render does now, the time left (an estimate, or why there is
// none), one 4 px bar of the measured DiT share (moving without a percentage while there is no step evidence), and the
// two things to do: cancel the run (through the confirmation) or follow it in the Render workspace. No render button
// and no estimate made before sending: the render is already on its way.
import { Ban, Clapperboard } from "lucide-react";
import { Link } from "react-router";
import type { StudioShot, StudioTake } from "@/api/generated/contracts";
import type { WireRun } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { METER_FILL, METER_TRACK, SHIMMER } from "@/components/ui/look";
import { useChangeFade } from "@/components/ui/motion";
import { buttonVariants } from "@/components/ui/variants";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { completionText, formatEtaClock } from "../../model/eta";
import type { RenderActivity } from "../../model/renderActivity";
import { useRenderActivity } from "../../renderActivityContext";
import { useStudio } from "../../studioContext";
import { projectHref } from "../../workspaces";
import { activityItem, ditFraction, renderStage, takeTimeLeft, type TimeLeft } from "./renderStage";
import { useTakeRender } from "./useTakeRender";

/** A cancellation the slate asks for: the run as it was when asked, the button that asked and what else stops with it. */
export interface CancelRequest {
  run: WireRun;
  opener: HTMLElement;
  scope: string | undefined;
}

/** What else stops with the run: every shot of a batch or every variation (finished ones are kept). */
function cancelScope(activity: RenderActivity | null): string | undefined {
  if (!activity || activity.total < 2) return undefined;
  const values = { count: activity.total };
  return activity.variations ? t("這個 run 的 {count} 個變體都會停止；已經完成的保留。", values) : t("這個 run 的 {count} 個鏡頭都會停止；已經完成的保留。", values);
}

function TimeLeftLine({ left }: { left: TimeLeft }) {
  if (left.kind === "known") {
    return (
      <p className="text-caption text-fg-secondary" title={t("依本機成本紀錄；已完成的步驟用實際時間，進行中的步驟＝預估減去已經過的時間")}>
        <T source={"剩餘約 <0>{left}</0>・{completion}"} values={{ left: formatEtaClock(left.seconds), completion: completionText(left.at) }} slots={[<span key="slot-0" className="machine" />]} />
      </p>
    );
  }
  if (left.kind === "estimating") return <p className="text-caption text-fg-tertiary">{t("估算中…")}</p>;
  return (
    <p className="text-caption text-fg-tertiary" title={`${left.reason}\n${left.detail}`}>
      {t("尚無預估")}
    </p>
  );
}

/** The 4 px bar: the measured DiT share, or a sweep that only says the render is on (never a made-up percentage). */
function DitBar({ fraction }: { fraction: number | null }) {
  const percent = fraction === null ? null : Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <span
      role="progressbar"
      aria-label={t("DiT 去噪進度")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      title={percent === null ? t("還沒有 DiT 逐步證據，進度未知") : undefined}
      className={cn(METER_TRACK, "w-full")}
    >
      {percent === null ? <span className={cn("absolute inset-0 bg-brand-gradient opacity-60", SHIMMER)} /> : <span className={METER_FILL} style={{ width: `${String(percent)}%` }} />}
    </span>
  );
}

export function RenderingSlate({ shot, take, onCancel }: { shot: StudioShot; take: StudioTake; onCancel: (request: CancelRequest) => void }) {
  const { project } = useStudio();
  const activity = useRenderActivity();
  const live = useTakeRender(take);
  const item = activityItem(activity, take);
  const stage = renderStage(take, activity, live);
  const stageRef = useChangeFade<HTMLParagraphElement>(stage);
  const run = item && activity ? activity.run : live.run;
  const cancelBlocked = !run ? t("還在讀取這次渲染") : run.state !== "running" ? t("這次渲染已經結束") : null;
  const href = `${projectHref("render", project.project_id)}&run=${encodeURIComponent(take.run_id)}`;
  return (
    <section aria-label={t("「{title}」渲染中", { title: shot.title })} className="grid w-full max-w-md justify-items-center gap-3 text-center animate-rise-in">
      <h2 className="max-w-full text-body font-semibold text-fg [overflow-wrap:anywhere]">{shot.title}</h2>
      <div className="grid w-full justify-items-center gap-1.5">
        <p ref={stageRef} role="status" className="max-w-full truncate text-data text-fg" title={stage}>
          {stage}
        </p>
        <TimeLeftLine left={takeTimeLeft(take, activity)} />
        <DitBar fraction={ditFraction(take, activity, live)} />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        <ActionButton
          size="sm"
          variant="secondary"
          icon={<Ban aria-hidden />}
          disabledReason={cancelBlocked}
          title={t("取消這個 run（會先確認）")}
          onClick={(event) => {
            if (run?.state === "running") onCancel({ run, opener: event.currentTarget, scope: cancelScope(activity) });
          }}
        >
          {t("取消渲染…")}
        </ActionButton>
        <Link to={href} className={buttonVariants({ variant: "quiet", size: "sm" })}>
          <Clapperboard aria-hidden />
          {t("在渲染頁查看")}
        </Link>
      </div>
    </section>
  );
}
