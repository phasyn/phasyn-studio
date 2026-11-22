import { isNonzeroNumber } from "@/lib/json";
// Notifications (bottom right, above the status bar, newest at the bottom, at most four): they stay clear of the tab
// strips under the toolbar (the shot inspector's Prompt／參考／插件 tabs) that people reach for right after an action.
// Presented with Motion: a new one slides in from the right with the bouncy spring; a closed or expired one leaves (8 px right, 0.98, fade, --duration-exit)
// while the others glide into place (layout, snappy spring). An exiting notice is inert and hidden from assistive
// technology from the moment it starts to leave; Motion removes it when its exit ends. The data (notices) always
// updates at once — the list only presents it. Each item carries its own live role, so the container is not a live
// region (that would make some screen readers read it twice).
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Link } from "react-router";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { useHoverFocusTimeout } from "@/lib/useHoverFocusPause";
import type { Notice } from "./useNotices";
import { t } from "@/i18n";

const NOTICE_ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert } as const;
const NOTICE_TONES = { info: "bg-info/15 text-info", success: "bg-success/15 text-success", warning: "bg-warning/15 text-warning", danger: "bg-danger/15 text-danger" } as const;

export function Notices({ notices, onDismiss, onEngine }: { notices: readonly Notice[]; onDismiss: (id: number) => void; onEngine: () => void }) {
  return (
    <div className="pointer-events-none absolute right-3 bottom-11 z-30 grid w-[min(26rem,calc(100%-1.5rem))] gap-2">
      <AnimatePresence initial={false} mode="popLayout">
        {notices.map((notice) => (
          <NoticeItem key={notice.id} notice={notice} onDismiss={onDismiss} onEngine={onEngine} />
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * One notice: those with timeoutMs close on their own; hovering or focusing pauses the timer and leaving resumes it
 * with the time left. The timer only decides when to dismiss; Motion's presence plays the exit.
 */
function NoticeItem({ notice, onDismiss, onEngine }: { notice: Notice; onDismiss: (id: number) => void; onEngine: () => void }) {
  const exiting = !useIsPresent();
  const Icon = NOTICE_ICONS[notice.tone];
  const id = notice.id;
  const { paused, pauseHandlers } = useHoverFocusTimeout(notice.timeoutMs ?? null, !exiting, () => { onDismiss(id); });
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 16, y: 6, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 8, scale: 0.98, transition: motionTransition("exit", "exit") }}
      transition={{ ...motionTransition("spring-bouncy", "spring-bouncy"), layout: motionTransition("spring-snappy", "spring-snappy") }}
      role={exiting ? undefined : notice.tone === "danger" ? "alert" : "status"}
      inert={exiting}
      aria-hidden={exiting || undefined}
      {...pauseHandlers}
      className={cn(
        "material-popover flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-fg forced-colors:border forced-colors:border-[CanvasText]",
        exiting ? "pointer-events-none" : "pointer-events-auto",
      )}
    >
      <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-full", NOTICE_TONES[notice.tone])}>
        <Icon className="size-4" />
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="text-data font-medium text-fg">{notice.title}</p>
        {(notice.detail != null && notice.detail !== "") ? <p className="text-caption text-fg-secondary [overflow-wrap:anywhere]">{notice.detail}</p> : null}
        {notice.link ? (
          notice.link.to === "#engine" ? (
            <button type="button" onClick={onEngine} className="pressable justify-self-start rounded-sm text-caption text-action-fg underline-offset-2 hover:underline">
              {notice.link.label}
            </button>
          ) : (
            <Link to={notice.link.to} className="justify-self-start text-caption">
              {notice.link.label}
            </Link>
          )
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => { onDismiss(id); }}
        aria-label={t("關閉通知")}
        title={isNonzeroNumber(notice.timeoutMs) ? (paused ? t("關閉通知（自動關閉已暫停）") : t("關閉通知（滑過時暫停自動關閉）")) : t("關閉通知")}
        className="pressable inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-tertiary hover:bg-white/10 hover:text-fg active:bg-sunken"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </motion.div>
  );
}
