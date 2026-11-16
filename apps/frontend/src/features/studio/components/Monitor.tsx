// The monitor of the Shots workspace: normally the selected shot's take in A (alone, or compared with a pinned B by a
// split line or side by side); when the timeline plays or its ruler is dragged it shows the Program instead — the same
// compositor as the Edit workspace's Program monitor, so both workspaces show the same picture for the same playhead.
// Which one shows is decided by the last interaction (monitorMode in the studio context). Look: the picture sits in a
// rounded black stage with the transport as its own row below (never over the picture), and under that the take
// strip, where takes are watched, compared and made the active one. A take being rendered turns the stage's frame into
// the generating frame and its slate shows the render's progress. A variant take carries its variant badge (what it
// has that the shot does not) next to the shot's name, and on the A／B chips while it is compared.
import { Columns2, Film, MonitorPlay } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { PANEL_RAISED, TOOL_BUTTON, TOOL_BUTTON_ON } from "@/components/ui/look";
import { useChangeFade } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { usePersistentChoice } from "@/lib/usePersistentSize";
import type { StudioShot, StudioTake } from "@/api/generated/contracts";
import { useEditor } from "../editor/editorContext";
import { useVariantBadge } from "../hooks/useVariantBadge";
import { takeNumber } from "../model/takeDownload";
import type { VariantBadge } from "../model/variants";
import { CompareModeSwitch } from "./monitor/CompareModeSwitch";
import { SequenceView } from "./monitor/SequenceView";
import { SourceView } from "./monitor/SourceView";
import { COMPARE_MODES, defaultCompare, isPlayable, pinnedCompare, shownCompare, viewedTake, type CompareMode } from "./monitor/monitorTakes";
import { TakeStrip } from "./monitor/TakeStrip";
import { TakeDownloadLink } from "./TakeDownload";
import { t } from "@/i18n";

/** The viewed take's number and variant badge after the shot's name (the whole text in the tooltip); it fades when it changes. */
function VariantTitle({ shot, take, badge }: { shot: StudioShot; take: StudioTake; badge: VariantBadge }) {
  const text = t("take {number}・{text}", { number: takeNumber(shot, take), text: badge.text });
  const fade = useChangeFade<HTMLSpanElement>(text);
  return (
    <span ref={fade} title={text} className={cn("min-w-0 truncate rounded-md px-1.5 text-caption leading-5", badge.same ? "bg-overlay text-fg-tertiary" : "bg-brand-soft text-fg-secondary")}>
      {text}
    </span>
  );
}

/** A／B chip words: 「#3・seed 42・@Video1 …」 for a variant take, nothing for another. */
function chipText(shot: StudioShot | null, take: StudioTake | null, badge: VariantBadge | null): string | null {
  return shot && take && badge ? t("#{number}・{text}", { number: takeNumber(shot, take), text: badge.text }) : null;
}

export function Monitor() {
  const { project, totalFrames, selectedShotId, monitorMode, setMonitorMode, sourceTakeId, compareTakeId, setCompareTakeId } = useEditor();
  const [compareMode, setCompareMode] = usePersistentChoice<CompareMode>("studio.monitor.compare", "split", COMPARE_MODES);
  const shot = project.shots.find((item) => item.shot_id === selectedShotId) ?? null;
  const take = shot ? viewedTake(shot, sourceTakeId) : null;
  const pinned = shot ? pinnedCompare(shot, compareTakeId) : null;
  const compare = shownCompare(take, pinned);
  const playableCount = shot?.takes.filter(isPlayable).length ?? 0;
  const badge = useVariantBadge(shot, take);
  const compareBadge = useVariantBadge(shot, compare);
  const chips = { a: chipText(shot, take, badge), b: chipText(shot, compare, compareBadge) };
  // 時間軸是空的時候沒有東西可以依播放頭顯示：回到鏡頭畫面
  const showSequence = monitorMode === "program" && totalFrames > 0;

  return (
    <section aria-label={t("監看器")} className={PANEL_RAISED}>
      {/* 左＝目前看的內容、右＝A/B 比較與下載（挑 take 在畫面下方的 take 列；「渲染鏡頭」在工具列） */}
      <div className="grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-line-subtle px-2.5">
        <div className="flex min-w-0 items-center">
          {showSequence ? (
            <p className="flex min-w-0 items-center gap-1.5 truncate text-data text-fg-secondary">
              <MonitorPlay aria-hidden className="size-3.5 shrink-0 text-brand-cyan" />
              <span className="text-fg">{t("節目")}</span>
              <span className="truncate text-fg-tertiary">{project.title}</span>
            </p>
          ) : shot ? (
            <p className="flex min-w-0 items-center gap-1.5 truncate text-data text-fg-secondary">
              <Film aria-hidden className="size-3.5 shrink-0 text-brand-cyan" />
              <span className={cn("truncate text-fg", badge && "max-w-[45%] shrink-0")}>{shot.title}</span>
              {take && badge ? <VariantTitle shot={shot} take={take} badge={badge} /> : null}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          {showSequence && shot ? (
            <button
              type="button"
              onClick={() => setMonitorMode("source")}
              title={t("停止序列播放，改看選取的鏡頭「{title}」", { title: shot.title })}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-caption text-fg-secondary transition-colors duration-(--duration-fast) hover:bg-raised hover:text-fg active:bg-sunken active:duration-0 [&_svg]:size-3.5"
            >
              <Film aria-hidden />
              {t("看選取的鏡頭")}
            </button>
          ) : null}
          {!showSequence && compare ? <CompareModeSwitch value={compareMode} onChange={setCompareMode} /> : null}
          {!showSequence && shot && playableCount > 1 ? (
            <button
              type="button"
              aria-pressed={pinned !== null}
              aria-label={pinned ? t("結束 A/B 比較") : t("A/B 比較兩個 take")}
              title={pinned ? t("結束 A/B 比較") : t("A/B 比較兩個 take")}
              onClick={() => setCompareTakeId(pinned ? null : (defaultCompare(shot, take)?.take_id ?? null))}
              className={cn(TOOL_BUTTON, "size-8 [&_svg]:size-4", pinned && TOOL_BUTTON_ON)}
            >
              <Columns2 aria-hidden />
            </button>
          ) : null}
          {!showSequence && shot && take ? <TakeDownloadLink shot={shot} take={take} iconOnly className={cn(TOOL_BUTTON, "size-8 [&_svg]:size-4")} /> : null}
        </div>
      </div>
      {showSequence ? (
        <SequenceView />
      ) : shot ? (
        <SourceView key={`${shot.shot_id}:${take?.take_id ?? ""}`} shot={shot} take={take} compare={compare} compareMode={compareMode} chips={chips} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-1.5">
          <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto rounded-lg bg-stage">
            <EmptyState illustration="frames" title={t("還沒有鏡頭")} description={t("在左側「鏡頭」分頁按「新增鏡頭」。")} />
          </div>
        </div>
      )}
      {shot && shot.takes.length > 0 ? <TakeStrip key={shot.shot_id} shot={shot} viewed={take} pinnedId={pinned?.take_id ?? null} comparing={!showSequence && compare !== null} /> : null}
    </section>
  );
}
