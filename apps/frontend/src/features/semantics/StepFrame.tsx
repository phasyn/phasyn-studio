// 語意頁步驟的共用片段：檢視器骨架（物件標頭＋屬性區段＋固定底部主要動作）、建立 run 的錯誤、run 區段。
import type { UseQueryResult } from "@tanstack/react-query";
import { ListVideo } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { WireRun } from "@/api/types";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { SchemaDensityContext } from "@/components/common/schemaDensity";
import { TimeText } from "@/components/common/values";
import { DockBody } from "@/components/workbench/DockPanel";
import { InspectorFooter, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { hasErrorCode } from "@/lib/errors";
import { RunStatusLine } from "@/features/runs";
import { PATHS } from "@/app/paths";
import { t } from "@/i18n";

/** 檢視器裡的一個步驟：四個步驟都保持掛載，只顯示目前這一步（隱藏的步驟不在無障礙樹中）。 */
export function StepPane({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div hidden={!active} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {children}
    </div>
  );
}

/** 步驟檢視器：標頭固定、屬性區段捲動（schema 表單用精簡屬性格）、主要動作固定在底部。 */
export function StepInspector({ header, children, actions, note }: { header: ReactNode; children: ReactNode; actions: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {header}
      <DockBody>
        <SchemaDensityContext.Provider value="compact">{children}</SchemaDensityContext.Provider>
      </DockBody>
      <InspectorFooter note={note}>
        <div className="grid w-full gap-2">{actions}</div>
      </InspectorFooter>
    </div>
  );
}

/** 建立 run 失敗：RUN_ACTIVE（409）明確說「這次沒有送出」並連到執行紀錄；連線中斷顯示遠端結果未知。不自動重送。 */
export function RunCreateError({ error, title }: { error: unknown; title: string }) {
  const active = hasErrorCode(error, "RUN_ACTIVE");
  return (
    <ErrorCallout error={error} write title={active ? t("已有 run 正在執行：這次沒有送出") : title}>
      {active ? (
        <Link to={PATHS.runs} className="text-data">
          {t("查看執行中的 run")}
        </Link>
      ) : null}
    </ErrorCallout>
  );
}

/** 某一步的 run：狀態、耗時、失敗步驟的完整錯誤、明細連結（輪詢由 useRun 負責）。 */
export function RunSection({
  title,
  runId,
  run,
  label,
  emptyText,
  errorTitle,
}: {
  title: string;
  runId: string | null;
  run: UseQueryResult<WireRun>;
  label: string;
  emptyText: string;
  errorTitle: string;
}) {
  return (
    <PropertySection title={title} icon={<ListVideo aria-hidden />}>
      {!runId ? (
        <p className="text-data text-fg-tertiary">{emptyText}</p>
      ) : run.data ? (
        <div className="grid gap-2">
          <RunStatusLine run={run.data} label={label} />
          <PropertyGrid>
            <PropertyRow label={t("建立")}>
              <TimeText iso={run.data.created_at} />
            </PropertyRow>
            <PropertyRow label={t("結束")}>{run.data.finished_at ? <TimeText iso={run.data.finished_at} /> : <span className="text-fg-tertiary">{t("尚未結束")}</span>}</PropertyRow>
          </PropertyGrid>
        </div>
      ) : run.isError ? (
        <ErrorCallout error={run.error} title={errorTitle} onRetry={() => void run.refetch()} retrying={run.isFetching} />
      ) : (
        <p role="status" className="text-data text-fg-secondary">
          {t("讀取 run…")}
        </p>
      )}
    </PropertySection>
  );
}
