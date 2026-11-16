import { Archive, ListFilter, ListVideo } from "lucide-react";
import type { RunState } from "@/api/types";
import { statusSpec } from "@/components/common/statusSpec";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Outliner } from "@/components/workbench/Outliner";
import { DOT_TONE, TEXT_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { reveal } from "@/components/ui/motion";

const STATES: readonly RunState[] = ["running", "succeeded", "failed", "cancelled", "interrupted"];

/** 大綱列：按下時輕壓（pressable），焦點框內縮；狀態色只在圖示與計數點上。 */
const ROW =
  "pressable relative flex h-9 w-full items-center gap-2.5 rounded-md pr-2 pl-3 text-left text-data transition-[color,background-color] duration-(--duration-fast) outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset";
/** 目前的篩選：品牌淡漸層底＋左側直向漸層標記（與資源樹的目前項目一致）。 */
const ACTIVE_ROW =
  "bg-brand-gradient-soft text-fg before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-linear-to-b before:from-brand-cyan before:via-brand-blue before:to-brand-violet";
const IDLE_ROW = "text-fg-secondary hover:bg-raised/60 hover:text-fg active:bg-sunken active:duration-0";

export interface RunStateFilterProps {
  counts: Readonly<Partial<Record<RunState, number>>>;
  total: number;
  selected: string;
  onSelect: (state: string) => void;
  /** 還有未載入的分頁：計數只涵蓋已載入的 run。 */
  partial: boolean;
  /** 正在看已封存的 run（狀態計數改為已封存清單內的計數）。 */
  archivedView: boolean;
  onArchivedView: (archived: boolean) => void;
}

interface StateRow {
  value: string;
  label: string;
  count: number;
  tone: keyof typeof DOT_TONE;
  icon: typeof ListVideo;
}

/** "All" first, then one row per run state, counted over the loaded runs. */
function stateRows(counts: RunStateFilterProps["counts"], total: number, archivedView: boolean): StateRow[] {
  return [
    { value: "", label: archivedView ? t("全部已封存") : t("全部 run"), count: total, tone: "action", icon: ListVideo },
    ...STATES.map((state) => {
      const spec = statusSpec("run", state);
      return { value: state, label: spec.label, count: counts[state] ?? 0, tone: spec.tone, icon: spec.icon };
    }),
  ];
}

/** 左下「狀態」大綱（Bridge 的 Job Queues）：依 run 狀態分組計數，點選即篩選（只計算已載入的 run）。 */
export function RunStateOutliner({ counts, total, selected, onSelect, partial, archivedView, onArchivedView }: RunStateFilterProps) {
  const rows = stateRows(counts, total, archivedView);
  return (
    <Outliner title={t("依狀態")} icon={<ListFilter aria-hidden />}>
      <ul aria-label={t("依狀態篩選 run")} className="grid gap-0.5 p-1.5">
        {rows.map((row, index) => {
          const active = row.value === selected;
          return (
            <li key={row.value || "all"} className="" ref={reveal(index)}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelect(row.value)}
                className={cn(ROW, active ? ACTIVE_ROW : IDLE_ROW)}
              >
                <row.icon aria-hidden className={cn("size-4 shrink-0", TEXT_TONE[row.tone])} />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span
                  className={cn(
                    "machine inline-flex min-w-6 shrink-0 items-center justify-center gap-1 rounded-full px-1.5 text-caption",
                    active ? "bg-surface/70 text-fg" : "bg-raised text-fg-secondary",
                  )}
                >
                  {row.value ? <span aria-hidden className={cn("size-1.5 rounded-full", DOT_TONE[row.tone])} /> : null}
                  {row.count}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line-subtle p-1.5">
        <button
          type="button"
          aria-pressed={archivedView}
          onClick={() => onArchivedView(!archivedView)}
          className={cn(ROW, archivedView ? ACTIVE_ROW : IDLE_ROW)}
          title={archivedView ? t("回到未封存的 run") : t("查看已封存的 run（檔案與紀錄都保留，可取消封存）")}
        >
          <Archive aria-hidden className="size-4 shrink-0 text-fg-tertiary" />
          <span className="min-w-0 flex-1 truncate">{archivedView ? t("已封存（返回一般清單）") : t("已封存")}</span>
        </button>
      </div>
      {partial ? <p className="px-3 pb-3 text-caption text-fg-tertiary">{t("只計算已載入的 run；載入更多後計數會更新。")}</p> : null}
    </Outliner>
  );
}

/**
 * The same filter in the page's tool strip, for when the outline is not on screen (the left column is collapsed, which is
 * the default below 1280 px): a state picker with the counts and the archived toggle.
 */
export function RunStateFilterBar({ counts, total, selected, onSelect, partial, archivedView, onArchivedView }: RunStateFilterProps) {
  const rows = stateRows(counts, total, archivedView);
  return (
    <div className="flex items-center gap-1.5">
      <Select
        compact
        aria-label={t("依狀態篩選 run")}
        title={partial ? t("只計算已載入的 run；載入更多後計數會更新。") : undefined}
        value={selected}
        onChange={(event) => onSelect(event.target.value)}
        className="w-44"
      >
        {rows.map((row) => (
          <option key={row.value || "all"} value={row.value}>
            {t("{label}（{count}）", { label: row.label, count: row.count })}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        variant={archivedView ? "secondary" : "quiet"}
        icon={<Archive aria-hidden />}
        aria-pressed={archivedView}
        onClick={() => onArchivedView(!archivedView)}
        title={archivedView ? t("回到未封存的 run") : t("查看已封存的 run（檔案與紀錄都保留，可取消封存）")}
      >
        {archivedView ? t("已封存（返回一般清單）") : t("已封存")}
      </Button>
    </div>
  );
}
