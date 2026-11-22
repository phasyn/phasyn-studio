import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { SettingsView } from "@/api/generated/contracts";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { JsonView } from "@/components/common/JsonView";
import { SyntheticBadge } from "@/components/common/SyntheticNotice";
import { IdText, TimeText } from "@/components/common/values";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/controls";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { flattenLeaves } from "@/lib/diff";
import { isRecord, previewValue, valuesEqual } from "@/lib/json";
import { observedPrecision, PRECISION_FIELDS } from "./settingsModel";
import { useLatestInvokeRecording } from "./useLatestInvokeRecording";
import { tServer, t } from "@/i18n";
import { T } from "@/i18n/T";

const MISSING = Symbol("missing");

function Cell({ value, emphasize }: { value: unknown; emphasize?: boolean }) {
  if (value === MISSING) return <span className="text-fg-tertiary">—</span>;
  return <span className={(emphasize === true) ? "machine text-warning" : "machine text-fg-secondary"}>{previewValue(value, 60)}</span>;
}

function lookup(source: unknown, path: string): unknown {
  if (source === MISSING) return MISSING;
  const segments = path.split(".");
  let current: unknown = source;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return MISSING;
    current = current[segment];
  }
  return current;
}

/**
 * 已保存／目前載入／這次呼叫：三欄對照，不把 stored 值標成已使用。
 * 精度欄位另列 requested／effective（provider 宣告）／observed（runtime 回報），不把宣告當硬體量測。
 */
export function CompareTab({ view, nodeId, componentId }: { view: SettingsView; nodeId: string; componentId: string }) {
  const latest = useLatestInvokeRecording(nodeId, componentId);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const recording = latest.data ?? null;
  const context = recording?.context ?? null;
  const effective: unknown = context?.settings?.effective ?? MISSING;
  const requested: unknown = context?.settings?.requested ?? MISSING;
  const observed: unknown = context?.settings?.observed ?? null;
  const loaded: unknown = view.loaded ? { load: view.loaded } : MISSING;

  const paths = new Set<string>();
  for (const source of [view.stored, view.loaded ? { load: view.loaded } : null, effective === MISSING ? null : effective]) {
    if (source != null) for (const key of flattenLeaves(source).keys()) if (key) paths.add(key);
  }
  const rows = [...paths]
    .sort()
    .map((path) => {
      const stored = lookup(view.stored, path);
      const loadedValue = path.startsWith("load.") ? lookup(loaded, path) : MISSING;
      const call = lookup(effective, path);
      const differs =
        (loadedValue !== MISSING && !valuesEqual(stored, loadedValue)) || (call !== MISSING && stored !== MISSING && !valuesEqual(stored, call));
      return { path, stored, loadedValue, call, differs };
    })
    .filter((row) => !onlyDiff || row.differs);

  return (
    <div className="grid min-w-0 gap-5">
      <section className="grid gap-2" aria-label={t("資料來源")}>
        <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-data">
          <dt className="text-fg-tertiary">{t("已保存")}</dt>
          <dd className="m-0 machine text-fg-secondary">revision #{view.stored_revision}</dd>
          <dt className="text-fg-tertiary">{t("目前載入")}</dt>
          <dd className="m-0 text-fg-secondary">
            {view.loaded_revision === null ? t("未載入（loaded=null）") : <span className="machine">revision #{view.loaded_revision}</span>}
            {view.restart_required ? (
              <Badge tone="warning" className="ml-2">
                {t("已保存的 load 與目前載入不同，需 restart")}
              </Badge>
            ) : null}
          </dd>
          <dt className="text-fg-tertiary">{t("這次呼叫")}</dt>
          <dd className="m-0 min-w-0 text-fg-secondary">
            {latest.isPending ? (
              t("讀取最近一次 invoke 紀錄…")
            ) : latest.isError ? (
              t("無法讀取紀錄")
            ) : recording && context ? (
              <span className="flex flex-wrap items-center gap-2">
                <T source={"最近 invoke：{link}<0/>{value2}{value3}"} values={{ link: <Link to={`/records/recordings/${encodeURIComponent(context.recording_id)}`} className="inline-flex items-center gap-1">
                  recording <IdText value={context.recording_id} copy={false} />
                  <ExternalLink aria-hidden className="size-3.5" />
                </Link>, value2: context.settings ? (
                  <span className="machine text-caption text-fg-tertiary">
                    stored #{context.settings.stored_revision} · loaded {context.settings.loaded_revision === null ? "—" : `#${String(context.settings.loaded_revision)}`}
                  </span>
                ) : null, value3: context.synthetic ? <SyntheticBadge /> : null }} slots={[<TimeText key="slot-0" iso={context.created_at} />]} />
              </span>
            ) : (
              t("此 instance 還沒有 invoke 紀錄")
            )}
          </dd>
        </dl>
        {latest.isError ? <ErrorCallout error={latest.error} title={t("無法讀取最近的 invoke 紀錄")} onRetry={() => void latest.refetch()} /> : null}
        {recording && !context?.settings ? (
          <Callout tone="info" title={t("這次呼叫的設定快照不可得")}>
            <p>{t("recording 的 context.settings 為 null（可能尚未收到 context）；不以已保存值代替。")}</p>
          </Callout>
        ) : null}
      </section>

      <section className="grid gap-2" aria-labelledby="precision-compare-title">
        <h3 id="precision-compare-title" className="text-data font-semibold text-fg">
          {t("精度：requested／effective／observed")}
        </h3>
        <p className="text-caption text-fg-tertiary">
          {t("effective＝provider 宣告（不是硬體量測）；observed＝runtime 回報的實際值，缺值顯示「未觀測」，不以 effective 代替。")}
        </p>
        <TableScroll label={t("精度對照")}>
          <Table className="min-w-[44rem]">
            <thead>
              <tr>
                <Th scope="col">{t("欄位")}</Th>
                <Th scope="col">{t("已保存")}</Th>
                <Th scope="col">{t("目前載入")}</Th>
                <Th scope="col">{t("這次 requested")}</Th>
                <Th scope="col">{t("這次 effective（宣告）")}</Th>
                <Th scope="col">{t("observed（runtime 回報）")}</Th>
              </tr>
            </thead>
            <tbody>
              {PRECISION_FIELDS.map((field) => {
                const path = `load.precision.${field.key}`;
                const stored = lookup(view.stored, path);
                const loadedValue = lookup(loaded, path);
                const req = lookup(requested, path);
                const eff = lookup(effective, path);
                const obs = observedPrecision(observed, field.key);
                return (
                  <Tr key={field.key}>
                    <Td>
                      <code className="machine text-fg">{field.key}</code>
                      <span className="block text-caption text-fg-tertiary">{field.label}</span>
                    </Td>
                    <Td>
                      <Cell value={stored} />
                    </Td>
                    <Td>
                      <Cell value={loadedValue} emphasize={loadedValue !== MISSING && stored !== MISSING && !valuesEqual(stored, loadedValue)} />
                    </Td>
                    <Td>
                      <Cell value={req} />
                    </Td>
                    <Td>
                      <Cell value={eff} emphasize={eff !== MISSING && req !== MISSING && !valuesEqual(req, eff)} />
                    </Td>
                    <Td>
                      {!context ? (
                        <span className="text-fg-tertiary">—</span>
                      ) : obs.present && obs.value !== null ? (
                        <span className="machine text-fg">{previewValue(obs.value, 40)}</span>
                      ) : (
                        <span className="text-caption text-warning">
                          {t("未觀測{value}", { value: (obs.reason != null && obs.reason !== "") ? t("：{reason}", { reason: tServer(obs.reason) }) : t("（runtime 未回報）") })}
                        </span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      </section>

      <section className="grid gap-2" aria-labelledby="settings-compare-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="settings-compare-title" className="text-data font-semibold text-fg">
            {t("全部設定：已保存／目前載入／這次呼叫（effective）")}
          </h3>
          <Checkbox id="compare-only-diff" label={t("只顯示有差異的欄位")} checked={onlyDiff} onChange={(event) => { setOnlyDiff(event.target.checked); }} />
        </div>
        {rows.length === 0 ? (
          <p className="text-data text-fg-tertiary">{onlyDiff ? t("三欄之間沒有差異。") : t("沒有設定欄位。")}</p>
        ) : (
          <TableScroll label={t("設定三欄對照")}>
            <Table className="min-w-[40rem]">
              <thead>
                <tr>
                  <Th scope="col">{t("欄位")}</Th>
                  <Th scope="col">{t("已保存")}</Th>
                  <Th scope="col">{t("目前載入")}</Th>
                  <Th scope="col">{t("這次呼叫")}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Tr key={row.path}>
                    <Td className="machine text-fg">{row.path}</Td>
                    <Td>
                      <Cell value={row.stored} />
                    </Td>
                    <Td>
                      {row.path.startsWith("load.") ? (
                        <Cell value={row.loadedValue} emphasize={row.loadedValue !== MISSING && !valuesEqual(row.stored, row.loadedValue)} />
                      ) : (
                        <span className="text-caption text-fg-tertiary">{t("不適用（下次呼叫採用）")}</span>
                      )}
                    </Td>
                    <Td>
                      <Cell value={row.call} emphasize={row.call !== MISSING && row.stored !== MISSING && !valuesEqual(row.stored, row.call)} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </section>

      {context?.settings ? (
        <section className="grid gap-3" aria-label={t("這次呼叫的展開與身分")}>
          {Object.keys(context.settings.expanded_parts).length > 0 ? (
            <JsonView value={context.settings.expanded_parts} label={t("expanded_parts（這次呼叫保存的子部件展開）")} maxHeightClass="max-h-56" />
          ) : null}
          <JsonView value={context.settings.model_identity} label="model_identity" maxHeightClass="max-h-40" />
          <JsonView value={context.settings.runtime_identity} label="runtime_identity" maxHeightClass="max-h-40" />
          <p className="machine text-caption text-fg-tertiary">config_digest {context.settings.config_digest || "—"}</p>
        </section>
      ) : null}
    </div>
  );
}
