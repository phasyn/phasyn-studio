// One shot of the list, an option of the multi-select listbox (56 px): thumbnail, place in the film and title, then a
// fixed second line — length and take count, a badge for a route other than the project's default, and in front the
// shot's state, its render progress or why it cannot be rendered. On the right the eye puts the shot on the timeline or
// takes it off (like a track's eye) and "…" opens its menu; both are pointer shortcuts: the menu (Shift+F10, the
// context-menu key, a right click) holds the same actions for the keyboard and screen readers. A shot that starts from
// the previous shot's last frame shows a link mark on the edge between the two rows.
import { Ellipsis, Eye, EyeOff, Link2, TriangleAlert } from "lucide-react";
import { memo, type DragEvent, type MouseEvent } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { LIST_ROW, TOOL_BUTTON } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import type { MenuAnchor } from "@/components/ui/menuModel";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { useRenderBlock } from "../../hooks/useRenderBlock";
import { formatDuration } from "../../model/frames";
import { activeTake, SHOT_STATUS_LABELS, shotStatus, type ShotStatus } from "../../model/project";
import type { ActivityItem } from "../../model/renderActivity";
import { engineUnavailable } from "../../model/routes";
import { hasShotDrag, SHOT_DRAG_TYPE } from "../../model/shotDrag";
import { useStudio } from "../../studioContext";
import { ShotStatusMark } from "../marks";
import { useReportBlock, type BlockReports } from "./blockReports";
import { continuityLink, playableTakeCount, routeBadge, type ContinuityLink } from "./rowFacts";
import { ShotThumb, type ThumbRender } from "./ShotThumb";

/** Row height (px): fixed, so paging and the drop line follow from it. */
export const SHOT_ROW_HEIGHT = 56;

/** Current and selected (fill and marker), current only (marker), selected only (fill), neither. */
const ROW_STATE = {
  both: "bg-brand-gradient-soft before:opacity-100",
  current: "before:opacity-100 hover:bg-raised/70 active:bg-sunken",
  selected: "bg-brand-gradient-soft",
  idle: "hover:bg-raised/70 active:bg-sunken",
} as const;

export interface ShotRowProps {
  shot: StudioShot;
  optionId: string;
  /** Place in the film (0-based); null for a shot that is not on the timeline. */
  position: number | null;
  /** Order of appearance (entrance stagger). */
  index: number;
  selected: boolean;
  current: boolean;
  /** A multi-selection is active: selected rows carry a check mark. */
  batch: boolean;
  /** Part of the batch render: its block is checked and reported. */
  candidate: boolean;
  reports: BlockReports;
  /** The running render's item for this shot. */
  activity: ActivityItem | undefined;
  menuOpen: boolean;
  /** A dragged shot would land above or below this row. */
  dropEdge: "before" | "after" | null;
  onPointer: (event: MouseEvent<HTMLElement>, shotId: string) => void;
  onMenu: (shotId: string, anchor: MenuAnchor) => void;
  onCloseMenu: () => void;
  onToggleTimeline: (shotId: string, on: boolean) => void;
  onDragShot: (shotId: string | null) => void;
  onDragOverShot: (shotId: string, after: boolean) => void;
  onDropShot: (shotId: string, after: boolean) => void;
}

/** What renders the shot now, for the thumbnail and the line: null when the shot is not rendering. */
function thumbRender(status: ShotStatus, activity: ActivityItem | undefined): ThumbRender | null {
  if (status !== "rendering") return null;
  return { fraction: activity?.state === "running" ? activity.fraction : null, waiting: activity?.state === "waiting" };
}

/** The front of the second line while the shot renders: the measured percentage, or rendering / waiting in words. */
function RenderLead({ render, activity }: { render: ThumbRender; activity: ActivityItem | undefined }) {
  const progress = activity?.dit?.progress;
  const detail = progress && progress.completed !== null && progress.total !== null ? t("{label}：{detail}", { label: "DiT", detail: t("已完成 {done}／{total} 步", { done: progress.completed, total: progress.total }) }) : undefined;
  if (render.fraction !== null) {
    return (
      <span title={detail} className="machine shrink-0 text-info">
        {`${Math.round(render.fraction * 100)}%`}
      </span>
    );
  }
  return <span className={cn("shrink-0", render.waiting ? "text-fg-tertiary" : "text-info")}>{render.waiting ? t("排隊中") : t("渲染中")}</span>;
}

/**
 * A candidate of the batch: the render button's own check (useRenderBlock) decides whether it is blocked, and why.
 * Memoized: the check plans the shot's run, so it runs again only when the shot or the Studio changes, not when the
 * selection or a drag re-renders the row.
 */
const CandidateLead = memo(function CandidateLead({ shot, status, reports }: { shot: StudioShot; status: ShotStatus; reports: BlockReports }) {
  const { engine } = useStudio();
  const block = useRenderBlock(shot);
  // While the engine cannot tell yet every shot would look blocked: the batch button says that once instead
  const reason = engineUnavailable(engine) === null ? (block.preflight?.text ?? null) : null;
  useReportBlock(reports, shot.shot_id, reason);
  if (!reason) return <ShotStatusMark status={status} compact />;
  return (
    <span title={reason} className="inline-flex shrink-0 text-warning [&_svg]:size-3.5">
      <TriangleAlert aria-hidden />
      <span className="sr-only">{t("{label}：{detail}", { label: t("無法渲染"), detail: reason })}</span>
    </span>
  );
});

function ContinuityMark({ link }: { link: ContinuityLink }) {
  return (
    <span
      aria-hidden
      title={link.text}
      className={cn(
        "absolute -top-2.5 left-[30px] z-[4] grid size-5 place-items-center rounded-full border bg-surface shadow-edge [&_svg]:size-3",
        link.ok ? "border-brand-blue/50 text-brand-cyan" : "border-warning/60 text-warning",
      )}
    >
      <Link2 />
    </span>
  );
}

export function ShotRow(props: ShotRowProps) {
  const { shot, optionId, position, index, selected, current, batch, candidate, reports, activity, menuOpen, dropEdge } = props;
  const { project, engine } = useStudio();
  const status = shotStatus(shot, project);
  const placed = position !== null;
  const render = thumbRender(status, activity);
  const badge = routeBadge(project, shot, engine);
  const link = continuityLink(project, shot, placed);
  const title = shot.title || t("未命名鏡頭");
  const facts = `${formatDuration(shot.frames)}${t("・{takesCount} take", { takesCount: playableTakeCount(shot) })}`;
  const below = (event: DragEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY > box.top + box.height / 2;
  };
  const tooltip = [title, facts, SHOT_STATUS_LABELS[status], badge?.title, link?.text, placed ? t("拖曳可調整在影片中的順序") : null].filter(Boolean).join("\n");
  return (
    <div
      ref={reveal(index)}
      id={optionId}
      role="option"
      aria-selected={selected}
      data-shot-option={shot.shot_id}
      data-current={current || undefined}
      title={tooltip}
      draggable={placed}
      onClick={(event) => props.onPointer(event, shot.shot_id)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onMenu(shot.shot_id, { kind: "point", x: event.clientX, y: event.clientY });
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData(SHOT_DRAG_TYPE, shot.shot_id);
        event.dataTransfer.setData("text/plain", title);
        event.dataTransfer.effectAllowed = "move";
        props.onDragShot(shot.shot_id);
      }}
      onDragEnd={() => props.onDragShot(null)}
      onDragOver={(event) => {
        if (!placed || !hasShotDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        props.onDragOverShot(shot.shot_id, below(event));
      }}
      onDrop={(event) => {
        if (!placed || !hasShotDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        props.onDropShot(shot.shot_id, below(event));
      }}
      style={{ height: SHOT_ROW_HEIGHT }}
      className={cn(
        "group/tile flex cursor-default items-center gap-2 pr-0.5 pl-2 select-none",
        LIST_ROW,
        ROW_STATE[current ? (selected ? "both" : "current") : selected ? "selected" : "idle"],
        placed && "cursor-grab active:cursor-grabbing",
        "group-focus-visible/shots:data-current:outline-2 group-focus-visible/shots:data-current:-outline-offset-2 group-focus-visible/shots:data-current:outline-focus",
      )}
    >
      {dropEdge ? <span aria-hidden className={cn("pointer-events-none absolute inset-x-1 z-[4] h-0.5 rounded-full bg-brand-cyan shadow-glow-sm", dropEdge === "before" ? "top-0" : "bottom-0")} /> : null}
      {link ? <ContinuityMark link={link} /> : null}
      <ShotThumb take={activeTake(shot)} render={render} checked={batch && selected} dimmed={!placed} />
      <span className="@container grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-data text-fg">
          <span className={cn("machine shrink-0 text-caption transition-colors duration-(--duration-fast)", current ? "text-brand-cyan" : "text-fg-tertiary")}>
            {placed ? String(position + 1).padStart(2, "0") : "––"}
          </span>
          <span className="truncate">{title}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1 text-caption text-fg-tertiary">
          {render ? <RenderLead render={render} activity={activity} /> : candidate ? <CandidateLead shot={shot} status={status} reports={reports} /> : <ShotStatusMark status={status} compact />}
          {/* The badge gives way first and leaves a column narrower than the default panel's (its route stays in the
              row's tooltip); the facts truncate only after that */}
          <span className="min-w-0 truncate">{facts}</span>
          {badge ? (
            <span
              title={badge.title}
              className={cn(
                "hidden min-w-0 shrink-[100] truncate rounded-full border px-1.5 text-[11px] leading-4 @[8.5rem]:block",
                badge.tone === "warning" ? "border-warning/40 bg-warning/12 text-warning" : "border-line bg-raised text-fg-secondary",
              )}
            >
              {badge.text}
            </span>
          ) : null}
        </span>
        <span className="sr-only">{[placed ? t("在時間軸上") : t("不在時間軸上"), link?.text].filter(Boolean).join(t("；"))}</span>
      </span>
      <span aria-hidden className="flex shrink-0 flex-col">
        <button
          type="button"
          tabIndex={-1}
          title={placed ? t("在時間軸上；按一下移出時間軸，後面的片段往前接上") : t("不在時間軸上；按一下加到時間軸結尾")}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleTimeline(shot.shot_id, !placed);
          }}
          className={cn(TOOL_BUTTON, "[&_svg]:size-4", placed ? "text-fg-secondary" : "text-fg-disabled")}
        >
          {placed ? <Eye /> : <EyeOff />}
        </button>
        <button
          type="button"
          tabIndex={-1}
          title={t("「{title}」的動作", { title })}
          // Marks the menu's own trigger: a press on it closes the open menu instead of reopening it
          aria-haspopup="menu"
          data-open={menuOpen || undefined}
          onClick={(event) => {
            event.stopPropagation();
            if (menuOpen) props.onCloseMenu();
            else props.onMenu(shot.shot_id, { kind: "element", element: event.currentTarget });
          }}
          className={cn(TOOL_BUTTON, "text-fg-tertiary [&_svg]:size-4 data-open:bg-brand-gradient-soft data-open:text-fg data-open:ring-1 data-open:ring-brand-blue/50 data-open:ring-inset")}
        >
          <Ellipsis />
        </button>
      </span>
    </div>
  );
}
