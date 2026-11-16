import { Plus, Workflow } from "lucide-react";
import { Link } from "react-router";
import type { Catalog } from "@/api/generated/contracts";
import type { WirePipeline } from "@/api/types";
import { inferencePath, PATHS } from "@/app/paths";
import { EmptyState } from "@/components/common/EmptyState";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/variants";
import { catalogUnknownText, readiness, requiredComponents, type CatalogStatus } from "../model/components";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import { t } from "@/i18n";

/** 尚未選擇元件組合時的中欄：已保存的元件組合（輸入型別、步驟數、需要的元件是否就緒；目錄未讀到時是狀態未知）。 */
export function PipelinePicker({ pipelines, catalog, catalogStatus }: { pipelines: readonly WirePipeline[]; catalog: Catalog | undefined; catalogStatus: CatalogStatus }) {
  const unknownText = catalogUnknownText(catalogStatus);
  if (pipelines.length === 0) {
    return (
      <EmptyState
        illustration="frames"
        icon={<Workflow />}
        title={t("還沒有已保存的元件組合")}
        description={t("元件組合（pipeline）定義步驟與接線；保存後就能在這裡上傳輸入並執行。")}
        action={
          <Link to={PATHS.newPipeline} className={buttonVariants({ variant: "primary" })}>
            <Plus aria-hidden />
            {t("在「元件修改」建立元件組合")}
          </Link>
        }
      />
    );
  }
  return (
    <TableScroll label={t("已保存的元件組合")} className="relative">
      <Table className="min-w-[44rem]">
        <thead>
          <tr>
            <Th scope="col">{t("元件組合")}</Th>
            <Th scope="col">{t("輸入")}</Th>
            <Th scope="col">{t("步驟")}</Th>
            <Th scope="col" className="min-w-40">
              {t("需要的元件")}
            </Th>
          </tr>
        </thead>
        <tbody>
          {pipelines.map((pipeline) => {
            const summary = readiness(requiredComponents(pipeline, catalog));
            return (
              <Tr key={pipeline.pipeline_id}>
                <Td>
                  <Link to={inferencePath({ pipeline: pipeline.pipeline_id })} className="group grid min-w-0 gap-0.5 rounded-sm no-underline outline-none focus-visible:ring-2 focus-visible:ring-focus">
                    <span className="truncate font-medium text-fg group-hover:text-action-fg group-hover:underline">{pipeline.label || pipeline.pipeline_id}</span>
                    <code className="machine text-caption text-fg-tertiary">{pipeline.pipeline_id}</code>
                  </Link>
                </Td>
                <Td>
                  {pipeline.inputs.length === 0 ? (
                    <span className="text-caption text-fg-tertiary">{t("沒有輸入")}</span>
                  ) : (
                    <ul className="grid gap-0.5">
                      {pipeline.inputs.map((port) => (
                        <li key={port.name} className="flex flex-wrap items-baseline gap-1.5 text-caption">
                          <code className="machine text-fg-secondary">{port.name}</code>
                          <code className="machine rounded-full border border-file/25 bg-file/10 px-1.5 whitespace-nowrap text-file">{port.type_id}</code>
                          {port.required ? null : <span className="text-fg-tertiary">{t("（選填）")}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Td>
                <Td className="machine text-fg-secondary">{pipeline.steps.length}</Td>
                <Td>
                  {unknownText ? (
                    <span className="text-caption text-fg-tertiary">{t("{total} 個・{unknownText}{value}", { total: summary.total, unknownText, value: catalogStatus === "loading" ? "…" : "" })}</span>
                  ) : (
                    <div className="grid min-w-36 gap-1">
                      <span className="machine text-caption text-fg-secondary">{t("就緒 {ready}／{total}", { ready: summary.ready, total: summary.total })}</span>
                      <ProgressTrack value={summary.ready} max={Math.max(1, summary.total)} tone={summary.ready === summary.total ? "done" : "idle"} label={t("需要的元件就緒數")} valueText={t("就緒 {ready}／{total}", { ready: summary.ready, total: summary.total })} size="sm" />
                      {summary.unavailable > 0 ? <span className="block text-caption text-warning">{t("{unavailable} 個無法使用", { unavailable: summary.unavailable })}</span> : null}
                      {summary.startable > 0 ? <span className="block text-caption text-fg-tertiary">{t("{startable} 個需要啟動", { startable: summary.startable })}</span> : null}
                    </div>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroll>
  );
}
