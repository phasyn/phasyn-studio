// 「從其他專案加入…」的左欄：其他專案的清單（名稱、素材數、更新時間），一個 listbox（焦點在清單上，↑↓ 換專案）。
import { FolderKanban, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import type { KeyboardEvent, RefObject } from "react";
import type { StudioProjectSummary } from "@/api/generated/contracts";
import { reveal, motionTransition } from "@/components/ui/motion";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatTimestamp } from "@/lib/format";
import { rowId } from "./libraryImport";
import type { LibrarySource } from "./useLibrarySources";
import { t } from "@/i18n";

const SKELETON_ROWS = 5;

/** 左欄的專案清單：一個 listbox（焦點在清單上，↑↓ 換專案）；選到的專案有滑動的品牌底。 */
export function ProjectList({
  baseId,
  listRef,
  loading,
  projects,
  sources,
  selectedId,
  onChoose,
  onKeyDown,
}: {
  baseId: string;
  listRef: RefObject<HTMLDivElement | null>;
  loading: boolean;
  projects: readonly StudioProjectSummary[];
  sources: ReadonlyMap<string, LibrarySource>;
  selectedId: string | null;
  onChoose: (projectId: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const activeShown = selectedId !== null && projects.some((summary) => summary.project_id === selectedId);
  return (
    // layoutScroll: the sliding mark measures rows inside a list that scrolls
    <motion.div
      ref={listRef}
      layoutScroll
      role="listbox"
      tabIndex={0}
      aria-label={t("其他專案")}
      aria-busy={loading || undefined}
      aria-activedescendant={activeShown ? rowId(baseId, selectedId) : undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "group/projects grid min-h-0 flex-1 auto-rows-max content-start gap-0.5 overflow-y-auto p-2",
        // The focused row carries the ring; with no row shown (a search hid it) the list does
        activeShown ? "outline-none" : "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
      )}
    >
      {loading ? (
        // Decoration only: the items area next to it says 讀取專案列表… once (role="status")
        Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <span key={index} aria-hidden className="flex min-h-12 items-center gap-2.5 px-2.5">
            <Skeleton className="size-8 shrink-0" />
            <span className="grid flex-1 gap-1.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </span>
          </span>
        ))
      ) : projects.length === 0 ? (
        <p className="px-2.5 py-3 text-caption text-fg-tertiary animate-fade-in">{t("沒有符合的專案")}</p>
      ) : (
        projects.map((summary, index) => {
          const active = summary.project_id === selectedId;
          const name = summary.title || t("未命名專案");
          return (
            <div /* eslint-disable-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/interactive-supports-focus -- The owning composite keeps keyboard focus and exposes the active option with aria-activedescendant. */
              key={summary.project_id}
              ref={reveal(index)}
              id={rowId(baseId, summary.project_id)}
              role="option"
              aria-selected={active}
              title={name}
              onClick={() => { onChoose(summary.project_id); }}
              className={cn(
                "relative flex min-h-12 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 select-none",
                active ? "text-fg" : "text-fg-secondary hover:bg-raised/70 hover:text-fg active:bg-sunken",
                "group-focus-visible/projects:aria-selected:outline-2 group-focus-visible/projects:aria-selected:-outline-offset-2 group-focus-visible/projects:aria-selected:outline-focus",
              )}
            >
              {active ? (
                <motion.span
                  layoutId={`${baseId}-project-mark`}
                  aria-hidden
                  transition={motionTransition("spring-snappy", "spring-snappy")}
                  className="absolute inset-0 rounded-lg border border-brand-blue/40 bg-brand-gradient-soft"
                />
              ) : null}
              <span aria-hidden className={cn("relative grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4", active ? "bg-brand-gradient text-on-accent shadow-glow-sm" : "bg-entity/12 text-entity")}>
                <FolderKanban />
              </span>
              <span className="relative grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-data">{name}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-caption text-fg-tertiary">
                  <SourceCount source={sources.get(summary.project_id)} />
                  <span aria-hidden>·</span>
                  <span className="machine truncate">{t("更新於 {time}", { time: formatTimestamp(summary.updated_at) })}</span>
                </span>
              </span>
            </div>
          );
        })
      )}
    </motion.div>
  );
}

/** 專案列上的素材數：讀取中是骨架，讀不到時說明（原因在提示），讀到後淡入數字。 */
function SourceCount({ source }: { source: LibrarySource | undefined }) {
  if (!source || source.pending) {
    return (
      <>
        <Skeleton className="h-3 w-12 shrink-0" />
        <span className="sr-only">{t("讀取中…")}</span>
      </>
    );
  }
  if (source.error != null) {
    return (
      <span title={errorText(source.error)} className="inline-flex shrink-0 items-center gap-1 text-warning animate-fade-in">
        <TriangleAlert aria-hidden className="size-3" />
        {t("讀不到")}
      </span>
    );
  }
  const count = source.items?.length ?? 0;
  return <span className="machine shrink-0 animate-fade-in">{count === 0 ? t("沒有素材") : t("{count} 個素材", { count })}</span>;
}
