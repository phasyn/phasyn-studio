// One item of a run in the overview (audit F-04, F-05): the same card follows the item from waiting to finished, so a
// take never shows twice. Waiting: a quiet slot. Running: the generating frame with the measured DiT share (progress
// ring), 「DiT 第 3／8 步」 or the stage that runs, and this item's estimated time left when the run has several items.
// Finished: the video, a two-line title, badges for seed and length only, the route only when it differs from the
// shot's current one, and the actions: 設為使用中 (or a quiet 使用中 ✓), 比較 in the Shots monitor, and download.
import { Check, Columns2, LoaderCircle } from "lucide-react";
import { Link } from "react-router";
import { mediaUrl } from "@/api/http";
import { CircularProgress } from "@/components/common/CircularProgress";
import { GeneratingFrame } from "@/components/common/GeneratingFrame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CARD, LIFT, TOOL_BUTTON } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { buttonVariants } from "@/components/ui/variants";
import { cn } from "@/lib/cn";
import { formatDuration } from "../../model/frames";
import { progressHeadline } from "../../model/progress";
import { activeTake } from "../../model/project";
import { branchLabel, type QueueItem } from "../../model/renderQueue";
import { routeDisplayLabel, routeName } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { TakeStateMark } from "../marks";
import { TakeDownloadLink } from "../TakeDownload";
import type { RunItem } from "./runView";
import { useShotsLink } from "./shotsLink";
import { formatLeft } from "./time";
import { t, tServer } from "@/i18n";

/** The error text of an ended item follows its state mark: cancelled is neutral, interrupted a warning, failed red. */
const ERROR_TONE: Partial<Record<RunItem["state"], string>> = { cancelled: "text-fg-secondary", interrupted: "text-warning" };

function RunningMedia({ entry, showLeft, label }: { entry: RunItem; showLeft: boolean; label: string }) {
  const fraction = entry.dit?.state === "running" ? entry.dit.progress.fraction : null;
  const text = entry.dit?.state === "running" ? t("DiT {headline}", { headline: progressHeadline(entry.dit) }) : (entry.stage ?? t("準備中"));
  return (
    <GeneratingFrame active progress={fraction} className="rounded-md">
      <div className="grid aspect-video w-full place-items-center rounded-md bg-stage p-3 text-center">
        <div className="grid min-w-0 justify-items-center gap-1.5">
          {fraction !== null ? (
            <CircularProgress value={fraction} size={40} strokeWidth={2.5} showValue label={t("{label}：DiT 去噪進度", { label })} />
          ) : (
            <LoaderCircle aria-hidden className="size-6 animate-spin text-info" />
          )}
          <span className="machine max-w-full truncate text-data text-fg">{text}</span>
          {showLeft && entry.remainingSeconds !== null ? (
            <span className="machine text-caption text-fg-secondary" title={t("這一項的預估剩餘時間（依本機成本紀錄）")}>
              {t("剩 {left}", { left: formatLeft(entry.remainingSeconds) })}
            </span>
          ) : null}
        </div>
      </div>
    </GeneratingFrame>
  );
}

function EndedMedia({ entry }: { entry: RunItem }) {
  const error = entry.take?.error ?? null;
  return (
    <div className={cn("grid aspect-video w-full place-items-center rounded-md p-3 text-center", entry.state === "waiting" ? "border border-dashed border-line bg-canvas/60" : "bg-stage")}>
      <div className="grid min-w-0 justify-items-center gap-1">
        {entry.state === "waiting" ? <span className="text-caption text-fg-tertiary">{t("等待中")}</span> : <TakeStateMark state={entry.state} />}
        {error ? (
          <span className={cn("line-clamp-3 text-caption [overflow-wrap:anywhere]", ERROR_TONE[entry.state] ?? "text-danger")} title={tServer(error.message)}>
            {tServer(error.message)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TakeActions({ entry }: { entry: RunItem }) {
  const { dispatch } = useStudio();
  const link = useShotsLink();
  const { shot, take } = entry;
  if (!shot || !take) return null;
  const reference = activeTake(shot);
  const active = reference?.take_id === take.take_id;
  const comparable = !active && reference?.state === "succeeded" && Boolean(reference.asset);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {active ? (
        <span className="inline-flex h-8 items-center gap-1 px-1.5 text-data text-fg-secondary" title={t("時間軸與匯出用的是這個 take")}>
          <Check aria-hidden className="size-4 text-success" />
          {t("使用中")}
        </span>
      ) : (
        <Button size="sm" variant="primary" onClick={() => dispatch({ type: "setActiveTake", shotId: shot.shot_id, takeId: take.take_id, adoptSeed: true })} title={t("時間軸與匯出改用這個 take")}>
          {t("設為使用中")}
        </Button>
      )}
      {comparable && reference ? (
        <Link
          to={link.href(shot.shot_id)}
          onClick={() => link.prepare(shot.shot_id, { source: reference.take_id, compare: take.take_id })}
          title={t("到「鏡頭」的監看器並排：A＝使用中的 take、B＝這個 take")}
          className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "no-underline")}
        >
          <Columns2 aria-hidden />
          {t("比較")}
        </Link>
      ) : null}
      <TakeDownloadLink shot={shot} take={take} iconOnly className={cn(TOOL_BUTTON, "ml-auto size-8 [&_svg]:size-4")} />
    </div>
  );
}

export function ItemCard({ item, entry, index, showLeft }: { item: QueueItem; entry: RunItem; index: number; showLeft: boolean }) {
  const { engine } = useStudio();
  const { shot, take } = entry;
  // The queue's own entry: a variation is numbered by its place among the run's takes
  const queueTake = take ? item.takes.find((candidate) => candidate.take.take_id === take.take_id) : undefined;
  const label = branchLabel(item, queueTake, shot?.title ?? t("（已移出專案）"));
  const file = take?.state === "succeeded" ? take.asset?.file : undefined;
  // Variations compete for one shot: the take in use carries the brand edge there (a batch has one take per shot)
  const marked = item.kind === "variations" && shot !== null && take !== null && activeTake(shot)?.take_id === take.take_id;
  const route = take && shot && take.route !== shot.route ? routeDisplayLabel(engine.routes, take.route) : null;
  return (
    <li ref={reveal(index)} className={cn(CARD, LIFT, "grid min-w-0 content-start gap-2 rounded-xl p-2", marked && "border-transparent border-brand-gradient")}>
      {file ? (
        <video src={mediaUrl(file.node_id, file.file_id)} controls preload="metadata" aria-label={t("{label}・seed {seed}", { label, seed: take?.seed ?? "" })} className="aspect-video w-full rounded-md bg-stage object-contain" />
      ) : entry.state === "running" ? (
        <RunningMedia entry={entry} showLeft={showLeft} label={label} />
      ) : (
        <EndedMedia entry={entry} />
      )}
      <p className="line-clamp-2 min-h-10 text-data leading-5 font-medium text-fg [overflow-wrap:anywhere]" title={shot?.title ?? label}>
        {label}
      </p>
      {take ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge className="machine">seed {take.seed}</Badge>
          <Badge className="machine">{formatDuration(take.frames)}</Badge>
          {route ? (
            <span className="min-w-0 flex-1 truncate text-caption text-fg-tertiary" title={t("運算路由：{label}（與鏡頭目前的設定不同）", { label: route })}>
              {routeName(route).name}
            </span>
          ) : null}
        </div>
      ) : null}
      {file ? <TakeActions entry={entry} /> : null}
    </li>
  );
}
