import { isNonzeroNumber } from "@/lib/json";
// The work section (summary.cost): what this load or invoke actually computed, per stage, as the duration estimator fits
// it (not a prediction), with the call's generic facts. A recording without it says why instead of showing zeros.
import { Sigma } from "lucide-react";
import { useMemo } from "react";
import type { Recording } from "@/api/generated/contracts";
import { Badge } from "@/components/ui/badge";
import { KeyValueList } from "@/components/ui/kv";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { formatMs } from "@/lib/format";
import { costAbsence, costStageRows, formatWork, loadavgText, warmText } from "../model/cost";
import { formatSettingValue } from "../model/settings";
import { IdText } from "./Feedback";
import { t } from "@/i18n";

function Missing() {
  return <span className="text-fg-tertiary">{t("未記錄")}</span>;
}

export function CostSection({ recording }: { recording: Recording }) {
  const id = recording.context.recording_id;
  const cost = recording.summary.cost;
  const rows = useMemo(() => (cost ? costStageRows(cost) : []), [cost]);
  const absence = costAbsence(recording);

  return (
    <section aria-labelledby={`${id}-cost`} className="grid gap-3">
      <h3 id={`${id}-cost`} className="flex items-center gap-2 text-section font-semibold text-fg">
        <Sigma aria-hidden className="size-4 text-fg-tertiary" />
        {t("運算量（cost）")}
      </h3>
      <p className="text-caption text-fg-tertiary">{t("這次實際做了多少運算（各 stage 的運算量與運算時間），給耗時估計器擬合用；不是預測。")}</p>
      {!cost ? (
        <p className="rounded-md border border-line-subtle bg-sunken px-3 py-3 text-data text-fg-secondary">{t("未記錄：{reason}", { reason: absence ?? "" })}</p>
      ) : (
        <>
          <KeyValueList
            items={[
              { key: "warm", label: "warm", value: warmText(cost.warm) },
              { key: "loadavg", label: t("loadavg（1 分鐘，開始 → 結束）"), value: loadavgText(cost.loadavg), mono: true },
              { key: "device", label: "device_id", value: cost.device_id ?? <Missing />, mono: cost.device_id !== null },
              { key: "revision", label: "source_revision", value: cost.source_revision ?? <Missing />, mono: cost.source_revision !== null },
              { key: "digest", label: "load_digest", value: (cost.load_digest != null && cost.load_digest !== "") ? <IdText value={cost.load_digest} length={12} /> : <Missing /> },
            ]}
          />
          {rows.length === 0 ? (
            <p className="text-data text-fg-secondary">{t("沒有 stage 紀錄：provider 沒有回報這次各 stage 的運算量。")}</p>
          ) : (
            <TableScroll label={t("各 stage 的運算量")}>
              <Table>
                <thead>
                  <tr>
                    <Th scope="col">stage</Th>
                    <Th scope="col">{t("運算量（work · work_unit）")}</Th>
                    <Th scope="col">compute_ms</Th>
                    <Th scope="col">shape</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <Tr key={`${String(index)}-${row.stage}`}>
                      <Td className="machine text-fg">{row.stage}</Td>
                      <Td className="machine whitespace-nowrap">
                        <span className="text-fg" title={`${row.work.toLocaleString("en-US")} ${row.unit}`}>
                          {formatWork(row.work)}
                        </span>{" "}
                        <span className="text-fg-tertiary">{row.unit}</span>
                      </Td>
                      <Td className="machine whitespace-nowrap">{row.computeMs === null ? <span className="text-warning">{formatMs(null)}</span> : formatMs(row.computeMs)}</Td>
                      <Td className="min-w-[12rem]">
                        <ul className="grid gap-0.5 text-caption">
                          {row.shape.map(([key, value]) => (
                            <li key={key} className="machine text-fg-secondary">
                              {key}=<span className="text-fg">{formatSettingValue(value)}</span>
                            </li>
                          ))}
                          {row.risk ? (
                            <li className="flex flex-wrap items-center gap-1.5">
                              <span className="machine text-fg-secondary">
                                risk_measure=<span className="text-fg">{formatSettingValue(row.risk.measure)}</span>
                                {row.risk.unit !== null ? ` ${formatSettingValue(row.risk.unit)}` : ""}
                              </span>
                              <Badge tone="neutral" title={t("risk_measure／risk_unit：隨記憶體用量增長的量，只和其他紀錄比較來預警 OOM；不是運算量。")}>
                                {t("OOM 預警用的量")}
                              </Badge>
                            </li>
                          ) : null}
                          {row.shape.length === 0 && !row.risk ? <li className="text-fg-tertiary">—</li> : null}
                        </ul>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
          {isNonzeroNumber(cost.dropped_stages) ? (
            <p className="text-caption text-warning">{t("另有 {dropped_stages} 個 stage 沒有記錄（每筆紀錄最多保留 64 個 stage）。", { dropped_stages: cost.dropped_stages })}</p>
          ) : null}
        </>
      )}
    </section>
  );
}
