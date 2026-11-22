// 素材庫的左欄：參考素材的類型與使用狀態、渲染結果（可依鏡頭篩選）與匯出成片的分類（附數量）、上傳進度與合計大小。
import { Clapperboard, ListVideo } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { StudioShot } from "@/api/generated/contracts";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import type { LibraryKindFilter, LibraryUsageFilter } from "../../model/library";
import { ReferenceUploadRow } from "../../references/UploadRow";
import type { LibraryUploads } from "../bin/useLibraryUploads";
import { KIND_FILTERS, USAGE_FILTERS } from "./filters";
import { CategoryButton, ShotFilterButton } from "./libraryControls";
import { t } from "@/i18n";

/** 素材庫的三個分類：參考素材（素材庫項目）、渲染結果（成功的 take）、匯出成片（序列匯出）。 */
export type LibrarySection = "assets" | "takes" | "exports";

export interface LibrarySidebarProps {
  section: LibrarySection;
  kind: LibraryKindFilter;
  usage: LibraryUsageFilter;
  /** 渲染結果只看這個鏡頭（null＝全部鏡頭）。 */
  shotFilter: string | null;
  kindCount: (id: LibraryKindFilter) => number;
  usageCount: (id: LibraryUsageFilter) => number;
  takeCount: number;
  exportCount: number;
  /** 有渲染結果的鏡頭（index＝在專案裡的位置）。 */
  renderShots: readonly { shot: StudioShot; index: number; count: number }[];
  uploads: LibraryUploads;
  /** 參考素材合計大小（已格式化）。 */
  librarySize: string;
  /** 不列出的 Image Studio 遮罩數。 */
  masks: number;
  onKind: (id: LibraryKindFilter) => void;
  onUsage: (id: LibraryUsageFilter) => void;
  onTakes: () => void;
  onShot: (shotId: string) => void;
  onExports: () => void;
}

export function LibrarySidebar({ section, kind, usage, shotFilter, kindCount, usageCount, takeCount, exportCount, renderShots, uploads, librarySize, masks, onKind, onUsage, onTakes, onShot, onExports }: LibrarySidebarProps) {
  return (
    <aside aria-label={t("素材分類")} className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-line-subtle bg-canvas/40 p-3">
      <nav aria-label={t("參考素材")} className="grid gap-0.5">
        <h3 className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-tertiary">{t("參考素材")}</h3>
        {KIND_FILTERS.map((entry) => (
          <CategoryButton
            key={entry.id}
            group="category"
            active={section === "assets" && kind === entry.id}
            label={entry.label}
            icon={entry.icon}
            count={kindCount(entry.id)}
            onClick={() => { onKind(entry.id); }}
          />
        ))}
      </nav>
      <nav aria-label={t("使用狀態")} className={cn("grid gap-0.5 transition-opacity duration-(--duration-fast)", section !== "assets" && "opacity-60")}>
        <h3 className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-tertiary">{t("使用狀態")}</h3>
        {USAGE_FILTERS.map((entry) => (
          <CategoryButton
            key={entry.id}
            group="usage"
            active={section === "assets" && usage === entry.id}
            label={entry.label}
            icon={entry.icon}
            count={usageCount(entry.id)}
            onClick={() => { onUsage(entry.id); }}
          />
        ))}
      </nav>
      <nav aria-label={t("渲染成品")} className="grid gap-0.5">
        <h3 className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-tertiary">{t("渲染成品")}</h3>
        <CategoryButton group="category" active={section === "takes" && shotFilter === null} label={t("渲染結果")} icon={Clapperboard} count={takeCount} onClick={onTakes} />
        <AnimatePresence initial={false}>
          {section === "takes" && renderShots.length > 0 ? (
            <motion.div
              key="shots"
              role="group"
              aria-label={t("依鏡頭篩選")}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={motionTransition("base", "standard")}
              className="ml-3 grid grid-cols-1 gap-0.5 overflow-hidden border-l border-line-subtle pl-1.5"
            >
              {renderShots.map(({ shot, index, count }) => (
                <ShotFilterButton key={shot.shot_id} active={shotFilter === shot.shot_id} index={index} title={shot.title} count={count} onClick={() => { onShot(shot.shot_id); }} />
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <CategoryButton group="category" active={section === "exports"} label={t("匯出成片")} icon={ListVideo} count={exportCount} onClick={onExports} />
      </nav>
      {uploads.tasks.length > 0 ? (
        <section aria-label={t("上傳")} className="grid gap-1">
          <h3 className="px-2.5 text-[11px] font-semibold tracking-wide text-fg-tertiary">{t("上傳")}</h3>
          <ul className="grid gap-0.5 rounded-lg border border-line-subtle bg-canvas/60 p-1" aria-live="polite">
            {uploads.tasks.map((task) => (
              <ReferenceUploadRow key={task.key} task={task} onRetry={() => { uploads.retry(task.key); }} onDismiss={() => { uploads.dismiss(task.key); }} />
            ))}
          </ul>
        </section>
      ) : null}
      <div className="mt-auto grid gap-1 border-t border-line-subtle px-1 pt-3 text-caption text-fg-tertiary">
        <p>{t("參考素材合計 {size}", { size: librarySize })}</p>
        {masks > 0 ? <p className="text-[11px] leading-4">{t("另有 {masks} 個 Image Studio 遮罩，只在 Image Studio 使用，這裡不列出。", { masks })}</p> : null}
      </div>
    </aside>
  );
}
