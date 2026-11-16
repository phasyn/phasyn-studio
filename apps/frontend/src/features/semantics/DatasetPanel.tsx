// 步驟 4：訓練資料集（dataset.export）。中欄＝資料列（影片 FileRef＋caption、來源群組、split）；
// 檢視器＝匯出結果、匯出元件與參數，底部是「匯出資料集」。split 依來源群組，可逐列指定；空 split 或樣本少只警告。
import { Cpu, Database, PackageCheck, Plus, SlidersHorizontal, Trash, TriangleAlert } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useFileJson } from "@/api/files";
import type { CaptionPair } from "@/api/generated/contracts";
import { useRun } from "@/api/runs";
import type { WireRun } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { FileLinks } from "@/components/common/FileRefView";
import { ParametersEditor } from "@/components/common/ParametersEditor";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Select, Textarea } from "@/components/ui/controls";
import { Table, Td, Th } from "@/components/ui/table";
import { EntityHeader, PropertySection } from "@/components/workbench/Inspector";
import { formatBytes } from "@/lib/format";
import { uniqueName } from "@/lib/ids";
import { FileRefPicker, KindComponentSelect } from "@/features/pipelines";
import { RunStatusLine } from "@/features/runs";
import { datasetWarnings, findRunValue, manifestSplitSummary, type DatasetRow, type SplitChoice } from "./sceneModel";
import { RunCreateError, StepInspector } from "./StepFrame";
import type { DatasetStepState } from "./useSemanticsSteps";
import { t } from "@/i18n";

const SPLITS: Array<{ value: SplitChoice; label: string }> = [
  { value: "auto", label: t("自動（依來源群組）") },
  { value: "train", label: "train" },
  { value: "validation", label: "validation" },
  { value: "test", label: "test" },
];

/** 表頭固定在步驟內容區頂端（內容區是唯一 scroll owner）；border-collapse 的格線改用 inset 陰影。 */
const HEAD_CELL = "sticky top-0 z-[1] shadow-[inset_0_-1px_0_var(--color-line)]";

function ExportResult({ runId }: { runId: string }) {
  const run = useRun(runId);
  const archive = findRunValue(run.data, "dataset.archive.v1");
  const manifest = findRunValue(run.data, "dataset.manifest.v1");
  const manifestFile = manifest && "file" in manifest ? manifest.file : null;
  const manifestJson = useFileJson(manifestFile);
  const summary = manifestSplitSummary(manifest && "value" in manifest ? manifest.value : manifestJson.data);
  if (!run.data) {
    return run.isError ? (
      <ErrorCallout error={run.error} title={t("無法讀取匯出 run")} onRetry={() => void run.refetch()} retrying={run.isFetching} />
    ) : (
      <p role="status" className="text-caption text-fg-tertiary">
        {t("讀取匯出 run…")}
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      <RunStatusLine run={run.data} label="dataset.export" />
      {archive && "file" in archive ? (
        <div className="grid gap-2 text-data text-fg-secondary">
          <span className="machine">{t("資料集封包 {media_type} · {size_bytes}", { media_type: archive.file.media_type, size_bytes: formatBytes(archive.file.size_bytes) })}</span>
          <FileLinks file={archive.file} downloadLabel="dataset" />
        </div>
      ) : run.data.state === "succeeded" ? (
        <p className="text-caption text-warning">{t("run 成功但沒有 dataset.archive.v1 輸出。")}</p>
      ) : null}
      {summary ? (
        <div className="grid gap-1">
          <p className="machine text-data text-fg-secondary">{t("共 {total} 筆 · train {train} · validation {validation} · test {test}", { total: summary.total, train: summary.counts.train, validation: summary.counts.validation, test: summary.counts.test })}</p>
          {summary.warnings.length > 0 ? (
            <Callout tone="warning" title={t("split 警告（不阻擋使用）")}>
              <ul className="grid gap-0.5">
                {summary.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
        </div>
      ) : manifestFile && manifestJson.isError ? (
        <ErrorCallout error={manifestJson.error} title={t("無法讀取 manifest")} onRetry={() => void manifestJson.refetch()} retrying={manifestJson.isFetching} />
      ) : null}
    </div>
  );
}

/** 中欄：資料列。來源是目前 caption 的影片與 training caption，或從近期 run 挑影片後手動填 caption。 */
export function DatasetWorkspace({ rows, onRowsChange, currentPair }: { rows: DatasetRow[]; onRowsChange: (next: DatasetRow[]) => void; currentPair: CaptionPair | null }) {
  const warnings = datasetWarnings(rows);
  const taken = new Set(rows.map((row) => row.sample_id));
  const addPair = () => {
    if (!currentPair) return;
    onRowsChange([
      ...rows,
      {
        key: crypto.randomUUID(),
        sample_id: uniqueName(`clip-${currentPair.source.file_id.slice(0, 8)}`, taken),
        source: currentPair.source,
        caption: currentPair.training_caption,
        source_group: currentPair.source.sha256.slice(0, 16),
        split: "auto",
      },
    ]);
  };
  const update = (index: number, patch: Partial<DatasetRow>) => onRowsChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));

  return (
    <div className="grid content-start">
      <div className="flex flex-wrap items-end gap-3 border-b border-line-subtle px-4 py-3">
        <ActionButton size="sm" icon={<Plus aria-hidden />} disabledReason={currentPair ? null : t("先產生 caption")} onClick={addPair}>
          {t("加入目前影片與 training caption")}
        </ActionButton>
        <div className="min-w-64 flex-1">
          <FileRefPicker
            id="dataset-add-video"
            typeId="media.video.v1"
            onPick={(value) =>
              onRowsChange([
                ...rows,
                {
                  key: crypto.randomUUID(),
                  sample_id: uniqueName(`clip-${value.file.file_id.slice(0, 8)}`, taken),
                  source: value.file,
                  caption: "",
                  source_group: value.file.sha256.slice(0, 16),
                  split: "auto",
                },
              ])
            }
          />
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-4">
        {rows.length === 0 ? (
          <EmptyState icon={<Database />} size="compact" title={t("還沒有資料列")} description={t("產生 caption 後可加入；也可從近期 run 挑影片後手動填 caption。")} />
        ) : (
          <Table className="min-w-[56rem]" aria-label={t("資料集列")}>
            <thead>
              <tr>
                <Th scope="col" className={HEAD_CELL}>
                  sample_id
                </Th>
                <Th scope="col" className={HEAD_CELL}>
                  {t("影片")}
                </Th>
                <Th scope="col" className={HEAD_CELL}>
                  {t("caption（training）")}
                </Th>
                <Th scope="col" className={HEAD_CELL}>
                  {t("來源群組")}
                </Th>
                <Th scope="col" className={HEAD_CELL}>
                  split
                </Th>
                <Th scope="col" className={HEAD_CELL}>
                  <span className="sr-only">{t("操作")}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.key}>
                  <Td className="w-40">
                    <Input compact aria-label={t("第 {index} 列 sample_id", { index: index + 1 })} className="machine" value={row.sample_id} onChange={(event) => update(index, { sample_id: event.target.value })} />
                  </Td>
                  <Td className="w-40">
                    <code className="machine text-caption text-fg-secondary">{row.source.file_id.slice(0, 8)}</code>
                    <span className="block text-caption text-fg-tertiary">
                      {row.source.media_type} · {formatBytes(row.source.size_bytes)}
                    </span>
                  </Td>
                  <Td>
                    <Textarea
                      compact
                      aria-label={t("第 {index} 列 caption", { index: index + 1 })}
                      rows={2}
                      value={row.caption}
                      aria-invalid={!row.caption.trim() || undefined}
                      onChange={(event) => update(index, { caption: event.target.value })}
                    />
                  </Td>
                  <Td className="w-40">
                    <Input compact aria-label={t("第 {index} 列來源群組", { index: index + 1 })} className="machine" value={row.source_group} onChange={(event) => update(index, { source_group: event.target.value })} />
                  </Td>
                  <Td className="w-44">
                    <Select compact aria-label={t("第 {index} 列 split", { index: index + 1 })} value={row.split} onChange={(event) => update(index, { split: event.target.value as SplitChoice })}>
                      {SPLITS.map((split) => (
                        <option key={split.value} value={split.value}>
                          {split.label}
                        </option>
                      ))}
                    </Select>
                  </Td>
                  <Td>
                    <Button size="icon-sm" variant="danger" aria-label={t("刪除第 {index} 列", { index: index + 1 })} title={t("刪除第 {index} 列", { index: index + 1 })} onClick={() => onRowsChange(rows.filter((_, position) => position !== index))}>
                      <Trash aria-hidden />
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="text-caption text-fg-tertiary">{t("同一來源影片的片段請放在同一來源群組（預設為來源 SHA 前綴），避免相鄰片段跨 train／validation 洩漏。資料列只存在這個頁面，離開前會確認。")}</p>
        {warnings.length > 0 ? (
          <Callout tone="warning" icon={<TriangleAlert />} title={t("提醒（不阻擋匯出）")}>
            <ul className="grid gap-0.5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
      </div>
    </div>
  );
}

/** 檢視器：匯出結果（封包下載、split 統計）、匯出元件與參數；底部「匯出資料集」。 */
export function DatasetInspector({
  step,
  rowCount,
  exportRunId,
  exportRun,
}: {
  step: DatasetStepState;
  rowCount: number;
  exportRunId: string | null;
  exportRun: UseQueryResult<WireRun>;
}) {
  return (
    <StepInspector
      header={
        <EntityHeader
          icon={Database}
          tone="file"
          title={t("訓練資料集（dataset.export）")}
          status={exportRun.data ? <StatusBadge kind="run" value={exportRun.data.state} /> : null}
          description={t("{rowCount} 列；split 依來源群組，可逐列指定。", { rowCount })}
          id={exportRunId}
        />
      }
      note={t("匯出包會實際包含影片檔（外部 FileRef 先物化），不是只寫路徑。")}
      actions={
        <>
          {step.uploadError ? <ErrorCallout error={step.uploadError} write title={t("上傳資料列失敗")} /> : null}
          {step.create.isError ? <RunCreateError error={step.create.error} title={t("建立匯出 run 失敗")} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              variant="primary"
              size="sm"
              icon={<Database aria-hidden />}
              pending={step.pending}
              disabledReason={step.pending ? null : step.blockReason}
              onClick={() => void step.submit()}
            >
              {t("匯出資料集")}
            </ActionButton>
          </div>
        </>
      }
    >
      <PropertySection title={t("匯出結果")} icon={<PackageCheck aria-hidden />}>
        {exportRunId ? <ExportResult runId={exportRunId} /> : <p className="text-data text-fg-tertiary">{t("尚未匯出。")}</p>}
      </PropertySection>
      <PropertySection title={t("匯出元件")} icon={<Cpu aria-hidden />}>
        <KindComponentSelect id="dataset-export-component" label={t("匯出元件（dataset.export）")} kind="dataset.export" value={step.choice} onChange={(value) => step.setChoice(value)} />
      </PropertySection>
      {step.descriptor ? (
        <PropertySection title={t("匯出參數")} icon={<SlidersHorizontal aria-hidden />}>
          <ParametersEditor
            schema={step.schema}
            value={step.parameters}
            onChange={step.setParameters}
            idPrefix="dataset-export-params"
            issues={step.issues}
            label={t("匯出參數（split 策略、明確指定等，依元件 schema）")}
          />
        </PropertySection>
      ) : null}
    </StepInspector>
  );
}
