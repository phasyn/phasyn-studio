// 插件管理視窗的內容（第一次開啟時才載入）：44 px 的頂層分頁「已安裝」「這個專案」與分頁內容，加上拖放檔案時蓋上的
// 放置區說明與底部的結果訊息。
import { Ban, FileUp, FolderKanban, Package } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { motionTransition } from "@/components/ui/motion";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { usePersistentFlag } from "@/lib/usePersistentSize";
import { InstalledPane } from "./InstalledPane";
import type { ManagerTab } from "./managerOpen";
import { useManager, type ManagerNotice, type NoticeTone } from "./managerContext";
import { ProjectPane } from "./ProjectPane";
import type { DropVerdict } from "./useDropZone";

const ID_PREFIX = "plugin-manager";
const NOTICE_TONE: Record<NoticeTone, string> = {
  success: "border-success/40 text-success",
  info: "border-line-strong text-fg",
  warning: "border-warning/40 text-warning",
  danger: "border-danger/40 text-danger",
};

function DropOverlay({ verdict, reason }: { verdict: DropVerdict; reason: string | null }) {
  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={motionTransition("fast", "standard")}
      className={cn(
        "pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed backdrop-blur-sm",
        verdict === "accept" ? "border-brand-blue/70 bg-brand-soft" : "border-danger/70 bg-danger/10",
      )}
    >
      <motion.span
        key={verdict}
        initial={{ opacity: 0, y: 6, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={motionTransition("spring-snappy", "spring-snappy")}
        className="material-popover grid max-w-[40ch] justify-items-center gap-2 rounded-xl px-6 py-4 text-center"
      >
        {verdict === "accept" ? <FileUp aria-hidden className="size-7 text-brand-cyan" /> : <Ban aria-hidden className="size-7 text-danger" />}
        <span className="text-body font-semibold text-fg">{verdict === "accept" ? t("放開以驗證這個插件包") : t("現在不能安裝")}</span>
        <span className="text-caption text-fg-tertiary">{verdict === "accept" ? t("主控先檢查內容，確認後才安裝") : reason}</span>
      </motion.span>
    </motion.div>
  );
}

function NoticeBubble({ notice, onDismiss }: { notice: ManagerNotice; onDismiss: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onDismiss}
      title={t("關閉")}
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4 }}
      transition={motionTransition("spring-bouncy", "spring-bouncy")}
      className={cn(
        "material-popover absolute bottom-12 left-1/2 z-30 max-w-[min(48rem,calc(100%-4rem))] -translate-x-1/2 rounded-full border px-4 py-2 text-data font-medium [overflow-wrap:anywhere]",
        NOTICE_TONE[notice.tone],
      )}
    >
      {notice.text}
    </motion.button>
  );
}

/** The result of the last action. The live region is there before a message arrives, so a screen reader announces the message when it appears. */
function NoticeToast() {
  const { notice, clearNotice } = useManager();
  return (
    <div role="status" className="contents">
      <AnimatePresence>{notice ? <NoticeBubble key={notice.serial} notice={notice} onDismiss={clearNotice} /> : null}</AnimatePresence>
    </div>
  );
}

export interface ManagerWindowProps {
  tab: ManagerTab;
  onTabChange: (tab: ManagerTab) => void;
  /** 有檔案正被拖進視窗：蓋上放置區的說明。 */
  dropping: DropVerdict | null;
  /** 以指定的項目開啟視窗的序號（0＝沒有）：每換一次，收起的詳情欄就展開，指定的內容才看得到。 */
  revealSerial: number;
}

export default function ManagerWindow({ tab, onTabChange, dropping, revealSerial }: ManagerWindowProps) {
  const { registry, project, installBlocked } = useManager();
  const [railOpen, setRailOpen] = usePersistentFlag("plugins.manager.rail", true);
  const [detailOpen, setDetailOpen] = usePersistentFlag("plugins.manager.detail", true);
  const [revealed, setRevealed] = useState(0);
  if (revealSerial !== revealed) {
    setRevealed(revealSerial);
    if (!detailOpen) setDetailOpen(true);
  }
  const layout = {
    railOpen,
    onToggleRail: () => setRailOpen(!railOpen),
    detailOpen,
    onToggleDetail: () => setDetailOpen(!detailOpen),
    onOpenDetail: () => (detailOpen ? undefined : setDetailOpen(true)),
  };
  const count = registry.list?.items.length;
  const current = project ? tab : "installed";
  return (
    <>
      {project ? (
        <PanelTabs
          variant="studio"
          idPrefix={ID_PREFIX}
          label={t("插件管理")}
          value={current}
          onChange={(next) => onTabChange(next === "project" ? "project" : "installed")}
          tabs={[
            { id: "installed", label: t("已安裝"), icon: Package, count },
            { id: "project", label: t("這個專案"), icon: FolderKanban, count: project.refs.length },
          ]}
          className="px-2"
        />
      ) : null}
      <div role="tabpanel" id={`${ID_PREFIX}-panel-${current}`} aria-labelledby={`${ID_PREFIX}-tab-${current}`} className="flex min-h-0 flex-1 flex-col">
        {current === "project" && project ? <ProjectPane project={project} {...layout} /> : <InstalledPane {...layout} />}
      </div>
      <NoticeToast />
      <AnimatePresence>{dropping ? <DropOverlay verdict={dropping} reason={installBlocked} /> : null}</AnimatePresence>
    </>
  );
}
